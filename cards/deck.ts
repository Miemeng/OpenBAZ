/**
 * 纯逻辑 · 阵容文件（`decks/*.yml`）的**契约 + 校验 + 装配** —— 。
 * **本文件于  从 `simulator/deck.ts` 拆出**（ `` ）：拆的理由是
 * 这套逻辑**两边都要用**
 *  - CLI / 宿主侧：[simulator/deck.ts](../simulator/deck.ts) 只留"读文件 + 一次装满"（含 `node:fs`），
 *    并把这里的名字**原样 re-export**（`simulator/run.ts` 等调用方一行都不用改）；
 *  - 客户端（`client/`）：摆盘的**前置校验**（hero / 卡 / 技能 id 是否已注册）、**血量三级优先**、
 *    **几何校验**全在这里 —— 前端**不再另写一份**。
 * 因此本文件必须留在 `cards/` 的**纯逻辑白名单**里（`eslint.config.js`）：不碰 `node:*`、可被浏览器宿主运行。
 *
 * 格式：
 * ```yaml
 * name: 示例阵容      # 选填：显示名；缺省 = 文件名
 * hero: myHero       # 必填：角色 id（须已注册）；血量取它的 initHp / initMaxHp
 * # hp: 1000         # 选填：**覆盖**角色血量（调试 / 模拟模式专供）
 * # maxHp: 1100      # 选填：**覆盖**血量上限
 * cards:             # 必填：场上卡牌（只引用已注册 id）
 *   - id: myCard
 *     slot: 1        # 必填：左端所在格（1–10，1 基）
 * skills: [mySkill]  # 选填：该玩家携带的技能（注册 id 列表）
 * ```
 *
 * RW 的三条裁定：① **`hero` 必填**（后续英雄校验 / 触发器 / 头像加载都要它）；
 * ② **`slot` 必填，缺了报 `error`**；③ **同 id 张数不限**（几何与 10 格是唯二约束）。
 * ✅ **卡牌 `stats` 覆盖（C5 起实现）**：`cards[].stats` = **覆盖**卡面同名字段（不是增量），
 * **`speed` / `cdp` 禁写**（写 ⇒ `error`）；叠加次序 = 卡面 → **本覆盖** → 附魔 `stats` → 局内 buff → 光环。
 *
 * 校验与装配**都是纯函数、不抛异常**，与 `cards/schema.ts` 同口径。
 */

import { z } from 'zod'
import { validatePlacements, type BoardError, type Placement } from '../engine/board.ts'
import type { PlayerId } from '../engine/types.ts'
import { CardRegistry } from './registry.ts'
import { issuesToErrors, parseYamlDocument, problem } from './schema.ts'
import type { ValidationContext } from './schema.ts'
// `ValidationError` 的定义在 `cards/types.ts`（`schema.ts` 只是把它 import 进来用，并非 re-export）。
import type { ValidationError } from './types.ts'

/* ------------------------------------------------------------------ *
 * DTO 契约
 * ------------------------------------------------------------------ */

/** 阵容里的一张卡：只引用 id + 必填槽位。 */
export interface DeckCardDto {
  readonly id: string
  /** 左端所在格（1 基，1–10）。 */
  readonly slot: number
  /**
   * 开局给这张卡挂上的附魔 id（选填；**局外养成**，见《审阅.md》§AE = A）。
   *
   * 必须是**这张卡** `enchantments` 目录里已登记的 id —— 写错是**数据错误**（`error`），
   * 与 `do: enchant` 运行期的"目录里没有就静默跳过"不同。
   */
  readonly enchant?: string | undefined
  /**
   * **覆盖**这张卡的卡面数值（选填；C5）。
   *
   * 语义 = **覆盖**（不是增量）：`{ atk: 12 }` ⇒ 这张卡的攻击按 12 算，与卡面写的无关。
   * **`speed` / `cdp` 禁写**（写 ⇒ `error`，`validateDeck` 拦）；其余键按卡牌 `stats` 同一张表。
   * 叠加次序 = 卡面 → **本覆盖** → 附魔自带 `stats` → 局内 buff → 光环（平铺、再倍率）。
   */
  readonly stats?: Readonly<Record<string, number>> | undefined
}

export interface DeckDto {
  /** 显示名；缺省 = 文件名（由宿主补）。 */
  readonly name?: string | undefined
  /** 角色 id（必填）。 */
  readonly hero: string
  /** **覆盖**角色血量（选填；不写 = 用角色文件的 `initHp`）。 */
  readonly hp?: number | undefined
  /** **覆盖**血量上限（选填；不写 = 角色的 `initMaxHp`，再缺省 = 生效的 `hp`）。 */
  readonly maxHp?: number | undefined
  readonly cards: readonly DeckCardDto[]
  readonly skills?: readonly string[] | undefined
}

/** 阵容里的一张卡：`slot` **必填**。 */
const deckCardDtoSchema: z.ZodType<DeckCardDto> = z.strictObject({
  id: z.string().min(1, 'cards[].id 必填'),
  slot: z
    .int('slot 必须是整数（左端格号，1 基）')
    .min(1, 'slot 最小为 1')
    .max(10, 'slot 最大为 10（每方 10 格）'),
  enchant: z.string().min(1, 'enchant 写附魔 id（该卡 enchantments 目录里的那一件）').optional(),
  // 覆盖卡面数值：值必须是数字；`speed` / `cdp` 的禁令在 `validateDeck` 里报（结构层只查类型）
  stats: z.record(z.string().min(1), z.number()).optional(),
})

export const deckDtoSchema: z.ZodType<DeckDto> = z.strictObject({
  name: z.string().min(1).optional(),
  hero: z.string().min(1, 'hero 必填（角色 id，须已在某个包里注册）'),
  hp: z.number().positive('hp 必须 > 0').optional(),
  maxHp: z.number().positive('maxHp 必须 > 0').optional(),
  cards: z.array(deckCardDtoSchema).min(1, 'cards 至少 1 张（空阵容没有意义）'),
  skills: z.array(z.string().min(1)).optional(),
})

/* ------------------------------------------------------------------ *
 * 解析（YAML 文本 → DTO）—— 纯函数：文本进来、结果出去（读文件在宿主侧）
 * ------------------------------------------------------------------ */

export interface ParsedDeck {
  readonly dto?: DeckDto | undefined
  readonly ctx: ValidationContext
  readonly errors: readonly ValidationError[]
}

/** 由文件名（不含目录 / 扩展名）取缺省阵容名。 */
export function deckNameFromPath(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  return base.replace(/\.ya?ml$/, '')
}

/** 解析一份阵容 YAML（语法错 / 结构错都进 `errors`，不抛异常）。 */
export function parseDeckText(text: string, file: string): ParsedDeck {
  const doc = parseYamlDocument(text, file)
  const ctx: ValidationContext = { file, positions: doc.positions }
  if (doc.syntaxError !== undefined) return { ctx, errors: [doc.syntaxError] }
  const parsed = deckDtoSchema.safeParse(doc.value)
  if (!parsed.success) return { ctx, errors: issuesToErrors(parsed.error.issues, ctx) }
  return { dto: parsed.data, ctx, errors: [] }
}

/* ------------------------------------------------------------------ *
 * 语义校验 + 装配
 * ------------------------------------------------------------------ */

/**
 * 校验阵容里的 id 是否都已注册：**任一未注册 ⇒ `error`**。
 *
 * 客户端用它做"开始对局"的前置校验（`` 第 1 条）：把 `ctx` 传成 `{ file: '编辑器', positions: new Map() }`
 * 即得到一份"没有行号但有 path"的问题清单（`path` 指向 `hero` / `cards[i].id` / `skills[i]`，足以定位到具体控件）。
 */
export function validateDeck(
  dto: DeckDto,
  registry: CardRegistry,
  ctx: ValidationContext,
): readonly ValidationError[] {
  const issues: ValidationError[] = []

  if (registry.getHero(dto.hero) === undefined) {
    issues.push(
      problem('deck.hero.unknown', `hero 引用了未注册的角色 id：${dto.hero}`, ctx, ['hero'], {
        suggestion: '该角色可能来自未加载的卡包；请确认 packs/ 下已包含它，或改 hero',
      }),
    )
  }

  if (dto.hp !== undefined && dto.maxHp !== undefined && dto.maxHp < dto.hp) {
    issues.push(
      problem('deck.hp.max_less_than_hp', `maxHp（${dto.maxHp}）小于 hp（${dto.hp}）`, ctx, ['maxHp'], {
        severity: 'warn',
        suggestion: 'maxHp 缺省 = hp',
      }),
    )
  }

  for (const [index, entry] of dto.cards.entries()) {
    const card = registry.get(entry.id)
    if (card === undefined) {
      issues.push(
        problem('deck.card.unknown', `cards[${index}] 引用了未注册的卡牌 id：${entry.id}`, ctx, ['cards', index, 'id'], {
          suggestion: '该卡可能来自未加载的卡包；请确认 packs/ 下已包含它，或改 id',
        }),
      )
      continue
    }
    // 开局附魔（局外养成，§AE = A）：**必须是这张卡目录里的 id** —— 这是数据写入，写错就是 error
    if (entry.enchant !== undefined) {
      const available = (card.enchantments ?? []).map((enchant) => enchant.id)
      if (!available.includes(entry.enchant)) {
        issues.push(
          problem(
            'deck.enchant.unknown',
            `cards[${index}] 的 enchant「${entry.enchant}」不在这张卡的 enchantments 目录里`,
            ctx,
            ['cards', index, 'enchant'],
            {
              suggestion:
                available.length > 0
                  ? `可选：${available.join(' / ')}`
                  : `${entry.id} 没有附魔目录（卡面不写 enchantments）⇒ 请删掉这一行的 enchant`,
            },
          ),
        )
      }
    }
    // 阵容覆盖数值（C5）：`speed` / `cdp` **禁写** —— 速度只有状态系数、冷却百分比是行动周期参数，
    // 两者都不属于"卡面基础层"；允许覆盖会让行动周期随阵容漂移（时序不确定性）。
    for (const key of Object.keys(entry.stats ?? {})) {
      if (key === 'speed' || key === 'cdp') {
        issues.push(
          problem(
            'deck.stats.forbidden_key',
            `cards[${index}] 的 stats 不得覆盖 ${key}`,
            ctx,
            ['cards', index, 'stats', key],
            {
              suggestion:
                'speed / cdp 不属于可覆盖的卡面基础层；要调速请改卡面 cooldown（或走加速 / 减速状态）',
            },
          ),
        )
      }
    }
  }

  for (const [index, id] of (dto.skills ?? []).entries()) {
    if (registry.getSkill(id) === undefined) {
      issues.push(
        problem('deck.skill.unknown', `skills[${index}] 引用了未注册的技能 id：${id}`, ctx, ['skills', index], {
          suggestion: '该技能可能来自未加载的卡包；请确认 packs/ 下已包含它，或改 id',
        }),
      )
    }
  }

  return issues
}

/** 一方阵容装配好的结果：摆盘 + 技能 + 生效血量。 */
export interface ResolvedDeck {
  /** 该玩家摆盘（已按 `slot` 升序）。 */
  readonly placements: readonly Placement[]
  /** 该玩家携带的技能（引擎契约）。 */
  readonly skills: readonly NonNullable<ReturnType<CardRegistry['getAll']>['skills'][number]>[]
  /** 生效血量（`hp` 覆盖 > 角色 `initHp`）。 */
  readonly hp: number
  /** 生效血量上限（`maxHp` 覆盖 > 角色 `initMaxHp` > 生效 `hp`）。 */
  readonly maxHp: number
  /** 阵容显示名（宿主补的缺省也算）。 */
  readonly name: string
  /** 该阵容用到的角色 id。 */
  readonly heroId: string
}

/**
 * 把校验通过的阵容装配成引擎入参。
 *
 * ⚠️ **调用前必须先过 `validateDeck()`**；本函数在查不到 id 时返回 `undefined`（调用方应中止）。
 * **血量三级优先**：deck `hp` / `maxHp` 覆盖 > 角色 `initHp` / `initMaxHp` > 引擎兜底常量
 * （最后一级由 `engine/state.ts` 负责，本函数只在角色缺 `initMaxHp` 时把 `maxHp` 落回生效的 `hp`）。
 */
export function resolveDeck(
  dto: DeckDto,
  registry: CardRegistry,
  fallbackName: string,
): ResolvedDeck | undefined {
  const hero = registry.getHero(dto.hero)
  if (hero === undefined) return undefined

  const placements: Placement[] = []
  for (const entry of dto.cards) {
    const card = registry.get(entry.id)
    if (card === undefined) return undefined
    placements.push({
      card,
      slot: entry.slot,
      ...(entry.enchant === undefined ? {} : { enchant: entry.enchant }),
      ...(entry.stats === undefined ? {} : { stats: entry.stats }),
    })
  }

  const skills = []
  for (const id of dto.skills ?? []) {
    const skill = registry.getSkill(id)
    if (skill === undefined) return undefined
    skills.push(skill)
  }

  const hp = dto.hp ?? hero.initHp
  const maxHp = dto.maxHp ?? hero.initMaxHp ?? hp

  return {
    placements: [...placements].sort((left, right) => left.slot - right.slot),
    skills,
    hp,
    maxHp,
    name: dto.name ?? fallbackName,
    heroId: dto.hero,
  }
}

/** 摆盘的几何错误（重叠 / 越界 / 起点非整数）—— `side` 用于错误归属。 */
export function checkDeckGeometry(side: PlayerId, deck: ResolvedDeck): readonly BoardError[] {
  return validatePlacements(side, deck.placements)
}

/** 是否含 `error` 级问题（调用方据此中止对局 / 禁用"开始"按钮）。 */
export function hasFatal(errors: readonly ValidationError[]): boolean {
  return errors.some((issue) => (issue.severity ?? 'error') === 'error')
}
