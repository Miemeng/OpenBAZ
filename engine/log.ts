// 对局日志渲染（纯文本）
//
// 设计约定（RW 确认）：
// - 日志的**唯一消费形态现在是纯文本行**，直接可读；
// - 但**结构化留接口**：ActionLog / ActionEffect 已是有固定字段的对象
//   （不遍历对象键 —— AGENT.md §7），将来客户端要结构化事件时直接消费它们即可，
//   无需解析这些文本行。**接口保留在 engine/tick.ts 的 ActionLog，不在本文件。**
import type { ActionEffect } from './primitives.ts'
import type { ActionLog, BattleState, DotKind, PlayerId, BoardCard } from './types.ts'
import { renderRow, sizeLabel, slotsOfBoardCard } from './board.ts'
import { TRIGGER_FRAME_CS, csToSeconds } from './state.ts'

/**
 * 把秒数格式化成 `12.4s`（一位小数的展示精度；引擎内部时间是整数 cs）。
 *
 * 表现层专用：引擎任何地方都不得用小数秒参与计算（规则 §14）。
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
function actorLabel(state: BattleState, log: ActionLog): string {
  if (log.actor.startsWith('技能') || log.actor.startsWith('持续效果')) return log.actor
  const baseId = log.actor.split('#')[0] ?? log.actor
  const boardCard = findCard(state, baseId)
  if (boardCard === null) return log.actor
  const suffix = log.actor.includes('#') ? ` 的被动#${log.actor.split('#')[1] ?? ''}` : ''
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
    // 持续效果造成的伤害（灼烧 / 剧毒）标注来源，与主动/被动效果直接造成的伤害区分
    const dotTag = effect.dot === undefined ? '' : `${dotName(effect.dot)}跳伤：`
    return `→ ${targetName}，${dotTag}${absorbed}血量 -${String(effect.amount)}（剩余 ${String(effect.hpAfter)}）`
  }
  if (effect.kind === 'heal') {
    const dotTag = effect.dot === undefined ? '' : `${dotName(effect.dot)}：`
    return `→ ${targetName}，${dotTag}回复 ${String(effect.amount)} 点血量（剩余 ${String(effect.hpAfter)}）`
  }
  if (effect.kind === 'shield') {
    return `→ ${targetName} 获得护盾 ${String(effect.amount)}（当前 ${String(effect.shieldAfter)}）`
  }
  if (effect.kind === 'stat') {
    if (effect.card !== undefined) {
      return `→ ${cardOwnerName(state, effect)} 的 ${effect.card.card.id} 的 ${effect.stat ?? '?'} +${String(effect.amount)}`
    }
    return `→ ${targetName} 施加持续效果 ${effect.dot ?? effect.stat ?? '?'} ${String(effect.amount)} 层`
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
 * 两级时钟：`log.tick` 是**触发帧序号**（0.2s 一帧），故绝对时刻 = 触发帧 × TRIGGER_FRAME_CS。
 */
export function formatAction(state: BattleState, log: ActionLog): string[] {
  const absoluteCs = log.tick * TRIGGER_FRAME_CS
  const header = `[t=${String(log.tick).padStart(3, ' ')}|${formatSeconds(csToSeconds(absoluteCs)).padStart(6, ' ')}] `
  const sideTag = `[${SIDE_SHORT[log.actorSide]}方]`
  const ordinal = log.sourceKind === 'dot' ? '' : `#${String(log.ordinal)} `
  const title = `${header}${sideTag} ${ordinal}${sourceName(log.sourceKind)}：${actorLabel(state, log)}`

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
