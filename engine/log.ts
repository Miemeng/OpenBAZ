// 对局日志渲染（纯文本）＋分级消息（LogLevel / LogMessage）

// 设计约定：
// - 动作日志（ActionLog）的**唯一消费形态现在是纯文本行**，直接可读；
// - 但**结构化留接口**：ActionLog / ActionEffect 已是有固定字段的对象
//   ，将来客户端要结构化事件时直接消费它们即可，
//   无需解析这些文本行。**接口保留在 engine/types.ts，不在本文件。**
// - 分级消息：结构化记录里**只存 code + data**，
//   文案在本文件组装（`messageText`，唯一权威）；入账门槛走 `passesLogLevel`
//   （缺省 `note`）。渲染出的文本行里**带 code**，故日志文件同时可读可检索。
// - **引擎永不产出 ANSI 颜色**。
import type { ActionEffect } from './primitives.ts'
import type {
  ActionLog,
  BattleState,
  DotKind,
  LogLevel,
  LogMessage,
  PlayerId,
  BoardCard,
} from './types.ts'
import { renderRow, sizeLabel, slotsOfBoardCard } from './board.ts'
import { TRIGGER_FRAME_CS, csToSeconds } from './state.ts'

/**
 * 把秒数格式化成 `12.4s`（一位小数的展示精度；引擎内部时间是整数 cs）。
 *
 * 表现层专用：引擎任何地方都不得用小数秒参与计算。
 */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`
}

/** 卡牌在场上的定位串：`第3格` 或 `第3–4格`（供日志标明位置） */
export function slotLabel(boardCard: BoardCard): string {
  const from = boardCard.slot
  const to = from + slotsOfBoardCard(boardCard) - 1
  return from === to ? `第${String(from)}格` : `第${String(from)}–${String(to)}格`
}

/** 卡牌在日志里的显示名：`玩家A 的 cinder_wolf(第3格)` */
export function cardLabel(state: BattleState, boardCard: BoardCard): string {
  return `${state.players[boardCard.owner].name} 的 ${boardCard.card.id}(${slotLabel(boardCard)})`
}

/** 由 instanceId 反查场上卡（找不到就返回 null，日志降级为原始 id） */
function findCard(state: BattleState, instanceId: string): BoardCard | null {
  for (const side of [1, 2] as const) {
    const found = state.players[side].board.find((boardCard) => boardCard.instanceId === instanceId)
    if (found !== undefined) return found
  }
  return null
}

/** 行动主体名（卡牌 → `玩家A 的 xxx(第N格)`；技能 → `技能:xxx`；可持续效果 → 原样） */
function actorNameOf(state: BattleState, actor: string): string {
  if (actor.startsWith('技能') || actor.startsWith('持续效果')) return actor
  const baseId = actor.split('#')[0] ?? actor
  const boardCard = findCard(state, baseId)
  if (boardCard === null) return actor
  const suffix = actor.includes('#') ? ` 的被动#${actor.split('#')[1] ?? ''}` : ''
  return `${cardLabel(state, boardCard)}${suffix}`
}

const SIDE_SHORT: Record<PlayerId, string> = { 1: 'A', 2: 'B' }

/** 卡牌目标的安全显示名（targetSide 对卡牌效果恒有值，但仍做兜底以免越界读） */
function cardOwnerName(state: BattleState, effect: ActionEffect): string {
  return effect.card === undefined ? '?' : state.players[effect.card.owner].name
}

/** 渲染一条动作影响 */
function effectText(state: BattleState, effect: ActionEffect): string {
  const targetName = state.players[effect.targetSide].name

  if (effect.kind === 'damage') {
    if (effect.card !== undefined) {
      return `对 ${cardOwnerName(state, effect)} 的 ${effect.card.card.id} 广播受伤（卡牌无血量损失）`
    }
    const absorbed = effect.absorbed > 0 ? `护盾吸收 ${String(effect.absorbed)}、` : ''
    // 持续效果造成的伤害（灼烧 / 剧毒 / 毒与再生的净值）标注来源，与主动/被动效果直接造成的伤害区分
    const dotTag = effect.dots === undefined ? '' : `${dotSettlementName(effect.dots)}：`
    return `→ ${targetName}，${dotTag}${absorbed}血量 -${String(effect.amount)}（剩余 ${String(effect.hpAfter)}）${dotParts(effect)}`
  }
  if (effect.kind === 'heal') {
    const dotTag = effect.dots === undefined ? '' : `${dotSettlementName(effect.dots)}：`
    return `→ ${targetName}，${dotTag}回复 ${String(effect.amount)} 点血量（剩余 ${String(effect.hpAfter)}）${dotParts(effect)}`
  }
  if (effect.kind === 'shield') {
    return `→ ${targetName} 获得护盾 ${String(effect.amount)}（当前 ${String(effect.shieldAfter)}）`
  }
  if (effect.kind === 'stat') {
    if (effect.card !== undefined) {
      return `→ ${cardOwnerName(state, effect)} 的 ${effect.card.card.id} 的 ${effect.stat ?? '?'} +${String(effect.amount)}`
    }
    return `→ ${targetName} 施加持续效果 ${effect.dots?.[0] ?? effect.stat ?? '?'} ${String(effect.amount)} 层`
  }
  if (effect.kind === 'status') {
    return `→ ${effect.card?.card.id ?? '?'} 获得状态 ${effect.status ?? '?'}`
  }
  if (effect.kind === 'charge') {
    // amount 的单位是秒（充能只在 applyAction 内按秒求值，不量化成 cs）
    return `→ ${effect.card?.card.id ?? '?'} 行动条推进 ${String(effect.amount)} 秒`
  }
  if (effect.kind === 'destroy') {
    return `→ ${effect.card?.card.id ?? '?'} 失效（仍占位、不行动、被动停用）`
  }
  if (effect.kind === 'repair') {
    return `→ ${effect.card?.card.id ?? '?'} 修复`
  }
  if (effect.kind === 'enchant') {
    return `→ ${effect.card?.card.id ?? '?'} 附魔 ${effect.enchantId ?? '?'}（整件替换）`
  }
  // 走到这里说明 ActionEffect 新增了 kind 而本文件漏改。**故意不写穷尽检查**：
  // 若在此处写 `const x: never = effect`，收窄后的 effect 本身就是 never，赋值合法、
  // 检查形同虚设（TS2322 就是这么产生的）。真正的强制手段是返回类型标注 —— 函数声明了
  // `: string`，任何漏掉的 return 路径都会报 TS2366。故这里只做运行期兜底。
  return `未知效果类型：${JSON.stringify(effect)}`
}

/** 持续效果的中文名 */
function dotName(kind: DotKind): string {
  if (kind === 'burn') return '灼烧'
  return kind === 'poison' ? '剧毒' : '再生'
}

/**
 * 一次持续效果结算的名字：单种类直接用它自己的名字，剧毒与再生**合并净值**时用组合名。
 *
 * @param dots 本次到点的种类（固定顺序：burn → poison → regen）
 */
function dotSettlementName(dots: readonly DotKind[]): string {
  if (dots.length >= 2) return `${dotName(dots[0] ?? 'poison')}↔${dotName(dots[1] ?? 'regen')}净值`
  return `${dotName(dots[0] ?? 'burn')}跳变`
}

/** 净值结算的两个分量（只对剧毒+再生的合并结算显示，便于核对净值） */
function dotParts(effect: ActionEffect): string {
  if ((effect.dots?.length ?? 0) < 2) return ''
  return `（毒 ${String(effect.poisonStacks ?? 0)} / 再生 ${String(effect.regenStacks ?? 0)}）`
}

/** 动作来源的中文名 */
function sourceName(kind: ActionLog['sourceKind']): string {
  switch (kind) {
    case 'active':
      return '主动行动'
    case 'passive':
      return '被动触发'
    case 'skill':
      return '技能'
    case 'dot':
      return '持续效果'
  }
}

/**
 * 渲染一条日志为文本行。前缀统一为 `[t= 12|  2.4s]`，便于肉眼纵向对齐。
 *
 * 两级时钟：`log.tick` 是**触发帧序号**，故绝对时刻 = 触发帧 × TRIGGER_FRAME_CS。
 */
export function formatAction(state: BattleState, log: ActionLog): string[] {
  const absoluteCs = log.tick * TRIGGER_FRAME_CS
  const header = `[t=${String(log.tick).padStart(3, ' ')}|${formatSeconds(csToSeconds(absoluteCs)).padStart(6, ' ')}] `
  const sideTag = `[${SIDE_SHORT[log.actorSide]}方]`
  const ordinal = log.sourceKind === 'dot' ? '' : `#${String(log.ordinal)} `
  const title = `${header}${sideTag} ${ordinal}${sourceName(log.sourceKind)}：${actorNameOf(state, log.actor)}`

  if (log.effects.length === 0) return [`${title}（无目标）`]
  const lines = log.effects.map((effect) => `${header}          ${effectText(state, effect)}`)
  return [title, ...lines]
}

/** 渲染开局双方摆盘（一行 10 格、标明位置与尺寸） */
export function renderSetup(state: BattleState): string[] {
  const lines: string[] = []
  for (const side of [1, 2] as const) {
    const player = state.players[side]
    lines.push(`${player.name}（血量 ${String(player.hp)}）`)
    lines.push(...renderRow(player.board, '  ── 一行 10 格 ──'))
    const cards = [...player.board]
      .sort((a, b) => a.slot - b.slot)
      .map((boardCard) => `${boardCard.card.id}[${sizeLabel(boardCard.card.size)}/${String(slotsOfBoardCard(boardCard))}格 @${slotLabel(boardCard)}]`)
    lines.push(`  摆盘：${cards.length === 0 ? '（空）' : cards.join('  ')}`)
    lines.push('')
  }
  return lines
}

// ————————————————————————————————————————————————————————
// 分级消息（类型见 engine/types.ts 的 LogLevel / MessageCode / LogMessage）
// ————————————————————————————————————————————————————————

/** 级别标签（定宽 5 字符，便于纵向对齐） */
const LEVEL_TAG: Readonly<Record<LogLevel, string>> = {
  error: 'ERROR',
  warn: ' WARN',
  note: ' NOTE',
  info: ' INFO',
  debug: 'DEBUG',
}

/** 级别序（大 = 严重）。记录规则：`RANK[level] >= RANK[threshold]` */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { error: 4, warn: 3, note: 2, info: 1, debug: 0 }

/** 默认记录阈值（`BattleOptions.logLevel` 的缺省值）：只丢弃 `info` / `debug` */
export const DEFAULT_LOG_LEVEL: LogLevel = 'note'

/** 级别词表（全部合法取值，顺序 = 从严重到轻）。CLI 校验与错误文案都读它 */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'note', 'info', 'debug']

/** 解析级别名（宿主层 CLI 用）。不合法即抛错，错误文案自带合法取值清单 */
export function parseLogLevel(text: string): LogLevel {
  for (const level of LOG_LEVELS) {
    if (level === text) return level
  }
  throw new Error(`未知日志级别：${text}（合法取值：${LOG_LEVELS.join(' / ')}）`)
}

/**
 * 是否达到记录阈值。**这是全项目唯一的级别比较入口** —— 引擎与宿主都调用它，
 * 避免各处自写 `>=` 而把级别顺序写反。
 */
export function passesLogLevel(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold]
}

/** 从 `data` 取字符串参数（缺失渲染成 `?`，不把 undefined 漏进日志） */
function dataText(message: LogMessage, key: string): string {
  const value = message.data?.[key]
  return value === undefined ? '?' : String(value)
}

/**
 * 光环条目的展示值。
 *
 * 台账里 `mul` 通道存的是 `factor − 1`（好让倍率之间直接相加），故展示时要加回 1：
 * `apply` 通道显示 `+2` / `-1`（负数 = 削弱），`mul` 通道显示 `×1.5`。
 */
function auraValueText(message: LogMessage): string {
  const raw = Number(message.data?.['amount'] ?? 0)
  if (message.data?.['channel'] === 'mul') return `×${String(Number((raw + 1).toFixed(2)))}`
  return raw >= 0 ? `+${String(raw)}` : String(raw)
}

/**
 * 消息文案（**`MessageCode` 的唯一权威**）。
 *
 * 契约：只读 `message.data` / `message.actor`，**不读写任何状态**。返回类型标注为 `string`，
 * 任何漏掉的 code 分支都会被 TS2366 拦住（与 `effectText` 同一手法）。
 */
export function messageText(message: LogMessage): string {
  switch (message.code) {
    case 'skill.no_trigger_no_aura':
      return `技能 ${dataText(message, 'skill')} 既没有触发器（trigger）也没有光环（aura），整局不会有任何结算`
    case 'selector.type_mismatch':
      // 文案与"抛出异常中止对局"的新政策对齐。
      // 具体原因（哪个原语 / 哪种类型不匹配）由求值处写在 `detail` 里 —— 消息只存 code + 参数，
      // 文案的唯一权威仍是本函数。
      return `选择器 ${dataText(message, 'selector')} 的目标类型不匹配：${dataText(message, 'detail')}（对局已中止）`
    case 'selector.sort_key_ignored':
      return dataText(message, 'text')
    case 'aura.dot_warning':
      return `光环向 ${dataText(message, 'target')} 施加持续效果 ${dataText(message, 'dot')}（暂定允许，请确认是否为本意）`
    case 'aura.entered':
      return `光环生效：${dataText(message, 'target_name')} 的 ${dataText(message, 'stat')} ${auraValueText(message)}`
    case 'aura.exited':
      return `光环退场：${dataText(message, 'target_name')} 的 ${dataText(message, 'stat')} ${auraValueText(message)}`
    case 'stack_limit.truncated':
      return `${dataText(message, 'stat')} 已达层数上限 ${dataText(message, 'limit')}，本次叠加被截断`
  }
}

/**
 * 渲染一条分级消息为文本行。
 *
 * 前缀口径与 `formatAction` 一致（`[t= 12|  2.4s]`），其后依次是：级别标签、可选阵营、
 * 可选行动主体、**消息码**、文案 —— code 落进文本是刻意的：日志文件要能按码检索。
 */
export function formatMessage(state: BattleState, message: LogMessage): string {
  const absoluteCs = message.tick * TRIGGER_FRAME_CS
  const header = `[t=${String(message.tick).padStart(3, ' ')}|${formatSeconds(csToSeconds(absoluteCs)).padStart(6, ' ')}] `
  const side = message.side === undefined ? '' : `[${SIDE_SHORT[message.side]}方] `
  const actor = message.actor === undefined ? '' : `${actorNameOf(state, message.actor)} `
  return `${header}[${LEVEL_TAG[message.level]}] ${side}${actor}${message.code}：${messageText(message)}`
}
