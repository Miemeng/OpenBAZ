// 悬浮细节窗的**数据层**（纯逻辑；渲染在 `components/CardDetail.tsx`）
//
// 权威 = 《卡面表现设计.md》§4（四区窗）/ §5（数值行）/ §6（行动条读数条）。
// 本文件**不重写战斗规则**：
//   · 数值行 = 卡面（回放态取当前帧 `FrameCard.stats`、编辑态取卡面 `Card.stats`），候选清单 = `STAT_ROW`；
//   · 行动条读数 = 回放态直接用 `replay.ts` 的 `gaugeViewOf()`（沿用"冰冻向前借周期"那套口径），
//     编辑态让**引擎**算基础周期（`buildBoardCards` + `actionPeriodCs`），不在前端复刻 `cdp` / 速度公式；
//   · 效果区文本 = 读取层的 `CardRegistry.summary()`（与 CLI 的加载回显同一个函数），本文件只做**分组**。

import { buildBoardCards, slotsForCard } from '../../engine/board.ts'
import { actionPeriodCs, csToSeconds } from '../../engine/state.ts'
import type { Card, EnchantDef, FrameCard } from '../../engine/types.ts'
import { ENCHANT_FALLBACK_COLOR, STAT_ROW } from '../theme/colors.ts'
import type { GaugeView } from './replay.ts'

/** 数值行的一项（顺序与配色都来自 `STAT_ROW`） */
export interface DetailStatRow {
  readonly stat: string
  readonly label: string
  readonly color: string
  readonly value: number
}

/** 行动条读数条（§6）：`null` = 不渲染该条（纯被动卡） */
export interface DetailGauge {
  /** 充满周期（**秒**，两位小数以内）—— 回放态含加速 / 减速 / 冰冻 / `cdp` 的实时结果 */
  readonly periodSeconds: number
  /** 当前进度百分比；`null` = 编辑态（还没开始，无进度可读） */
  readonly percent: number | null
  /** 就绪（充满当帧）：读数条显示「就绪」并高亮 */
  readonly ready: boolean
  /** 冰冻中：显示雪花 + 「冰冻」，进度冻结 */
  readonly frozen: boolean
}

/** 效果区的一条（主动 / 被动 / 技能 / 光环） */
export interface DetailEffect {
  readonly kind: 'active' | 'passive' | 'skill' | 'aura' | 'enchant'
  readonly text: string
}

/** 底部信息条（§4.3 ⑤） */
/** 当前生效附魔的显示信息（C4a） */
export interface DetailEnchant {
  readonly id: string
  readonly name: string
  readonly color: string
}

export interface DetailFoot {
  readonly tags: readonly string[]
  /** 归属文案（已解析成角色名 / 「通用」）；`null` = **不渲染该格** */
  readonly owner: string | null
  readonly span: number
  readonly version: number
  /** `multicast > 1` 时显示「多重触发 N」；否则 `null` */
  readonly multicast: number | null
}

export interface CardDetailView {
  readonly title: string
  /** 当前生效的附魔（C4a）：**卡名上方那一行只放名字**；无附魔 / 编辑态 ⇒ null */
  readonly enchant: DetailEnchant | null
  readonly rarity: { readonly name: string; readonly color: string }
  readonly description: string | null
  readonly stats: readonly DetailStatRow[]
  readonly gauge: DetailGauge | null
  readonly effects: readonly DetailEffect[]
  readonly foot: DetailFoot
}

export interface BuildDetailInput {
  readonly card: Card
  /** 回放态 = 当前帧的 `FrameCard`；**编辑态 = `undefined`**（数值取卡面自带） */
  readonly frame: FrameCard | undefined
  /** 回放态 = `gaugeViewOf(frames, index, card)` 的结果；编辑态 = `undefined` */
  readonly gauge: GaugeView | undefined
  /** 读取层 `CardRegistry.summary(id)` 的原始行（含首行"已加载 …"，本文件会剥掉） */
  readonly effectLines: readonly string[]
  readonly rarityName: string
  readonly rarityColor: string
  /** 归属文案；`null` = 无归属，不渲染 */
  readonly ownerLabel: string | null
}

/** 数值行：候选 = `STAT_ROW`，**词条存在即显示**（值为 0 也显示）；不在表里的键一律不显示 */
export function detailStatsOf(source: Readonly<Record<string, number>>): readonly DetailStatRow[] {
  const rows: DetailStatRow[] = []
  for (const look of STAT_ROW) {
    const value = source[look.stat]
    if (value === undefined) continue
    rows.push({ stat: look.stat, label: look.label, color: look.color, value })
  }
  return rows
}

/** 回放态的帧数值是 `{stat, value}[]`（按键名升序）⇒ 摊平成一张表，供数值行按 `STAT_ROW` 顺序取 */
function statRecordOfFrame(frame: FrameCard): Readonly<Record<string, number>> {
  const record: Record<string, number> = {}
  for (const entry of frame.stats) record[entry.stat] = entry.value
  return record
}

/**
 * 效果区的一行 → 分组。
 *
 * 读取层的回显行形如 `  [主动] …` / `  [被动 P10] …` / `  [技能 P5] …` / `  [光环] …`
 * （见 `cards/registry.ts`）；这里**只按前缀分组**，不改写文案。
 */
export function classifyEffectLine(line: string): DetailEffect['kind'] {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('[主动')) return 'active'
  if (trimmed.startsWith('[被动')) return 'passive'
  if (trimmed.startsWith('[技能')) return 'skill'
  if (trimmed.startsWith('[光环')) return 'aura'
  if (trimmed.startsWith('[附魔]')) return 'enchant'
  return 'skill'
}

/** 分组顺序：**主动在上、被动在下**、技能次之、光环最后、附魔附加组再最后（§4.3 ④；组内保持原书写顺序） */
const EFFECT_RANK: Readonly<Record<DetailEffect['kind'], number>> = {
  active: 0,
  passive: 1,
  skill: 2,
  aura: 3,
  enchant: 4,
}

/**
 * 当前生效的附魔（C4a；**只回放态有** —— 卡面不写 `enchant`，编辑态恒 `null`）。
 *
 * 显示名取 `enchantments[].name`，缺省回落 id；颜色取 `color`，缺省回落
 * `ENCHANT_FALLBACK_COLOR`（见 `theme/colors.ts`）。
 */
export function detailEnchantOf(card: Card, frame: FrameCard | undefined): DetailEnchant | null {
  const def = activeEnchantDefOf(card, frame)
  if (def === undefined) return null
  return { id: def.id, name: def.name ?? def.id, color: def.color ?? ENCHANT_FALLBACK_COLOR }
}

/** 回放态当前生效的**附魔定义**（`FrameCard.enchant` → `Card.enchantments` 里那一件） */
export function activeEnchantDefOf(card: Card, frame: FrameCard | undefined): EnchantDef | undefined {
  const id = frame?.enchant
  if (id === undefined) return undefined
  return (card.enchantments ?? []).find((enchant) => enchant.id === id)
}

/** 把一件附魔的三块效果摊成"效果区"行（行首标 `[附魔]`，与主动 / 被动同一列表） */
export function enchantEffectLines(enchant: EnchantDef): readonly string[] {
  const lines: string[] = []
  for (const [stat, value] of Object.entries(enchant.stats ?? {})) {
    lines.push(`[附魔] 属性 ${stat} ${value >= 0 ? '+' : ''}${String(value)}`)
  }
  if (enchant.aura !== undefined) {
    const select = typeof enchant.aura.select === 'string' ? enchant.aura.select : '查询选择器'
    const channels = [
      ...(enchant.aura.apply ?? []).map((entry) => `平铺 ${entry.stat}${entry.amount >= 0 ? '+' : ''}${String(entry.amount)}`),
      ...(enchant.aura.mul ?? []).map((entry) => `倍率 ${entry.stat}×${String(entry.factor)}`),
    ].join('、')
    lines.push(`[附魔] 光环 作用于 ${select}${channels.length > 0 ? `：${channels}` : ''}`)
  }
  for (const action of enchant.actions ?? []) {
    const target = action.target === undefined ? '' : ` → ${typeof action.target === 'string' ? action.target : '查询选择器'}`
    lines.push(`[附魔] 动作 ${action.do}${target}`)
  }
  return lines
}

/** 把读取层回显行切成"效果区"：剥掉首行（`已加载 …`）、合并附魔行、分组、稳定排序 */
export function detailEffectsOf(
  effectLines: readonly string[],
  enchantDef?: EnchantDef,
): readonly DetailEffect[] {
  const body = effectLines.slice(1) // 首行 = `已加载 卡名 v1:`，只用于回显标题
  const rows = body
    .map((line, index) => ({ line: line.trimStart(), index }))
    .filter((entry) => entry.line.length > 0)
    // `[附魔目录]` 是**目录**回显（"这张卡能有哪些附魔"），不是当前效果 —— 不进效果区
    .filter((entry) => !entry.line.startsWith('[附魔目录]'))
    .map((entry) => ({ kind: classifyEffectLine(entry.line), text: entry.line, index: entry.index }))
  // 当前生效附魔的三块效果：合成成 `[附魔] …` 行，接在末尾（kind 排序为最后一段）
  const enchantRows =
    enchantDef === undefined
      ? []
      : enchantEffectLines(enchantDef).map((text, at) => ({
          kind: 'enchant' as const,
          text,
          index: rows.length + at,
        }))
  return [...rows, ...enchantRows]
    .sort((left, right) => EFFECT_RANK[left.kind] - EFFECT_RANK[right.kind] || left.index - right.index)
    .map((entry) => ({ kind: entry.kind, text: entry.text }))
}

/** 编辑态的"基础充满周期"（交给引擎算：`cdp` 已计入；纯被动卡 ⇒ `null`） */
function basePeriodSeconds(card: Card): number | null {
  const [boardCard] = buildBoardCards(1, [{ card, slot: 1 }])
  if (boardCard === undefined) return null
  const periodCs = actionPeriodCs(boardCard)
  return Number.isFinite(periodCs) && periodCs > 0 ? csToSeconds(periodCs) : null
}

/** 组装悬浮窗的四区视图 */
export function buildCardDetail(input: BuildDetailInput): CardDetailView {
  const { card, frame, gauge } = input
  const statSource = frame === undefined ? card.stats : statRecordOfFrame(frame)

  let detailGauge: DetailGauge | null = null
  if (gauge !== undefined && gauge.periodCs !== null) {
    detailGauge = {
      periodSeconds: csToSeconds(gauge.periodCs),
      percent: gauge.ratio === null ? null : Math.round(gauge.ratio * 100),
      ready: gauge.ready,
      frozen: gauge.frozen,
    }
  } else if (gauge === undefined) {
    const period = basePeriodSeconds(card)
    if (period !== null) detailGauge = { periodSeconds: period, percent: null, ready: false, frozen: false }
  }

  const multicast = card.multicast === undefined || card.multicast <= 1 ? null : card.multicast

  return {
    title: card.name,
    enchant: detailEnchantOf(card, frame),
    rarity: { name: input.rarityName, color: input.rarityColor },
    description: card.description === undefined || card.description.length === 0 ? null : card.description,
    stats: detailStatsOf(statSource),
    gauge: detailGauge,
    effects: detailEffectsOf(input.effectLines, activeEnchantDefOf(card, frame)),
    foot: {
      tags: card.tags ?? [],
      owner: input.ownerLabel,
      span: slotsForCard(card),
      version: card.version,
      multicast,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 定位（§4.1：默认光标右下方，贴边自动翻转）
 * ------------------------------------------------------------------ */

export interface CursorPoint {
  readonly x: number
  readonly y: number
}
export interface Size {
  readonly width: number
  readonly height: number
}
export interface Placement {
  readonly left: number
  readonly top: number
}

/** 窗口与光标之间的间距 */
export const DETAIL_GAP_PX = 12

/** 窗口宽度（固定 360px，§4.2）—— 贴边翻转用它 */
export const DETAIL_WINDOW_WIDTH = 360
/**
 * 窗口高度的**估算值**（实际高度自适应、最大 480px）：贴边翻转与"夹进视口"都用它。
 * 取偏大的值 + 最后夹取 ⇒ 不会因为估小了而把窗口顶出屏幕。
 */
export const DETAIL_WINDOW_HEIGHT = 320

/**
 * 贴边翻转：默认右下；右侧放不下 ⇒ 翻到光标**左侧**；下方放不下 ⇒ 翻到光标**上方**；
 * 最后再夹进视口（`[0, 视口 − 窗口]`），保证窗口不会露到屏幕外。
 */
export function placeDetail(
  cursor: CursorPoint,
  viewport: Size,
  size: Size,
  gap = DETAIL_GAP_PX,
): Placement {
  const rightFits = cursor.x + gap + size.width <= viewport.width
  const downFits = cursor.y + gap + size.height <= viewport.height
  const rawLeft = rightFits ? cursor.x + gap : cursor.x - gap - size.width
  const rawTop = downFits ? cursor.y + gap : cursor.y - gap - size.height
  const maxLeft = Math.max(0, viewport.width - size.width)
  const maxTop = Math.max(0, viewport.height - size.height)
  return {
    left: Math.min(Math.max(0, rawLeft), maxLeft),
    top: Math.min(Math.max(0, rawTop), maxTop),
  }
}
