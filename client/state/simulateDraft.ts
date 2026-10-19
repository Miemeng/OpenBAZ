// 编辑态草稿**纯逻辑**：不放 JSX、不发请求、不碰 DOM。

// 三条口径：
//   · 数据根先固定 `packs`（草稿里不出现 `packRoots`）；
//   · **不做持久化** —— Draft 只活在内存里，刷新即丢；
//   · 支持"一键加载现成阵容"（**只读**导入，见 `draftFromDeckText`）。

// 校验一律走 `cards/deck.ts`（与 CLI **同一份规则**）：id 是否注册 / **血量三级优先** / 几何。
// 本层**不自己算占格、不自己判合法性**。
import {
  checkDeckGeometry,
  deckDtoSchema,
  parseDeckText,
  resolveDeck,
  validateDeck,
  type DeckDto,
  type ResolvedDeck,
} from '../../cards/deck.ts'
import type { CardRegistry } from '../../cards/registry.ts'
import { problem } from '../../cards/schema.ts'
import type { ValidationContext } from '../../cards/schema.ts'
import type { ValidationError } from '../../cards/types.ts'
import type { BoardError } from '../../engine/board.ts'
import type { PlayerId } from '../../engine/types.ts'

/** 草稿里的一处摆盘 */
export interface DraftPlacement {  /** 草稿内唯一 = `cardId-slot`（同名卡多张时靠它区分 React key 与拖拽目标；导出时剥掉） */
  readonly uid: string
  readonly cardId: string
  /** 左端格号（1 基，1–10） */
  readonly slot: number
  /**
   * 开局附魔 id（**局外养成**；选填 = 无附魔）。
   *
   * 归属是**阵容**而不是卡面（《审阅.md》§AE = A）：导出到 deck 的 `cards[].enchant`，
   * 由 `engine/board.ts` 的 `buildBoardCards` 开局写进 `BoardCard.enchant`。
   */
  readonly enchant?: string
  /**
   * **覆盖卡面数值**（C5；选填 = 全部用卡面值）。
   *
   * 语义 = **覆盖**（`{ atk: 12 }` ⇒ 这张卡按 12 算）；导出到 deck 的 `cards[].stats`。
   * `speed` / `cdp` 在编辑器里**不给入口**（校验层也会拒）。
   */
  readonly stats?: Readonly<Record<string, number>>
}

/**
 * 复制一处摆盘并重设两个可选字段（`undefined` = 清除）。
 *
 * **显式列字段**：`{...placement}` 会把要清除的旧值一起带回去，所以这里逐字段重建。
 */
function rebuildPlacement(
  placement: DraftPlacement,
  enchant: string | undefined,
  stats: Readonly<Record<string, number>> | undefined,
): DraftPlacement {
  const cleaned = stats === undefined || Object.keys(stats).length === 0 ? undefined : stats
  return {
    uid: placement.uid,
    cardId: placement.cardId,
    slot: placement.slot,
    ...(enchant === undefined ? {} : { enchant }),
    ...(cleaned === undefined ? {} : { stats: cleaned }),
  }
}

/** 改某一处摆盘的附魔（`undefined` = 清除）；**即时生效**，不做二次确认 */
export function withPlacementEnchant(side: SideDraft, index: number, enchant: string | undefined): SideDraft {
  return {
    ...side,
    placements: side.placements.map((placement, at) =>
      at === index ? rebuildPlacement(placement, enchant, placement.stats) : placement,
    ),
  }
}

/**
 * 改某一处摆盘的一项**覆盖数值**（`undefined` = 撤掉这一项，回到卡面值）；即时生效。
 *
 * 不校验数值合法性（编辑器里是数字输入框，`validateDeck` 会拦 `speed` / `cdp`）。
 */
export function withPlacementStat(
  side: SideDraft,
  index: number,
  stat: string,
  value: number | undefined,
): SideDraft {
  return {
    ...side,
    placements: side.placements.map((placement, at) => {
      if (at !== index) return placement
      const next: Record<string, number> = {}
      for (const [key, current] of Object.entries(placement.stats ?? {})) {
        if (key !== stat) next[key] = current
      }
      if (value !== undefined) next[stat] = value
      return rebuildPlacement(placement, placement.enchant, next)
    }),
  }
}

export interface SideDraft {
  /** 角色 id；`null` = 还没选（`hero` 在 deck 里是必填 ⇒ 没选就不许开始） */
  readonly heroId: string | null
  /** 血量覆盖：**输入框原文**，空串 = 不覆盖（用角色 `initHp`） */
  readonly hpText: string
  /** 血量上限覆盖：同上 */
  readonly maxHpText: string
  /**
   * 导入来源（`decks/*.yml` 的相对路径；只在"从文件导入"后有值）。
   *
   * **导入 = 拷贝**（RW 口径）：之后的所有编辑只改草稿、**绝不回写文件**；
   * 这一对字段只用于界面显示"来源 + 是否已修改"。
   */
  readonly sourcePath?: string
  /** 导入那一刻的草稿指纹（与 `sideSignature()` 比 ⇒ 判"已修改"） */
  readonly sourceSignature?: string
  readonly placements: readonly DraftPlacement[]
  /** 携带的技能（注册 id 列表；**数量不限**，UI 超出 6 个折叠「+n」） */
  readonly skills: readonly string[]
}

export interface SimulateDraft {
  readonly seed: string
  readonly sideA: SideDraft
  readonly sideB: SideDraft
}

export const EMPTY_SIDE: SideDraft = {
  heroId: null,
  hpText: '',
  maxHpText: '',
  placements: [],
  skills: [],
}

export const EMPTY_DRAFT: SimulateDraft = { seed: '', sideA: EMPTY_SIDE, sideB: EMPTY_SIDE }

/** 草稿内的实例键：`cardId-slot` —— 同名卡两处摆盘的 slot 必不同（重叠非法），故唯一 */
export function placementUid(cardId: string, slot: number): string {
  return `${cardId}-${String(slot)}`
}

/**
 * 草稿指纹（只覆盖"会写进 deck 的东西"）—— 用来判"导入后是否已修改"。
 *
 * 只做字符串比较：不参与校验、不影响对局；技能顺序无关故排序。
 */
export function sideSignature(side: SideDraft): string {
  return JSON.stringify({
    hero: side.heroId,
    hp: side.hpText,
    maxHp: side.maxHpText,
    cards: side.placements.map((placement) => [
      placement.cardId,
      placement.slot,
      placement.enchant ?? null,
      // 覆盖数值按键排序后参与指纹（对象键序不进比较）
      Object.entries(placement.stats ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(','),
    ]),
    skills: [...side.skills].sort(),
  })
}

/** 这份草稿自导入以来是否被改过（没有导入来源 ⇒ `false`） */
export function isSideModified(side: SideDraft): boolean {
  if (side.sourceSignature === undefined) return false
  return sideSignature(side) !== side.sourceSignature
}

/* ------------------------------------------------------------------ *
 * 编辑操作（全部纯函数：进 SideDraft、出新的 SideDraft）
 * ------------------------------------------------------------------ */

/** 放一张卡（同名卡可多张：**不做张数扣减**）。`enchant` / `stats` = 该处摆盘的配装（挪位时由调用方带过来） */
export function addPlacement(
  side: SideDraft,
  cardId: string,
  slot: number,
  enchant?: string,
  stats?: Readonly<Record<string, number>>,
): SideDraft {
  return {
    ...side,
    placements: [
      ...side.placements,
      {
        uid: placementUid(cardId, slot),
        cardId,
        slot,
        ...(enchant === undefined ? {} : { enchant }),
        ...(stats === undefined ? {} : { stats }),
      },
    ],
  }
}

/** 按下标移除（用下标而不是 uid：移动会改 uid，下标在同一帧内是稳定的） */
export function removePlacementAt(side: SideDraft, index: number): SideDraft {
  return { ...side, placements: side.placements.filter((_, at) => at !== index) }
}

/** 把第 `index` 处挪到 `slot`（左端格号）—— **附魔跟着这一处走**，不随格号丢 */
export function movePlacementTo(side: SideDraft, index: number, slot: number): SideDraft {
  return {
    ...side,
    placements: side.placements.map((placement, at) =>
      at === index ? { ...placement, uid: placementUid(placement.cardId, slot), slot } : placement,
    ),
  }
}

/** 技能开关（数量不限） */
export function toggleSkill(side: SideDraft, skillId: string): SideDraft {
  return {
    ...side,
    skills: side.skills.includes(skillId)
      ? side.skills.filter((id) => id !== skillId)
      : [...side.skills, skillId],
  }
}

export function withHero(side: SideDraft, heroId: string | null): SideDraft {
  return { ...side, heroId }
}

export function withHpText(side: SideDraft, hpText: string, maxHpText: string): SideDraft {
  return { ...side, hpText, maxHpText }
}

/* ------------------------------------------------------------------ *
 * 校验（全部委托 `cards/deck.ts`）
 * ------------------------------------------------------------------ */

/** 草稿的"伪文件"上下文：没有行号，但 `path` 足以定位到具体控件（角色 / 第几张卡 / 血量框） */
function editorContext(side: PlayerId): ValidationContext {
  return { file: side === 1 ? '阵容 A（编辑中）' : '阵容 B（编辑中）', positions: new Map() }
}

/** 输入框 → 正数；空串 = 不覆盖（`undefined`） */
function parsePositiveNumber(text: string): { readonly value?: number; readonly error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `必须填 > 0 的数字（现在是「${trimmed}」）；留空 = 用角色默认血量` }
  }
  return { value }
}

/** 血量两个输入框的问题（这是**表现层多出来的一层**：deck 文件里本来就是数字，编辑器里是文本） */
function hpTextIssues(side: SideDraft, ctx: ValidationContext): ValidationError[] {
  const issues: ValidationError[] = []
  const hp = parsePositiveNumber(side.hpText)
  if (hp.error !== undefined) issues.push(problem('schema.invalid', `血量覆盖：${hp.error}`, ctx, ['hp']))
  const maxHp = parsePositiveNumber(side.maxHpText)
  if (maxHp.error !== undefined) issues.push(problem('schema.invalid', `血量上限覆盖：${maxHp.error}`, ctx, ['maxHp']))
  return issues
}

/** 草稿 → `DeckDto`（**剥掉 uid**，与 `decks/*.yml` 同构）；结构问题也一并报出 */
export function sideToDeckDto(
  side: SideDraft,
): { readonly dto: DeckDto; readonly errors: readonly ValidationError[] } | { readonly errors: readonly ValidationError[] } {
  const ctx = editorContext(1)
  const issues = hpTextIssues(side, ctx)
  if (side.heroId === null) {
    issues.push(problem('schema.invalid', '还没选角色（deck 的 hero 是必填）', ctx, ['hero']))
    return { errors: issues }
  }

  const hp = parsePositiveNumber(side.hpText).value
  const maxHp = parsePositiveNumber(side.maxHpText).value
  const candidate: DeckDto = {
    hero: side.heroId,
    ...(hp === undefined ? {} : { hp }),
    ...(maxHp === undefined ? {} : { maxHp }),
    cards: side.placements.map((placement) => ({
      id: placement.cardId,
      slot: placement.slot,
      ...(placement.enchant === undefined ? {} : { enchant: placement.enchant }),
      ...(placement.stats === undefined ? {} : { stats: placement.stats }),
    })),
    ...(side.skills.length === 0 ? {} : { skills: [...side.skills] }),
  }

  // 结构校验交给**同一份 schema**（`cards/deck.ts` 的 `deckDtoSchema`）：空卡组、slot 越界等在这里拦
  const parsed = deckDtoSchema.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(problem('schema.invalid', issue.message, ctx, [...issue.path.map((part) => String(part))]))
    }
    return { errors: issues }
  }
  return { dto: parsed.data, errors: issues }
}

export interface SideValidation {
  /** `error` 级：**阻断"开始对局"**，UI 逐条显示 */
  readonly errors: readonly ValidationError[]
  /** `warn` 级：提示但不阻断（如 `maxHp < hp`） */
  readonly warnings: readonly ValidationError[]
  /** 通过时的装配结果（血量三级优先 / 摆盘 / 技能） */
  readonly resolved?: ResolvedDeck | undefined
  /** 几何错误（`E_SLOT` / `E_CARD_REF`）：UI 用来**逐格高亮** */
  readonly boardErrors: readonly BoardError[]
}

/** 一份草稿的全量校验：结构 → id 注册 → 装配 → 几何 */
export function validateSideDraft(side: SideDraft, registry: CardRegistry, sideNo: PlayerId): SideValidation {
  const ctx = editorContext(sideNo)
  const issues: ValidationError[] = []
  const built = sideToDeckDto(side)
  issues.push(...built.errors)
  if (!('dto' in built)) {
    return { errors: issues, warnings: [], boardErrors: [] }
  }

  issues.push(...validateDeck(built.dto, registry, ctx))
  const resolved = resolveDeck(built.dto, registry, sideNo === 1 ? '阵容 A' : '阵容 B')
  const boardErrors = resolved === undefined ? [] : checkDeckGeometry(sideNo, resolved)

  const errors = issues.filter((issue) => (issue.severity ?? 'error') === 'error')
  const warnings = issues.filter((issue) => (issue.severity ?? 'error') !== 'error')
  return { errors, warnings, ...(resolved === undefined ? {} : { resolved }), boardErrors }
}

/* ------------------------------------------------------------------ *
 * 只读导入：现成阵容 → 草稿（不写文件）
 * ------------------------------------------------------------------ */

/** 解析一段阵容原文（来自 `decks/*.yml`）并转成草稿；解析失败只回错误、不改草稿 */
export function draftFromDeckText(
  text: string,
  file: string,
  registry: CardRegistry,
): { readonly side?: SideDraft; readonly errors: readonly ValidationError[] } {
  const parsed = parseDeckText(text, file)
  if (parsed.dto === undefined) return { errors: parsed.errors }

  const dto = parsed.dto
  const side: SideDraft = {
    heroId: dto.hero,
    hpText: dto.hp === undefined ? '' : String(dto.hp),
    maxHpText: dto.maxHp === undefined ? '' : String(dto.maxHp),
    placements: dto.cards.map((card) => ({
      uid: placementUid(card.id, card.slot),
      cardId: card.id,
      slot: card.slot,
      ...(card.enchant === undefined ? {} : { enchant: card.enchant }),
      ...(card.stats === undefined ? {} : { stats: card.stats }),
    })),
    skills: [...(dto.skills ?? [])],
    // 导入 = 拷贝：记下来源与该刻指纹，界面据此显示"来源 / 已修改"，**绝不回写文件**
    sourcePath: file,
    sourceSignature: '',
  }
  // 指纹必须在 side 建好之后算（`sideSignature` 读的是这份草稿）
  const withSignature: SideDraft = { ...side, sourceSignature: sideSignature(side) }

  // 结构合法 ≠ 引用合法：导入后立刻按**同一套**校验跑一遍，问题原样带回给状态栏
  const validation = validateSideDraft(withSignature, registry, 1)
  return { side: withSignature, errors: [...parsed.errors, ...validation.errors, ...validation.warnings] }
}
