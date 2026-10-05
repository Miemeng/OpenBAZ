// 选择器（规则 §10）——封闭词表，写错即抛错
//
// 词表：self / ownPlayer / enemyPlayer / allOwnCards / allEnemyCards /
//       randomEnemyCard / randomOwnCard / adjacentToSelf / adjacentLeftSelf / adjacentRightSelf
import { activeCards, slotsOfBoardCard } from './board.ts'
import type { BattleState, BoardCard, PlayerId } from './types.ts'
import type { Rng } from './rng.ts'

/** 选择器求值上下文 */
export interface SelectContext {
  readonly state: BattleState
  readonly rng: Rng
  /** 动作来源卡（技能为玩家侧动作时无来源卡） */
  readonly self: BoardCard | null
  /**
   * 无来源卡时的 `self.<stat>` 取值来源：**技能自带 stats**（规则 §8.2 v0.10 决议——
   * 技能的效果数值同样禁止字面量、一律 `{ ref: self.<stat> }` 引用**本技能** stats）。
   * 只有卡牌动作时该字段无意义（此时 `self` 不为 null）。
   */
  readonly selfStats?: Readonly<Record<string, number>>
  readonly side: PlayerId
}

/** 选择结果：卡牌列表与玩家（词表里玩家类选择器一次只可能选到 0 或 1 个） */
export interface Selection {
  readonly cards: BoardCard[]
  readonly players: PlayerId[]
}

const EMPTY: Selection = { cards: [], players: [] }

/** 敌方编号（1 ↔ 2）。放在这里而不是 import state.ts，避免 selectors ↔ state 的循环依赖。 */
function enemyOf(side: PlayerId): PlayerId {
  return side === 1 ? 2 : 1
}

/** 某方场上未失效的卡（按 slot 升序 = 加载顺序） */
function ownCards(context: SelectContext, side: PlayerId): BoardCard[] {
  return activeCards(context.state.players[side].board)
}

/** 与来源卡"相邻"的卡：同侧、slot 区间相隔正好 1 格（规则 §1：相邻 = 同侧格子索引相邻） */
function adjacentCards(context: SelectContext, direction: 'both' | 'left' | 'right'): BoardCard[] {
  const self = context.self
  if (self === null) throw new Error('adjacentToSelf 类选择器只能用于卡牌动作（无来源卡）')
  const slots = context.state.players[self.owner].board
  const ownRange = slotSpan(self)
  return activeCards(slots).filter((other) => {
    if (other.instanceId === self.instanceId) return false
    const otherRange = slotSpan(other)
    const gapLeft = ownRange.from - otherRange.to
    const gapRight = otherRange.from - ownRange.to
    if (direction === 'left') return gapLeft === 1
    if (direction === 'right') return gapRight === 1
    return gapLeft === 1 || gapRight === 1
  })
}

function slotSpan(boardCard: BoardCard): { from: number; to: number } {
  const slots = slotsOfBoardCard(boardCard)
  return { from: boardCard.slot, to: boardCard.slot + slots - 1 }
}

/** 从数组里随机取一个（确定性：必须用战斗状态里的 rng） */
function pickRandom<T>(context: SelectContext, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined
  return items[context.rng.nextInt(items.length)]
}

/**
 * 求值一个选择器。
 * @throws 词表外的选择器名
 */
export function selectTargets(selector: string, context: SelectContext): Selection {
  switch (selector) {
    case 'self': {
      if (context.self === null) throw new Error('选择器 self 只能用于卡牌动作（无来源卡）')
      return { cards: [context.self], players: [] }
    }
    case 'ownPlayer':
      return { ...EMPTY, players: [context.side] }
    case 'enemyPlayer':
      return { ...EMPTY, players: [enemyOf(context.side)] }
    case 'allOwnCards':
      return { ...EMPTY, cards: ownCards(context, context.side) }
    case 'allEnemyCards':
      return { ...EMPTY, cards: ownCards(context, enemyOf(context.side)) }
    case 'randomOwnCard': {
      const picked = pickRandom(context, ownCards(context, context.side))
      return { ...EMPTY, cards: picked === undefined ? [] : [picked] }
    }
    case 'randomEnemyCard': {
      const picked = pickRandom(context, ownCards(context, enemyOf(context.side)))
      return { ...EMPTY, cards: picked === undefined ? [] : [picked] }
    }
    case 'adjacentToSelf':
      return { ...EMPTY, cards: adjacentCards(context, 'both') }
    case 'adjacentLeftSelf':
      return { ...EMPTY, cards: adjacentCards(context, 'left') }
    case 'adjacentRightSelf':
      return { ...EMPTY, cards: adjacentCards(context, 'right') }
    default:
      throw new Error(`未知选择器：${selector}（封闭词表见规则 §10）`)
  }
}
