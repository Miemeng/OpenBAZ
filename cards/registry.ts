/**
 * 纯逻辑・注册层：`CardRegistry`。
 *
 * 职责边界（**只管注册 / 查询**）：
 *  - 不碰文件、不做 IO、不做校验（进来的定义都已在 `cards/schema.ts` 校验通过）；
 *  - 按 `id → version → def` 两层记账：`get(id)` 缺省取最新版本，`get(id, version)` 取精确版本
 *    （进行中战斗与日志追溯用）；
 *  - **版本隔离**：重载只是把新定义放进表里，已开始的对局持有自己那份引用，不受影响。
 *
 * 加载形态：一次性加载 + 宿主显式触发重载。`loadPacks()`
 * （`cards/loader.ts`）→ 校验通过的定义 → `replaceAll(packs)`。**重载的唯一入口是
 * `replaceAll`**；`replacePack` 只是"单包热替换"的预留粒度。
 */

import type { Ability, ActionSpec, AuraDef, Card as CardDef, Condition, Expr, SelectorQuery, Skill as SkillDef } from '../engine/types.ts'
import type { LoadedPack, HeroDef } from './types.ts'

/** 一个卡包对自己注册项的记账（`replacePack` 需要知道该删哪些 id）。 */
interface PackContribution {
  readonly cards: string[]
  readonly skills: string[]
  readonly heroes: string[]
}

/** 取版本号最大的那一份（缺省版本的语义：最新）。 */
function latestVersion<T>(versions: ReadonlyMap<number, T>): T | undefined {
  let bestVersion: number | undefined
  let found: T | undefined
  for (const [version, def] of versions) {
    if (bestVersion === undefined || version > bestVersion) {
      bestVersion = version
      found = def
    }
  }
  return found
}

const CMP_TEXT = { lt: '<', lte: '<=', gt: '>', gte: '>=', eq: '==', neq: '!=' } as const

function renderExpr(expr: Expr): string {
  if (typeof expr === 'number') return String(expr)
  if (typeof expr === 'string') return expr
  if ('ref' in expr) return expr.ref
  if ('var' in expr) return `$${expr.var}`
  if ('count' in expr) {
    return `count(${typeof expr.count === 'string' ? expr.count : renderSelector(expr.count)})`
  }
  if ('add' in expr) return `(${expr.add.map((item) => renderExpr(item)).join(' + ')})`
  if ('sub' in expr) return `(${expr.sub.map((item) => renderExpr(item)).join(' - ')})`
  if ('mul' in expr) return `(${expr.mul.map((item) => renderExpr(item)).join(' * ')})`
  return `(${expr.div.map((item) => renderExpr(item)).join(' / ')})`
}

function renderCondition(condition: Condition): string {
  if ('cmp' in condition) {
    return `${renderExpr(condition.left)} ${CMP_TEXT[condition.cmp]} ${renderExpr(condition.right)}`
  }
  if ('not' in condition) return `非(${renderCondition(condition.not)})`
  if ('any' in condition) return `(${condition.any.map((item) => renderCondition(item)).join(' 或 ')})`
  return `(${condition.all.map((item) => renderCondition(item)).join(' 且 ')})`
}

function renderSelector(selector: string | SelectorQuery): string {
  if (typeof selector === 'string') return selector
  const parts: string[] = []
  if (selector.side !== undefined) parts.push(`side=${selector.side}`)
  if (selector.zone !== undefined) parts.push(`zone=${selector.zone}`)
  if (selector.from !== undefined) parts.push(`from=${selector.from}`)
  if (selector.relative !== undefined) parts.push(`relative=${selector.relative}`)
  if (selector.direction !== undefined) parts.push(`direction=${selector.direction}`)
  if (selector.tags !== undefined) parts.push(`tags=${selector.tags.join('|')}`)
  if (selector.tagMode !== undefined) parts.push(`tagMode=${selector.tagMode}`)
  if (selector.filter !== undefined) parts.push(`filter=${renderCondition(selector.filter)}`)
  if (selector.destroyed !== undefined) parts.push(`destroyed=${selector.destroyed}`)
  if (selector.sort !== undefined) parts.push(`sort=${selector.sort}`)
  if (selector.random !== undefined) parts.push(`random=${selector.random}`)
  if (selector.limit !== undefined) parts.push(`limit=${selector.limit}`)
  return parts.length === 0 ? '{}' : `{${parts.join(', ')}}`
}

function renderAction(action: ActionSpec): string {
  const parts: string[] = [action.do]
  if (action.target !== undefined) parts.push(`作用于 ${renderSelector(action.target)}`)
  if (action.stat !== undefined) parts.push(`stat=${action.stat}`)
  if (action.status !== undefined) parts.push(`status=${action.status}`)
  if (action.amount !== undefined) parts.push(`数额=${renderExpr(action.amount)}`)
  if (action.seconds !== undefined) parts.push(`时长=${renderExpr(action.seconds)}秒`)
  if (action.duration !== undefined) parts.push(`持续=${renderExpr(action.duration)}秒`)
  if (action.stackLimit !== undefined) parts.push(`层数上限=${action.stackLimit}`)
  return parts.join('，')
}

function renderAura(aura: AuraDef): string {
  const parts: string[] = [`作用于 ${renderSelector(aura.select)}`]
  if (aura.apply !== undefined) {
    parts.push(`平铺 ${aura.apply.map((entry) => `${entry.stat}${entry.amount >= 0 ? '+' : ''}${entry.amount}`).join('、')}`)
  }
  if (aura.mul !== undefined) {
    parts.push(`倍率 ${aura.mul.map((entry) => `${entry.stat}×${entry.factor}`).join('、')}`)
  }
  if (aura.condition !== undefined) parts.push(`条件 ${renderCondition(aura.condition)}`)
  return parts.join('，')
}

function renderAbility(ability: Ability): string {
  const kind = ability.kind === 'passive' ? `被动 P${ability.priority ?? 5}` : '主动'
  const timing =
    ability.trigger !== undefined
      ? `时机 ${ability.trigger.event}`
      : ability.kind === 'active'
        ? '行动条充满时'
        : '未绑时机'
  const every = ability.everyN !== undefined ? `（每 ${ability.everyN} 次）` : ''
  const condition = ability.condition !== undefined ? `，条件 ${renderCondition(ability.condition)}` : ''
  const actions = ability.actions.map((action) => renderAction(action)).join('；')
  return `  [${kind}] ${timing}${every}${condition} → ${actions}`
}

/** 加载回显。措辞是机器可读的紧凑形式，时机词的中文说法留待落地。 */
function cardSummary(card: CardDef): string[] {
  const lines: string[] = [`已加载 ${card.name} v${card.version}:`]
  for (const ability of card.abilities ?? []) lines.push(renderAbility(ability))
  if (card.aura !== undefined) lines.push(`  [光环] ${renderAura(card.aura)}`)
  const enchantments = card.enchantments ?? []
  if (enchantments.length > 0) {
    lines.push(`  [附魔目录] ${enchantments.map((enchant) => enchant.id).join(' / ')}（仅目录；生效需 do: enchant 施加）`)
  }
  return lines
}

function skillSummary(skill: SkillDef): string[] {
  const lines: string[] = [`已加载 技能 ${skill.name} v${skill.version}:`]
  const timing = skill.trigger !== undefined ? `时机 ${skill.trigger.event}` : '未绑时机'
  const condition = skill.condition !== undefined ? `，条件 ${renderCondition(skill.condition)}` : ''
  const actions = skill.actions.map((action) => renderAction(action)).join('；')
  lines.push(`  [技能 P${skill.priority ?? 5}] ${timing}${condition} → ${actions}`)
  if (skill.aura !== undefined) lines.push(`  [光环] ${renderAura(skill.aura)}`)
  return lines
}

export class CardRegistry {
  private readonly cards = new Map<string, Map<number, CardDef>>()
  private readonly skills = new Map<string, Map<number, SkillDef>>()
  /** 角色：**按 id 唯一**（一个 id 一份定义；不按 version 建多版本表）。 */
  private readonly heroes = new Map<string, HeroDef>()
  private readonly byPack = new Map<string, PackContribution>()

  // ——— 查询 —

  /** 卡牌：`version` 缺省取最新版本；未命中返回 `undefined`（不抛错）。 */
  get(id: string, version?: number): CardDef | undefined {
    const versions = this.cards.get(id)
    if (versions === undefined) return undefined
    if (version !== undefined) return versions.get(version)
    return latestVersion(versions)
  }

  /** 技能：语义同 `get`。 */
  getSkill(id: string, version?: number): SkillDef | undefined {
    const versions = this.skills.get(id)
    if (versions === undefined) return undefined
    if (version !== undefined) return versions.get(version)
    return latestVersion(versions)
  }

  /**
   * 角色：按 id 取（**不按 version 建表** —— 同一 id 后注册者覆盖先注册者，
   * 加载期已由 `pack.duplicate_id` 报过冲突）；未命中返回 `undefined`。
   * `decks/*.yml` 用它取 `initHp` / `initMaxHp`（ ``）。
   */
  getHero(id: string): HeroDef | undefined {
    return this.heroes.get(id)
  }

  /** 全量导出（加载回显 / 清单生成用），含同一 id 的所有版本。 */
  getAll(): { cards: readonly CardDef[]; skills: readonly SkillDef[] } {
    const cards: CardDef[] = []
    for (const versions of this.cards.values()) cards.push(...versions.values())
    const skills: SkillDef[] = []
    for (const versions of this.skills.values()) skills.push(...versions.values())
    return { cards, skills }
  }

  /** 加载回显文本：卡牌优先，其次技能；都没命中给一行"未找到"。 */
  summary(id: string): string[] {
    const card = this.get(id)
    if (card !== undefined) return cardSummary(card)
    const skill = this.getSkill(id)
    if (skill !== undefined) return skillSummary(skill)
    return [`未找到：${id}`]
  }

  // ——— 注册 —

  /** 同 id 同 version 覆盖（注册表不做校验，冲突口径由读取层在加载期报 `pack.duplicate_id`）。 */
  registerCard(def: CardDef): void {
    let versions = this.cards.get(def.id)
    if (versions === undefined) {
      versions = new Map<number, CardDef>()
      this.cards.set(def.id, versions)
    }
    versions.set(def.version, def)
  }

  registerSkill(def: SkillDef): void {
    let versions = this.skills.get(def.id)
    if (versions === undefined) {
      versions = new Map<number, SkillDef>()
      this.skills.set(def.id, versions)
    }
    versions.set(def.version, def)
  }

  /** 注册一个角色（按 id 唯一；后注册者覆盖）。 */
  registerHero(def: HeroDef): void {
    this.heroes.set(def.id, def)
  }

  /** 整包批量注册（并按包记账）。 */
  registerAll(pack: LoadedPack): void {
    for (const card of pack.cards) this.registerCard(card)
    for (const skill of pack.skills) this.registerSkill(skill)
    for (const hero of pack.heroes) this.registerHero(hero)
    this.byPack.set(pack.packId, {
      cards: pack.cards.map((card) => card.id),
      skills: pack.skills.map((skill) => skill.id),
      heroes: pack.heroes.map((hero) => hero.id),
    })
  }

  /**
   * 整包替换（宿主重载单个包）。
   *
   * 注意：记账只按 **id** 粒度 —— 若同一个 id 也被别的卡包提供（加载期已报
   * `pack.duplicate_id`、先到者保留），这里的删除会**连带**把它从表里去掉；
   * 因此重载请优先用 `replaceAll()`（本轮 CLI / 客户端的唯一入口）。
   */
  replacePack(packId: string, pack: LoadedPack): void {
    const previous = this.byPack.get(packId)
    if (previous !== undefined) {
      for (const id of previous.cards) this.cards.delete(id)
      for (const id of previous.skills) this.skills.delete(id)
      for (const id of previous.heroes) this.heroes.delete(id)
      this.byPack.delete(packId)
    }
    this.registerAll(pack)
  }

  /** 全量替换（重载的唯一入口）：先清空，再按给定顺序整包注册。 */
  replaceAll(packs: readonly LoadedPack[]): void {
    this.cards.clear()
    this.skills.clear()
    this.heroes.clear()
    this.byPack.clear()
    for (const pack of packs) this.registerAll(pack)
  }
}
