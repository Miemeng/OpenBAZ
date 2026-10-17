// YAML 读取层的单元 / 端到端测试（`npm test`）

// 分三层：
//  - 纯逻辑：`parseYamlDocument`（语法错的行列号）、DTO 结构与语义校验（`cards/schema.ts`）；
//  - 宿主层：`loadPacks` 读**真实的教学模板目录**（`tutorial/templates/packs`）做端到端验收；
//  - 注册表：`CardRegistry` 的取用 / 版本选择 / 加载回显。

// 本文件是测试（宿主层），允许碰 `node:*`；`cards/` 纯逻辑白名单（eslint.config.js）不含本文件。
import { describe, expect, it } from 'vitest'
import { loadPacks, PACKS_ROOT } from './loader.ts'
import { parseDeckText, resolveDeck, validateDeck, type DeckDto } from './deck.ts'
import { mapCard, mapSkill } from './map.ts'
import { CardRegistry } from './registry.ts'
import {
  cardDtoSchema,
  checkDto,
  engineRangeSatisfied,
  heroDtoSchema,
  issuesToErrors,
  packManifestDtoSchema,
  parseYamlDocument,
  skillDtoSchema,
  validateCard,
  validateHero,
  validatePackManifest,
  validateSkill,
} from './schema.ts'
import type { CardDto, PackManifestDto, SkillDto, ValidationContext } from './schema.ts'
import type { ValidationError } from './types.ts'
import type { SourcePosition } from './yaml-positions.ts'

function errorsOf(issues: readonly ValidationError[]): readonly ValidationError[] {
  return issues.filter((issue) => (issue.severity ?? 'error') === 'error')
}

function contextOf(text: string, file: string): ValidationContext {
  const doc = parseYamlDocument(text, file)
  return { file, positions: doc.positions }
}

const CARD_YAML = `id: c1
name: 试验卡
version: 1
size: small
cooldown: 1.50
rarity: bronze
stats:
  atk: 10
abilities:
  - id: 1
    kind: active
    actions:
      - do: deal_damage
        target: enemy_player
        amount: self.atk
`

/** 解析一份卡牌 YAML 并断言结构通过。 */
function parseCard(text: string): { readonly dto: CardDto; readonly ctx: ValidationContext } {
  const ctx = contextOf(text, 'c1.yml')
  const parsed = cardDtoSchema.safeParse(parseYamlDocument(text, 'c1.yml').value)
  expect(parsed.success).toBe(true)
  if (!parsed.success) throw new Error('测试夹具结构不合法')
  return { dto: parsed.data, ctx }
}

/** 解析一份技能 YAML 并断言结构通过。 */
function parseSkill(text: string): { readonly dto: SkillDto; readonly ctx: ValidationContext } {
  const ctx = contextOf(text, 's1.yml')
  const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
  expect(parsed.success).toBe(true)
  if (!parsed.success) throw new Error('测试夹具结构不合法')
  return { dto: parsed.data, ctx }
}

/** 用仓库真实数据根建一份注册表（阵容校验要查"这张卡有没有这个附魔"） */
function liveRegistry(): CardRegistry {
  const registry = new CardRegistry()
  registry.replaceAll(loadPacks(PACKS_ROOT).packs)
  return registry
}

/** 解析一份阵容 YAML 并断言结构通过（`ParsedDeck.dto` 是可选的，这里收窄成必有） */
function deckOf(text: string): DeckDto {
  const parsed = parseDeckText(text, 'd.yml')
  if (parsed.dto === undefined) throw new Error('测试夹具：阵容结构不合法')
  return parsed.dto
}

describe('parseYamlDocument', () => {
  it('语法错给出 yaml.syntax 与 1 起算的行列号', () => {
    const doc = parseYamlDocument('id: [unclosed\n', 'broken.yml')
    expect(doc.syntaxError?.code).toBe('yaml.syntax')
    expect(doc.syntaxError?.file).toBe('broken.yml')
    expect(doc.syntaxError?.line).toBeGreaterThanOrEqual(1)
    expect(doc.syntaxError?.column).toBeGreaterThanOrEqual(1)
  })

  it('正常文档给出 path → 位置表', () => {
    const doc = parseYamlDocument('id: c1\nname: 试验卡\nstats:\n  atk: 10\n', 'c1.yml')
    expect(doc.value).toEqual({ id: 'c1', name: '试验卡', stats: { atk: 10 } })
    expect(doc.positions.get('id')?.line).toBe(1)
    expect(doc.positions.get('name')?.line).toBe(2)
    expect(doc.positions.get('stats.atk')?.line).toBe(4)
  })
})

describe('cardDtoSchema（结构层）', () => {
  it('未知字段被拒绝，并给出字段名', () => {
    const text = `${CARD_YAML}bogus: 1\n`
    const ctx = contextOf(text, 'c1.yml')
    const parsed = cardDtoSchema.safeParse(parseYamlDocument(text, 'c1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(issues.some((issue) => issue.message.includes('bogus'))).toBe(true)
    expect(issues.every((issue) => issue.code === 'schema.invalid')).toBe(true)
    expect(issues[0]?.file).toBe('c1.yml')
  })

  it('id 形状：允许驼峰与蛇形，但禁数字开头 / 连字符', () => {
    const bad = CARD_YAML.replace('id: c1', 'id: C-1')
    const badIssues = checkDto(cardDtoSchema, parseYamlDocument(bad, 'c1.yml').value, contextOf(bad, 'c1.yml'))
    expect(badIssues.length).toBeGreaterThan(0)

    const camel = CARD_YAML.replace('id: c1', 'id: myCard')
    const camelIssues = checkDto(cardDtoSchema, parseYamlDocument(camel, 'c1.yml').value, contextOf(camel, 'c1.yml'))
    expect(camelIssues).toEqual([])
  })

  it('已废除字段 baseAction / activeAction ⇒ 错误，并提示替代写法', () => {
    const text = `${CARD_YAML}baseAction:\n  - do: deal_damage\n`
    const ctx = contextOf(text, 'c1.yml')
    const parsed = cardDtoSchema.safeParse(parseYamlDocument(text, 'c1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(issues.some((issue) => issue.message.includes('baseAction'))).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('已废除') ?? false)).toBe(true)
  })
})

describe('validateCard（语义层）', () => {
  it('id 与文件名不一致 ⇒ pack.manifest 错误', () => {
    const { dto, ctx } = parseCard(CARD_YAML)
    const issues = validateCard(dto, ctx, { fileName: 'other_card' })
    const mismatch = issues.find((issue) => issue.code === 'pack.manifest')
    expect(mismatch?.path).toBe('id')
    expect(errorsOf(issues).length).toBe(1)
  })

  it('裸 self.<stat> 写错属性名也会被抓到', () => {
    const { dto, ctx } = parseCard(CARD_YAML.replace('self.atk', 'self.aatk'))
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.some((issue) => issue.message.includes('引用未知属性：self.aatk'))).toBe(true)
  })

  it('效果数额写成字面量只 warn、不阻断', () => {
    const { dto, ctx } = parseCard(CARD_YAML.replace('amount: self.atk', 'amount: 5'))
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.find((issue) => issue.message.includes('字面量'))?.severity).toBe('warn')
    expect(errorsOf(issues)).toEqual([])
  })

  it('主动能力不得写 trigger / priority', () => {
    const text = CARD_YAML.replace('    kind: active\n', '    kind: active\n    trigger: { event: battle_start }\n')
    const { dto, ctx } = parseCard(text)
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.some((issue) => issue.path?.includes('trigger'))).toBe(true)
  })

  it('光环：命中玩家时只接受 burn / poison / regen 的 apply，且一律禁 mul', () => {
    const text = `${CARD_YAML}aura:
  select: all_players
  apply:
    - { stat: shield, amount: 5 }
  mul:
    - { stat: atk, factor: 1.50 }
`
    const { dto, ctx } = parseCard(text)
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.some((issue) => issue.message.includes('只能用 burn / poison / regen'))).toBe(true)
    expect(issues.some((issue) => issue.message.includes('一律禁止 mul'))).toBe(true)
  })

  it('光环：apply 通道禁用 speed', () => {
    const text = `${CARD_YAML}aura:
  select: all_own_cards
  apply:
    - { stat: speed, amount: 1 }
`
    const { dto, ctx } = parseCard(text)
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.some((issue) => issue.message.includes('apply 通道禁用 stat：speed'))).toBe(true)
  })

  it('未注册品阶 ⇒ 错误（只在给出 registeredRarities 时校验）', () => {
    const { dto, ctx } = parseCard(CARD_YAML)
    const issues = validateCard(dto, ctx, {
      fileName: 'c1',
      registeredRarities: ['silver', 'gold', 'diamond'],
    })
    expect(issues.some((issue) => issue.message.includes('未注册的品阶：bronze'))).toBe(true)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1', registeredRarities: ['bronze'] }))).toEqual([])
  })

  it('自定义品阶：已登记但**不在合成链上**也能被卡牌引用', () => {
    const text = CARD_YAML.replace('rarity: bronze', 'rarity: mythic')
    const { dto, ctx } = parseCard(text)
    // 只给链（不含 mythic）⇒ 注册校验**不看链**，故不该报"未注册的品阶"
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1', rarityChain: ['bronze', 'silver', 'gold', 'diamond'] }))).toEqual([])
    // 已登记集合里没有它 ⇒ 照旧报错
    const missing = validateCard(dto, ctx, { fileName: 'c1', registeredRarities: ['bronze'] })
    expect(missing.some((issue) => issue.message.includes('未注册的品阶：mythic'))).toBe(true)
  })

  it('inheritOverride 分段齐全（本卡品阶的下一阶起、每阶一段）⇒ 零错误零警告', () => {
    const text = `${CARD_YAML}inheritOverride:
  - rarity: silver
    stats: { atk: 20 }
  - rarity: gold
    stats: { atk: 40 }
  - rarity: diamond
    stats: { atk: 80 }
`
    const { dto, ctx } = parseCard(text)
    const issues = validateCard(dto, ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    expect(issues).toEqual([])
  })

  it('inheritOverride 漏段 ⇒ 只报 warn「漏写」，该阶按最低品阶写法继承', () => {
    const text = `${CARD_YAML}inheritOverride:
  - rarity: silver
    stats: { atk: 20 }
  - rarity: gold
    stats: { atk: 40 }
`
    const { dto, ctx } = parseCard(text)
    const issues = validateCard(dto, ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    const missing = issues.find((issue) => issue.message.includes('漏写 1 个品阶段：diamond'))
    expect(missing?.severity).toBe('warn')
    expect(missing?.path).toBe('inheritOverride')
    expect(errorsOf(issues)).toEqual([])
  })

  it('inheritOverride 品阶段重复 ⇒ 错误；本卡已是最高品阶还给段 ⇒ 只 warn「无需分段」', () => {
    const duplicate = `${CARD_YAML}inheritOverride:
  - rarity: silver
    stats: { atk: 20 }
  - rarity: silver
    stats: { atk: 30 }
  - rarity: gold
    stats: { atk: 40 }
  - rarity: diamond
    stats: { atk: 80 }
`
    const parsed = parseCard(duplicate)
    const issues = validateCard(parsed.dto, parsed.ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    expect(issues.some((issue) => issue.message.includes('品阶段重复：silver'))).toBe(true)

    const topTier = parseCard(CARD_YAML.replace('rarity: bronze', 'rarity: diamond') + `inheritOverride:
  - rarity: gold
    stats: { atk: 40 }
`)
    const topIssues = validateCard(topTier.dto, topTier.ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    const redundant = topIssues.find((issue) => issue.message.includes('已是链上最高阶，无需分段'))
    expect(redundant?.severity).toBe('warn')
    expect(errorsOf(topIssues)).toEqual([])
  })

  it('inheritOverride 写了本卡品阶之前的段 / 链外品阶 ⇒ error', () => {
    // 黄金卡却写了白银段（层次写反）
    const reversed = parseCard(CARD_YAML.replace('rarity: bronze', 'rarity: gold') + `inheritOverride:
  - rarity: silver
    stats: { atk: 20 }
  - rarity: diamond
    stats: { atk: 40 }
`)
    const reversedIssues = validateCard(reversed.dto, reversed.ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    const before = reversedIssues.find((issue) => issue.message.includes('写在本卡品阶「gold」之前'))
    expect(before?.severity).toBe('error')
    expect(errorsOf(reversedIssues).length).toBeGreaterThan(0)

    // 链外品阶（不在 rarityChain 上）
    const offChain = parseCard(`${CARD_YAML}inheritOverride:
  - rarity: mythic
    stats: { atk: 20 }
`)
    const offChainIssues = validateCard(offChain.dto, offChain.ctx, {
      fileName: 'c1',
      rarityChain: ['bronze', 'silver', 'gold', 'diamond'],
    })
    const off = offChainIssues.find((issue) => issue.message.includes('不在合成链上'))
    expect(off?.severity).toBe('error')
  })

  it('stats 里的未知属性键只 warn（防拼错属性名，不拦注册）', () => {
    const { dto, ctx } = parseCard(CARD_YAML.replace('  atk: 10\n', '  atk: 10\n  aatk: 1\n'))
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.find((issue) => issue.message.includes('未知属性键：aatk'))?.severity).toBe('warn')
    expect(errorsOf(issues)).toEqual([])
  })

  it('引用未定义的属性 ⇒ 错误；speed / cdp 有非 0 缺省值、不算未定义', () => {
    const missing = parseCard(CARD_YAML.replace('amount: self.atk', 'amount: self.shield'))
    const missingIssues = validateCard(missing.dto, missing.ctx, { fileName: 'c1' })
    expect(missingIssues.some((issue) => issue.message.includes('引用未定义的属性：self.shield'))).toBe(true)

    const implicit = parseCard(CARD_YAML.replace('amount: self.atk', 'amount: self.speed'))
    const implicitIssues = validateCard(implicit.dto, implicit.ctx, { fileName: 'c1' })
    expect(implicitIssues.some((issue) => issue.message.includes('引用未定义的属性'))).toBe(false)
    expect(errorsOf(implicitIssues)).toEqual([])
  })

  it('卡面 stats 认 burn / poison / regen（与玩家侧同名，不再是未知键）', () => {
    const { dto, ctx } = parseCard(CARD_YAML.replace('  atk: 10\n', '  atk: 10\n  burn: 3\n'))
    const issues = validateCard(dto, ctx, { fileName: 'c1' })
    expect(issues.find((issue) => issue.message.includes('未知属性键'))).toBeUndefined()
    expect(errorsOf(issues)).toEqual([])
  })

  it('duration 只在「gain_stat + 玩家目标 + DOT 数值位」的通道里允许', () => {
    const card = (target: string): string => `id: c1
name: 试验卡
version: 1
size: small
cooldown: 1.50
rarity: bronze
stats:
  atk: 10
abilities:
  - id: 1
    kind: active
    actions:
      - do: gain_stat
        target: ${target}
        stat: burn
        amount: 2
        duration: 3
`
    const onCard = parseCard(card('random_enemy_card'))
    const cardIssues = validateCard(onCard.dto, onCard.ctx, { fileName: 'c1' })
    expect(cardIssues.some((issue) => issue.message.includes('duration 仅在 gain_stat + 玩家'))).toBe(true)

    const onPlayer = parseCard(card('own_player'))
    const playerIssues = validateCard(onPlayer.dto, onPlayer.ctx, { fileName: 'c1' })
    expect(playerIssues.some((issue) => issue.message.includes('duration 仅在 gain_stat + 玩家'))).toBe(false)
    expect(errorsOf(playerIssues)).toEqual([])
  })

  it('光环 factor 的两位小数校验有容差：1.1 合法，1.234 报 warn', () => {
    const aura = (factor: string): string => `${CARD_YAML}aura:
  select: all_own_cards
  mul:
    - { stat: atk, factor: ${factor} }
`
    const fine = parseCard(aura('1.1'))
    const fineIssues = validateCard(fine.dto, fine.ctx, { fileName: 'c1' })
    expect(fineIssues.some((issue) => issue.message.includes('两位小数'))).toBe(false)

    const coarse = parseCard(aura('1.234'))
    const coarseIssues = validateCard(coarse.dto, coarse.ctx, { fileName: 'c1' })
    expect(coarseIssues.find((issue) => issue.message.includes('两位小数'))?.severity).toBe('warn')
  })

  it('卡牌自写 owner 与所属包不一致 ⇒ 一条 note（以卡牌为准）', () => {
    const { dto, ctx } = parseCard(CARD_YAML.replace('rarity: bronze\n', 'rarity: bronze\nowner: hero_a\n'))

    const mismatch = validateCard(dto, ctx, { fileName: 'c1', packOwner: 'common' })
    expect(mismatch.find((issue) => issue.message.includes('不一致'))?.severity).toBe('note')
    expect(errorsOf(mismatch)).toEqual([])

    const same = validateCard(dto, ctx, { fileName: 'c1', packOwner: 'hero_a' })
    expect(same.some((issue) => issue.message.includes('不一致'))).toBe(false)

    const noPackOwner = validateCard(dto, ctx, { fileName: 'c1' })
    expect(noPackOwner.some((issue) => issue.message.includes('不一致'))).toBe(false)
  })

  it('原语 × 目标类型：只能打玩家的原语选到卡牌 ⇒ 错误', () => {
    const withTarget = (text: string, target: string): string => text.replace('target: enemy_player', `target: ${target}`)

    // deal_damage 打卡牌 = 写错（卡牌没有血量）⇒ error
    const damageOnCard = parseCard(withTarget(CARD_YAML, 'random_enemy_card'))
    expect(
      errorsOf(validateCard(damageOnCard.dto, damageOnCard.ctx, { fileName: 'c1' })).some((issue) =>
        issue.message.includes('deal_damage 不能作用于卡牌'),
      ),
    ).toBe(true)

    // shield 只能作用于玩家 ⇒ 选到卡牌 = error
    const shieldOnCard = parseCard(withTarget(CARD_YAML.replace('do: deal_damage', 'do: shield'), 'random_enemy_card'))
    expect(
      errorsOf(validateCard(shieldOnCard.dto, shieldOnCard.ctx, { fileName: 'c1' })).some((issue) =>
        issue.message.includes('shield 不能作用于卡牌'),
      ),
    ).toBe(true)

    // apply_status 只能作用于卡牌 ⇒ 选到玩家 = error
    const statusOnPlayer = parseCard(
      CARD_YAML.replace('do: deal_damage', 'do: apply_status').replace('amount: self.atk', 'status: freeze'),
    )
    expect(
      errorsOf(validateCard(statusOnPlayer.dto, statusOnPlayer.ctx, { fileName: 'c1' })).some((issue) =>
        issue.message.includes('apply_status 不能作用于玩家'),
      ),
    ).toBe(true)

    // deal_damage 打玩家（= 夹具默认写法）= 正确写法，无抱怨
    const damageOnPlayer = parseCard(CARD_YAML)
    expect(errorsOf(validateCard(damageOnPlayer.dto, damageOnPlayer.ctx, { fileName: 'c1' }))).toEqual([])
  })

  it('原语 × 目标类型：gain_stat 的 DOT / 非 DOT 按目标类型双向判', () => {
    const withTarget = (text: string, target: string): string => text.replace('target: enemy_player', `target: ${target}`)

    const gainDotOnCard = parseCard(
      withTarget(
        CARD_YAML.replace('do: deal_damage', 'do: gain_stat').replace('amount: self.atk', 'stat: burn\n        amount: 2'),
        'random_enemy_card',
      ),
    )
    expect(
      errorsOf(validateCard(gainDotOnCard.dto, gainDotOnCard.ctx, { fileName: 'c1' })).some((issue) =>
        issue.message.includes('不能把持续效果'),
      ),
    ).toBe(true)

    const gainAtkOnPlayer = parseCard(
      withTarget(
        CARD_YAML.replace('do: deal_damage', 'do: gain_stat').replace('amount: self.atk', 'stat: atk\n        amount: 2'),
        'own_player',
      ),
    )
    expect(
      errorsOf(validateCard(gainAtkOnPlayer.dto, gainAtkOnPlayer.ctx, { fileName: 'c1' })).some((issue) =>
        issue.message.includes('不是持续效果'),
      ),
    ).toBe(true)

    // 合法组合：gain_stat + 玩家 + burn（DOT 层数字面量只 warn、不阻断）
    const gainBurnOnPlayer = parseCard(
      CARD_YAML.replace('do: deal_damage', 'do: gain_stat').replace('amount: self.atk', 'stat: burn\n        amount: 2'),
    )
    expect(errorsOf(validateCard(gainBurnOnPlayer.dto, gainBurnOnPlayer.ctx, { fileName: 'c1' }))).toEqual([])
  })
})

describe('validatePackManifest', () => {
  const ctx: ValidationContext = { file: 'pack.yml', positions: new Map<string, SourcePosition>() }
  const base: PackManifestDto = { id: 'p', name: 'P', version: 1, engineRange: [{ from: '0.0.0' }] }

  it('既无 cards 也无 skills ⇒ 错误', () => {
    const issues = validatePackManifest(base, ctx)
    expect(errorsOf(issues).some((issue) => issue.message.includes('至少声明 cards 或 skills'))).toBe(true)
  })

  it('cards 与 skills 写在同一份 pack.yml ⇒ 合法、零 note', () => {
    const issues = validatePackManifest({ ...base, owner: 'common', cards: ['a'], skills: ['b'] }, ctx)
    expect(issues.some((issue) => issue.message.includes('作废'))).toBe(false)
    expect(issues.some((issue) => issue.severity === 'note')).toBe(false)
    expect(errorsOf(issues)).toEqual([])
  })

  it('清单元素必须是裸文件名；**驼峰 id 合法**', () => {
    const issues = validatePackManifest({ ...base, cards: ['a.yml'] }, ctx)
    const issue = issues.find((item) => item.message.includes('裸文件名'))
    expect(issue?.path).toBe('cards[0]')
    expect(issue?.suggestion).toBe('改写成 a')

    const camel = validatePackManifest({ ...base, cards: ['myCard'], skills: ['mySkill'] }, ctx)
    expect(errorsOf(camel)).toEqual([])
  })

  it('engineRange 的边界必须是三段版本；只写 skills 且写 owner ⇒ 提示', () => {
    const badRange = validatePackManifest({ ...base, cards: ['a'], engineRange: [{ from: '0.10' }] }, ctx)
    expect(badRange.some((issue) => issue.message.includes('必须是三段版本 major.minor.patch'))).toBe(true)

    const skillOnlyPack = validatePackManifest({ ...base, skills: ['s'], owner: 'common' }, ctx)
    expect(skillOnlyPack.some((issue) => issue.message.includes('技能包不写 owner'))).toBe(true)
  })

  it('engineRange 区间语义：缺省左闭右开、可显式闭合、可省略单侧', () => {
    // 半开 [0.10.0, 0.20.0)：0.10.0 含、0.20.0 不含
    const halfOpen = [{ from: '0.10.0', to: '0.20.0' }]
    expect(engineRangeSatisfied(halfOpen, '0.10.0')).toBe(true)
    expect(engineRangeSatisfied(halfOpen, '0.15.0')).toBe(true)
    expect(engineRangeSatisfied(halfOpen, '0.20.0')).toBe(false)
    expect(engineRangeSatisfied(halfOpen, '0.9.9')).toBe(false)
    // 显式闭合 / 显式开下界
    expect(engineRangeSatisfied([{ from: '0.10.0', to: '0.20.0', toInclusive: true }], '0.20.0')).toBe(true)
    expect(engineRangeSatisfied([{ from: '0.10.0', fromInclusive: false }], '0.10.0')).toBe(false)
    // 省略单侧 = 无界；空列表 = 都不满足
    expect(engineRangeSatisfied([{ from: '0.10.0' }], '9.9.9')).toBe(true)
    expect(engineRangeSatisfied([{ to: '0.10.0' }], '0.9.9')).toBe(true)
    expect(engineRangeSatisfied([], '0.0.0')).toBe(false)
    // 多区间取"任一命中"
    expect(engineRangeSatisfied([{ from: '0.10.0', to: '0.20.0' }, { from: '0.30.0' }], '0.31.0')).toBe(true)
  })

  it('engineRange 区间为空 / from > to ⇒ 错误；引擎版本不在范围内 ⇒ 低版本拒绝导入', () => {
    const empty = validatePackManifest({ ...base, cards: ['a'], engineRange: [{ from: '0.0.0', to: '0.0.0' }] }, ctx)
    expect(empty.some((issue) => issue.message.includes('区间为空'))).toBe(true)

    const reversed = validatePackManifest(
      { ...base, cards: ['a'], engineRange: [{ from: '1.0.0', to: '0.1.0' }] },
      ctx,
    )
    expect(reversed.some((issue) => issue.message.includes('from 不能大于 to'))).toBe(true)

    // 引擎 0.0.0 不落在 [0.10.0, …) 内 ⇒ error
    const tooNew = validatePackManifest({ ...base, cards: ['a'], engineRange: [{ from: '0.10.0' }] }, ctx, {
      engineVersion: '0.0.0',
    })
    expect(tooNew.some((issue) => issue.message.includes('不含当前引擎版本'))).toBe(true)
    // 教学模板的写法（{ from: '0.0.0' }）在引擎 0.0.0 下通过
    expect(errorsOf(validatePackManifest({ ...base, cards: ['a'] }, ctx, { engineVersion: '0.0.0' }))).toEqual([])
  })

  it('packManifestDtoSchema 接受合法清单', () => {
    const parsed = packManifestDtoSchema.safeParse({
      id: 'p',
      name: 'P',
      version: 1,
      engineRange: [{ from: '0.0.0', to: '1.0.0' }],
      cards: ['a'],
    })
    expect(parsed.success).toBe(true)
  })

  it('engineRange 的版本号写成 YAML 数字（没加引号 / 没写全三段）⇒ 结构层拒绝，并提示写法', () => {
    const parsed = packManifestDtoSchema.safeParse({ ...base, cards: ['a'], engineRange: [{ from: 0.1 }] })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(errorsOf(issues).some((issue) => issue.suggestion?.includes('三段并加引号'))).toBe(true)

    // 两侧都省 = 空区间 ⇒ schema 层就拒（refine）
    expect(packManifestDtoSchema.safeParse({ ...base, cards: ['a'], engineRange: [{}] }).success).toBe(false)
  })
})

describe('validateSkill', () => {
  const SKILL_YAML = `id: s1
name: 试验技能
version: 1
rarity: bronze
heroes: [common]
stats:
  shield: 20
trigger: { event: battle_start }
actions:
  - do: shield
    target: own_player
    amount: self.shield
`

  it('技能已废除字段 icon ⇒ 错误，并提示改走 images/skills/<skill_id>.png', () => {
    const text = `${SKILL_YAML}icon: mySkill\n`
    const ctx = contextOf(text, 's1.yml')
    const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(issues.some((issue) => issue.message.includes('icon'))).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('images/skills/'))).toBe(true)
  })

  it('技能结构层拒绝卡牌专属字段（kind / cooldown）', () => {
    const text = `${SKILL_YAML}kind: active\n`
    const ctx = contextOf(text, 's1.yml')
    const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(issues.some((issue) => issue.message.includes('kind'))).toBe(true)
  })

  it('卡牌专属 / 已废除字段混写时，「已废除」的提示优先（unrecognized_keys 分支的优先级）', () => {
    const text = `${SKILL_YAML}cooldown: 5\nbaseAction: []\n`
    const ctx = contextOf(text, 's1.yml')
    const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    const suggestion = issues.find((issue) => issue.message.includes('baseAction'))?.suggestion ?? ''
    expect(suggestion).toContain('已废除')
    // 两类字段都被点名（message 里两个都在），只是建议栏优先讲"已废除"
    expect(issues.some((issue) => issue.message.includes('cooldown'))).toBe(true)
  })

  it('既无 actions 又无 aura ⇒ 错误；纯光环技能（无 actions）合法', () => {
    const noActions = parseSkill(SKILL_YAML.replace(/actions:\n(?: {2,}.*\n)+/, ''))
    const bare = validateSkill(noActions.dto, noActions.ctx)
    expect(errorsOf(bare).some((issue) => issue.message.includes('aura'))).toBe(true)

    const auraOnly = parseSkill(
      `${SKILL_YAML.replace(/actions:\n(?: {2,}.*\n)+/, '')}aura:\n  select: all_own_cards\n  apply:\n    - { stat: atk, amount: 2 }\n`,
    )
    expect(errorsOf(validateSkill(auraOnly.dto, auraOnly.ctx))).toEqual([])
  })

  it('引用了未注册英雄 id ⇒ 报错；common / sp 是保留字不算英雄', () => {
    const { dto, ctx } = parseSkill(SKILL_YAML)
    const unknown = validateSkill({ ...dto, heroes: ['nobody'] }, ctx, { knownHeroIds: new Set(['myHero']) })
    expect(unknown.some((issue) => issue.message.includes('nobody'))).toBe(true)
    const reserved = validateSkill({ ...dto, heroes: ['common', 'sp'] }, ctx, { knownHeroIds: new Set<string>() })
    expect(errorsOf(reserved)).toEqual([])
  })

  it('技能引用未在自己的 stats 里声明的属性 ⇒ 错误', () => {
    const noStats = parseSkill(SKILL_YAML.replace('stats:\n  shield: 20\n', ''))
    const issues = validateSkill(noStats.dto, noStats.ctx)
    expect(issues.some((issue) => issue.message.includes('引用未定义的属性：self.shield'))).toBe(true)
  })

  // ——— 技能品阶（`rarity`，**必填**；与卡牌同一张 rarities.yml） ———

  it('技能不写 rarity ⇒ **结构层拒绝**（必填，与卡牌同口径）', () => {
    const text = SKILL_YAML.replace('rarity: bronze\n', '')
    const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, contextOf(text, 's1.yml'))
    // ⚠️ **缺失必填字段**的键名在 `path` 里、**不在** `message` 里（zod 的类型错文案是英文的
    // "expected string, received undefined"）—— 与 id / name / version 等其它必填字段同形
    expect(issues.some((issue) => issue.path === 'rarity')).toBe(true)
  })

  it('技能品阶**已登记** ⇒ 放行，并映射进 Skill.rarity（自定义品阶同样可以）', () => {
    const custom = parseSkill(SKILL_YAML.replace('rarity: bronze', 'rarity: mythic'))
    expect(errorsOf(validateSkill(custom.dto, custom.ctx, { registeredRarities: ['bronze', 'mythic'] }))).toEqual([])
    expect(mapSkill(custom.dto).rarity).toBe('mythic')
    // 内置档同样映射（夹具默认 bronze）
    expect(mapSkill(parseSkill(SKILL_YAML).dto).rarity).toBe('bronze')
  })

  it('技能品阶**未登记** ⇒ 报错，并提示内置品阶与登记方式', () => {
    const { dto, ctx } = parseSkill(SKILL_YAML.replace('rarity: bronze', 'rarity: legendary'))
    const issues = validateSkill(dto, ctx, { registeredRarities: ['bronze', 'mythic'] })
    expect(issues.some((issue) => issue.message.includes('未注册的品阶：legendary'))).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('rarities.yml') ?? false)).toBe(true)
  })

  it('未传 registeredRarities ⇒ 不校验"是否已登记"（与卡牌同口径：只有包加载器才知道登记集合）', () => {
    const { dto, ctx } = parseSkill(SKILL_YAML.replace('rarity: bronze', 'rarity: legendary'))
    expect(errorsOf(validateSkill(dto, ctx))).toEqual([])
  })

  it('rarity 必须是非空字符串（结构层）', () => {
    const text = SKILL_YAML.replace('rarity: bronze', 'rarity: ""')
    const parsed = skillDtoSchema.safeParse(parseYamlDocument(text, 's1.yml').value)
    expect(parsed.success).toBe(false)
  })
})

describe('heroDtoSchema（结构层）', () => {
  it('角色已废除字段 tags ⇒ 结构化拒绝，并提示该字段已删除', () => {
    const text = `id: h1
name: 试验角色
version: 1
initHp: 300
tags: [tank]
`
    const ctx = contextOf(text, 'h1.yml')
    const parsed = heroDtoSchema.safeParse(parseYamlDocument(text, 'h1.yml').value)
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issues = issuesToErrors(parsed.error.issues, ctx)
    expect(issues.some((issue) => issue.message.includes('tags'))).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('角色没有 tags 字段'))).toBe(true)
  })

  it('角色字段名已全部驼峰：写旧的 init_hp ⇒ 结构层拒绝', () => {
    const text = `id: h1
name: 试验角色
version: 1
init_hp: 300
`
    const parsed = heroDtoSchema.safeParse(parseYamlDocument(text, 'h1.yml').value)
    expect(parsed.success).toBe(false)
  })

  it('角色字段名驼峰：initHp / initMaxHp / levelupMaxHp 全部通过', () => {
    const text = `id: h1
name: 试验角色
version: 1
initHp: 300
initMaxHp: 320
levelupMaxHp: [100, 200]
`
    const ctx = contextOf(text, 'h1.yml')
    const parsed = heroDtoSchema.safeParse(parseYamlDocument(text, 'h1.yml').value)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(validateHero(parsed.data, ctx)).toEqual([])
  })
})

describe('loadPacks（宿主层端到端）', () => {
  it('教学模板目录：一个包加载成功、零错误（技能已并入卡包，不再有独立技能包）', () => {
    const result = loadPacks('tutorial/templates/packs')
    expect(result.packs.map((pack) => pack.packId)).toEqual(['myPack'])
    expect(errorsOf(result.errors)).toEqual([])
  })

  it('卡包：清单点名的卡牌 / 技能 / 英雄都被读出，owner 已按包补齐', () => {
    const result = loadPacks('tutorial/templates/packs')
    const pack = result.packs.find((item) => item.packId === 'myPack')
    expect(pack?.version).toBe(1)
    expect(pack?.builtin).toBe(false)
    expect(pack?.owner).toBe('common')
    expect(pack?.cards.map((card) => card.id)).toEqual(['myCard'])
    expect(pack?.heroes.map((hero) => hero.id)).toEqual(['myHero'])
    expect(pack?.heroes[0]?.initHp).toBe(300)
    expect(pack?.heroes[0]?.initMaxHp).toBe(300)

    const card = pack?.cards[0]
    expect(card?.owner).toBe('common')
    expect(card?.cooldown).toBe(500)
    expect(card?.slots).toBe(1)
    expect(card?.stats.atk).toBe(10)
    expect(card?.abilities?.map((ability) => ability.id)).toEqual([1, 2])
    expect(card?.abilities?.[1]?.trigger?.event).toBe('on_player_damaged')
  })

  it('技能（已并入卡包）：skills 清单按裸文件名读取，actions 已映射为引擎契约', () => {
    const result = loadPacks('tutorial/templates/packs')
    const pack = result.packs.find((item) => item.packId === 'myPack')
    expect(pack?.skills.map((skill) => skill.id)).toEqual(['mySkill'])
    expect(pack?.skills[0]?.stats.shield).toBe(20)
    expect(pack?.skills[0]?.actions[0]?.do).toBe('shield')
    expect(pack?.skills[0]?.actions[0]?.target).toBe('own_player')
  })

  it('数据根不存在 ⇒ 一条 pack.manifest 错误、零包（不抛错）', () => {
    const result = loadPacks('no/such/packs-root')
    expect(result.packs).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]?.code).toBe('pack.manifest')
  })

  it(`仓库真实数据根（${PACKS_ROOT}/）可加载且没有致命错误`, () => {
    const result = loadPacks(PACKS_ROOT)
    expect(errorsOf(result.errors)).toEqual([])
  })

  it('真实数据根里的**技能品阶**已从 YAML 映射到 Skill.rarity（**必填**，含自定义品阶）', () => {
    const result = loadPacks(PACKS_ROOT)
    const skills = result.packs.flatMap((pack) => pack.skills)
    expect(skills.find((skill) => skill.id === 'warDrums')?.rarity).toBe('diamond')
    expect(skills.find((skill) => skill.id === 'secondWind')?.rarity).toBe('mythic')
    expect(skills.find((skill) => skill.id === 'echoBreak')?.rarity).toBe('bronze')
    // 必填 ⇒ 真实数据里每一条技能都带品阶
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.every((skill) => skill.rarity.length > 0)).toBe(true)
  })
})

describe('CardRegistry', () => {
  it('replaceAll 后可取卡牌 / 技能，回显按  形态', () => {
    const result = loadPacks('tutorial/templates/packs')
    const registry = new CardRegistry()
    registry.replaceAll(result.packs)

    expect(registry.get('myCard')?.name).toBe('我的卡牌')
    expect(registry.get('mySkill')).toBeUndefined()
    expect(registry.getSkill('mySkill')?.stats.shield).toBe(20)
    expect(registry.getAll().cards.length).toBe(1)
    expect(registry.getAll().skills.length).toBe(1)
    expect(registry.summary('myCard')[0]).toBe('已加载 我的卡牌 v1:')
    expect(registry.summary('mySkill')[0]).toBe('已加载 技能 我的技能 v1:')
    expect(registry.summary('nope')).toEqual(['未找到：nope'])
  })

  it('get 缺省取最新版本、指定版本取精确版本；replaceAll 清掉旧包', () => {
    const result = loadPacks('tutorial/templates/packs')
    const registry = new CardRegistry()
    registry.replaceAll(result.packs)
    const original = registry.get('myCard')
    expect(original).toBeDefined()
    if (original === undefined) return

    registry.registerCard({ ...original, version: 2, name: '试验卡 v2' })
    expect(registry.get('myCard')?.version).toBe(2)
    expect(registry.get('myCard', 1)?.name).toBe('我的卡牌')
    expect(registry.getAll().cards.length).toBe(2)

    const cardPack = result.packs.find((item) => item.packId === 'myPack')
    expect(cardPack).toBeDefined()
    if (cardPack === undefined) return
    // 技能已并入卡包 ⇒ 用该包 replaceAll 后技能**仍在**（这正是"合并"的语义）
    registry.replaceAll([cardPack])
    expect(registry.getSkill('mySkill')?.stats.shield).toBe(20)
    expect(registry.get('myCard')?.name).toBe('我的卡牌')
  })
})

// ————————————————————————————————————————————————————————
// 事件参数校验（`{ var: ... }`）
//
// 两条规则（《参数表设计.md》§5 / §7）：① 参数名必须是**当前事件**的参数（通用 + 专属）；
// ② 点号取属性**只能一层**、字段必须在封闭字段表内。
// 运行期同名错误会**抛错中止整局**（`engine/expr.ts` 的 `resolveVarValue`），故必须在校验期拦住。
// ————————————————————————————————————————————————————————

/** 造一张「单被动能力」的卡：时机词 / 条件 / 数额由调用方给，其余取最小合法值。 */
function passiveCardYaml(trigger: string, conditionLines: string, amountExpr: string): string {
  return `id: c1
name: 试验卡
version: 1
size: small
cooldown: -1
rarity: bronze
stats:
  atk: 10
abilities:
  - id: 1
    kind: passive
    trigger: { event: ${trigger} }
    condition:
${conditionLines}
    actions:
      - do: gain_stat
        stat: atk
        amount: ${amountExpr}
        target: self
`
}

describe('事件参数校验（{ var: ... }）', () => {
  it('参数名在事件参数表内 + 点号字段合法 ⇒ 零 error', () => {
    const yaml = passiveCardYaml(
      'on_card_destroyed',
      `      cmp: gte
      left: { var: slot_index }
      right: 0`,
      '{ var: card.atk }', // `card` 是 on_card_destroyed 的参数，且 atk 在 stats 词表内
    )
    const { dto, ctx } = parseCard(yaml)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))).toEqual([])
  })

  it('参数名不属于该事件 ⇒ error（提示里列出本事件可用参数）', () => {
    // `amount` 属于 on_player_damaged / on_player_healed，不属于 on_card_destroyed
    const yaml = passiveCardYaml(
      'on_card_destroyed',
      `      cmp: gte
      left: { var: amount }
      right: 0`,
      '{ var: card.atk }',
    )
    const { dto, ctx } = parseCard(yaml)
    const issues = errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))
    expect(issues.some((issue) => issue.message.includes('事件参数 amount 不存在'))).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('slot_index') === true)).toBe(true)
  })

  it('点号字段不合法 / 对非引用型参数取属性 ⇒ error', () => {
    const badField = passiveCardYaml(
      'on_player_damaged',
      `      cmp: gte
      left: { var: player.nope }
      right: 0`,
      '{ var: amount }',
    )
    const badFieldParsed = parseCard(badField)
    const badFieldIssues = errorsOf(validateCard(badFieldParsed.dto, badFieldParsed.ctx, { fileName: 'c1' }))
    expect(badFieldIssues.some((issue) => issue.message.includes('player.nope'))).toBe(true)

    // `amount` 是 number（不是 card_ref / player_ref），不能取属性
    const notRef = passiveCardYaml(
      'on_player_damaged',
      `      cmp: gte
      left: { var: amount.atk }
      right: 0`,
      '{ var: amount }',
    )
    const notRefParsed = parseCard(notRef)
    const notRefIssues = errorsOf(validateCard(notRefParsed.dto, notRefParsed.ctx, { fileName: 'c1' }))
    expect(notRefIssues.some((issue) => issue.message.includes('不是引用型'))).toBe(true)
  })

  it('主动能力的求值上下文不含 damage_dealt ⇒ 引用它报 error', () => {
    // CARD_YAML 的能力是 `kind: active` ⇒ 允许的参数 = after_action 去掉 damage_dealt
    const yaml = CARD_YAML.replace('amount: self.atk', 'amount: { var: damage_dealt }')
    const { dto, ctx } = parseCard(yaml)
    const issues = errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))
    expect(issues.some((issue) => issue.message.includes('事件参数 damage_dealt 不存在'))).toBe(true)
  })
})

describe('附魔 enchantments（边界）', () => {
  /** 在 CARD_YAML 末尾追加一段（缩进对齐 `abilities` 那一层）。 */
  function withEnchantments(block: string): string {
    return `${CARD_YAML}${block}`
  }

  it('合法目录：aura 型 + stats/actions 型都通过', () => {
    const yaml = withEnchantments(`enchantments:
  - id: obsidian
    aura:
      select: self
      mul:
        - stat: atk
          factor: 2
  - id: emerald
    stats:
      heal: 0
    actions:
      - do: heal_player
        target: own_player
        amount:
          add:
            - ref: self.atk
            - ref: self.heal
`)
    const { dto, ctx } = parseCard(yaml)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))).toHaveLength(0)
  })

  it('卡面写 `enchant` ⇒ 结构层拒绝，建议文案指向 do: enchant', () => {
    const yaml = withEnchantments('enchant: emerald\n')
    const parsed = cardDtoSchema.safeParse(parseYamlDocument(yaml, 'c1.yml').value)
    if (parsed.success) throw new Error('预期结构层拒绝 `enchant`')
    const issues = issuesToErrors(parsed.error.issues, contextOf(yaml, 'c1.yml'))
    expect(issues.some((issue) => (issue.severity ?? 'error') === 'error')).toBe(true)
    expect(issues.some((issue) => issue.suggestion?.includes('do: enchant') ?? false)).toBe(true)
  })

  it('附魔 id 卡内重复 ⇒ error', () => {
    const yaml = withEnchantments(`enchantments:
  - id: emerald
    stats: { heal: 1 }
  - id: emerald
    stats: { heal: 2 }
`)
    const { dto, ctx } = parseCard(yaml)
    const issues = errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))
    expect(issues.some((issue) => issue.message.includes('附魔 id 卡内重复'))).toBe(true)
  })

  it('三块效果全空 ⇒ 结构层拒绝', () => {
    const yaml = withEnchantments('enchantments:\n  - id: empty\n')
    const parsed = cardDtoSchema.safeParse(parseYamlDocument(yaml, 'c1.yml').value)
    expect(parsed.success).toBe(false)
  })

  it('附魔 actions 可以引用**本件附魔自带**的 stats 键（绿宝石的 self.heal）', () => {
    const yaml = withEnchantments(`enchantments:
  - id: emerald
    stats:
      heal: 6
    actions:
      - do: heal_player
        target: own_player
        amount: self.heal
`)
    const { dto, ctx } = parseCard(yaml)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))).toHaveLength(0)
  })

  it('附魔 actions 引用未声明的 stats 键 ⇒ error（上面那条的正对照）', () => {
    const yaml = withEnchantments(`enchantments:
  - id: emerald
    stats:
      heal: 6
    actions:
      - do: heal_player
        target: own_player
        amount: self.regen
`)
    const { dto, ctx } = parseCard(yaml)
    const issues = errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))
    expect(issues.length).toBeGreaterThan(0)
  })

  it('附魔 aura 用禁用倍率（speed）⇒ error（复用光环校验）', () => {
    const yaml = withEnchantments(`enchantments:
  - id: bad
    aura:
      select: self
      mul:
        - stat: speed
          factor: 2
`)
    const { dto, ctx } = parseCard(yaml)
    const issues = errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))
    expect(issues.some((issue) => issue.message.includes('speed'))).toBe(true)
  })

  it('do: enchant 的合法写法通过（目录里有该 id + 卡牌目标 + 参数）', () => {
    const yaml = `id: c1
name: 试验卡
version: 1
size: small
cooldown: 1.50
rarity: bronze
stats:
  atk: 10
enchantments:
  - id: emerald
    stats: { heal: 0 }
abilities:
  - id: 1
    kind: active
    actions:
      - do: enchant
        target: self
        enchant: emerald
`
    const { dto, ctx } = parseCard(yaml)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))).toHaveLength(0)
  })

  it('do: enchant 缺 enchant 参数 ⇒ error；enchant 参数用在别的原语上也 ⇒ error', () => {
    const missing = `id: c1
name: 试验卡
version: 1
size: small
cooldown: 1.50
rarity: bronze
stats:
  atk: 10
abilities:
  - id: 1
    kind: active
    actions:
      - do: enchant
        target: self
`
    const missingParsed = parseCard(missing)
    const missingIssues = errorsOf(validateCard(missingParsed.dto, missingParsed.ctx, { fileName: 'c1' }))
    expect(missingIssues.some((issue) => issue.message.includes('缺少 enchant 参数'))).toBe(true)

    const misused = CARD_YAML.replace(
      '        amount: self.atk',
      '        amount: self.atk\n        enchant: emerald',
    )
    const misusedParsed = parseCard(misused)
    const misusedIssues = errorsOf(validateCard(misusedParsed.dto, misusedParsed.ctx, { fileName: 'c1' }))
    expect(misusedIssues.some((issue) => issue.message.includes('只用于 do: enchant'))).toBe(true)
  })

  it('附魔颜色：`#rrggbb` 通过，并把颜色带进 Card.enchantments', () => {
    const yaml = withEnchantments(`enchantments:
  - id: emerald
    color: '#b197fc'
    stats: { heal: 1 }
`)
    const { dto, ctx } = parseCard(yaml)
    expect(errorsOf(validateCard(dto, ctx, { fileName: 'c1' }))).toHaveLength(0)
    expect(mapCard(dto).enchantments?.[0]?.color).toBe('#b197fc')
  })

  it('附魔颜色写错形状（不带 # / 简写）⇒ 结构层拒绝', () => {
    for (const bad of ['b197fc', '#b17', '#gggggg']) {
      const yaml = withEnchantments(`enchantments:
  - id: emerald
    color: '${bad}'
    stats: { heal: 1 }
`)
      const parsed = cardDtoSchema.safeParse(parseYamlDocument(yaml, 'c1.yml').value)
      expect(parsed.success).toBe(false)
    }
  })

  it('enchant 参数不在本卡目录 ⇒ 只 warn（不拦注册）', () => {
    // ⚠️ 这里**必须写一份独立的卡**：`withEnchantments()` 是追加到 CARD_YAML 的，
    //    再追加一个 `abilities:` 会与它自带的那个重复键 ⇒ 结构层先拒，验不到 warn。
    const yaml = `id: c1
name: 试验卡
version: 1
size: small
cooldown: 1.50
rarity: bronze
stats:
  atk: 10
enchantments:
  - id: emerald
    stats: { heal: 1 }
abilities:
  - id: 1
    kind: active
    actions:
      - do: enchant
        target: self
        enchant: obsidian
`
    const { dto, ctx } = parseCard(yaml)
    const all = validateCard(dto, ctx, { fileName: 'c1' })
    // ① 有 warn（目标可能是别的卡，所以只提醒）
    expect(
      all.some((issue) => issue.severity === 'warn' && issue.message.includes('不在本卡 enchantments 目录里')),
    ).toBe(true)
    // ② 但**没有 error** ⇒ 不拦注册（`errorsOf` 是 CLI 的 exitCode 判据）
    expect(errorsOf(all)).toHaveLength(0)
  })

  it('附魔缺 name ⇒ 只 warn（悬停会回落英文 id）', () => {
    const yaml = withEnchantments(`enchantments:
  - id: emerald
    stats: { heal: 1 }
`)
    const { dto, ctx } = parseCard(yaml)
    const all = validateCard(dto, ctx, { fileName: 'c1' })
    expect(all.some((issue) => issue.severity === 'warn' && issue.message.includes('没写 name'))).toBe(true)
    expect(errorsOf(all)).toHaveLength(0)
  })

  it('开局附魔（阵容）：id 在该卡目录里 ⇒ 放行；不在 ⇒ error（数据写入，不静默）', () => {
    const registry = liveRegistry()
    const ctx = contextOf('id: x', 'd.yml')

    const ok = deckOf('hero: testHeroA\ncards:\n  - id: ironWall\n    slot: 1\n    enchant: aegis\n')
    expect(errorsOf(validateDeck(ok, registry, ctx))).toHaveLength(0)

    const bad = deckOf('hero: testHeroA\ncards:\n  - id: ironWall\n    slot: 1\n    enchant: nope\n')
    const badIssues = errorsOf(validateDeck(bad, registry, ctx))
    expect(badIssues.some((issue) => issue.message.includes('不在这张卡的 enchantments 目录里'))).toBe(true)
  })

  it('开局附魔（阵容）在 `resolveDeck` 后进 `Placement.enchant`', () => {
    const registry = liveRegistry()
    const dto = deckOf('hero: testHeroA\ncards:\n  - id: ironWall\n    slot: 1\n    enchant: aegis\n')
    const resolved = resolveDeck(dto, registry, 'd')
    expect(resolved?.placements[0]?.enchant).toBe('aegis')
  })
})
