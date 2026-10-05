// 表达式求值与条件判定（规则 §8）
//
// 封闭引用表（规则 §8.3）：
//   self.atk / self.<stat>  该卡 stats 当前值（含 buff）
//   self.speed              该卡当前速度倍率（含状态）
//   self.hp                 该卡"生命"——卡牌无血量，恒为 0，保留引用以免校验报错
//   ownPlayer.hp / hpPct / shield      本方玩家
//   enemyPlayer.hp / hpPct / shield    敌方玩家
//   { var: <name> }         本次触发事件携带的参数（《参数表设计.md》）
//   { count: <Selector> }   满足选择器的目标数量（规则 §10）
import { effectiveStat, speedMultiplier } from './state.ts'
import { selectTargets, type SelectContext } from './selectors.ts'
import type { Condition, Expr, PlayerState } from './types.ts'

// ————————————————————————————————————————————————————————————
// 类型守卫
//
// 这些守卫是**必需的**，不是风格偏好：`Expr` 是"数字 | 各种对象"的联合，
// 而 `'add' in expr` 这类收窄在含 `readonly Expr[]` 递归成员的联合上不能可靠工作
// （tsc 会把 `expr.add` 推断为 `Expr` 而非 `Expr[]`，报 TS2322/TS2365）。
// 显式守卫让每个分支的类型一次到位。
// ————————————————————————————————————————————————————————————

function hasKey<K extends string>(value: object, key: K): value is Record<K, unknown> {
  return key in value
}

function isRef(value: Expr): value is { readonly ref: string } {
  return typeof value === 'object' && value !== null && hasKey(value, 'ref')
}

function isVar(value: Expr): value is { readonly var: string } {
  return typeof value === 'object' && value !== null && hasKey(value, 'var')
}

function isCount(value: Expr): value is { readonly count: string } {
  return typeof value === 'object' && value !== null && hasKey(value, 'count')
}

function isAdd(value: Expr): value is { readonly add: readonly Expr[] } {
  return typeof value === 'object' && value !== null && hasKey(value, 'add')
}

function isSub(value: Expr): value is { readonly sub: readonly Expr[] } {
  return typeof value === 'object' && value !== null && hasKey(value, 'sub')
}

function isMul(value: Expr): value is { readonly mul: readonly Expr[] } {
  return typeof value === 'object' && value !== null && hasKey(value, 'mul')
}

function isDiv(value: Expr): value is { readonly div: readonly Expr[] } {
  return typeof value === 'object' && value !== null && hasKey(value, 'div')
}

/** 求值上下文：一次动作结算所需的全部可见信息 */
export interface EvalContext extends SelectContext {
  /** 本次触发事件携带的参数，如 amount / player / card */
  readonly vars: Readonly<Record<string, number | string>>
  readonly ownPlayer: PlayerState
  readonly enemyPlayer: PlayerState
}

/** 卡牌顶层字段型引用（不是 stats 里的自定义数值） */
const CARD_FIELD_REFS = new Set(['cooldown', 'multicast', 'slotIndex'])

/** `self.<name>` 求值。有来源卡走卡牌；无来源卡但有 stats（技能）走技能 stats（规则 §8.2 v0.10）。 */
function resolveSelfRef(name: string, context: EvalContext): number {
  const self = context.self

  if (self !== null) {
    if (name === 'speed') return speedMultiplier(self)
    if (name === 'hp') return 0 // 卡牌无血量（规则 §2：血量是玩家的）
    if (name === 'cooldown') return self.card.cooldown
    if (name === 'multicast') return self.card.multicast ?? 1
    // 规则 §8.3 的 slotIndex 是 0–9，而引擎内部 slot 从 1 起（对外显示也是第 1 格）
    if (name === 'slotIndex') return self.slot - 1
    return effectiveStat(self, name) // 含战斗内 buff 的实时值
  }

  const stats = context.selfStats
  if (stats !== undefined) {
    // 技能无行动条、无占格，故不含卡牌专属字段
    if (CARD_FIELD_REFS.has(name) || name === 'speed') {
      throw new Error(`引用 self.${name} 是卡牌专属字段，技能（无来源卡）不能使用`)
    }
    const value = stats[name]
    if (typeof value === 'number') return value
    if (value === undefined) throw new Error(`技能 stats 未定义字段：self.${name}（规则 §8.3 要求已定义）`)
    throw new Error(`技能 stats.${name} 不是数值：${String(value)}`)
  }

  throw new Error(`引用 self.${name} 既无来源卡也无技能 stats，无法求值`)
}

/**
 * 玩家侧的持续效果层数（规则 §8.3：ownPlayer.burn / poison / regen）。
 *
 * 灼烧层数是规则 §14 唯一保留小数的累加器，**对外读取一律四舍五入取整**
 * （条件比较也是对外读取，否则 `burn >= 1` 会因为 0.8 层而失真）。
 */
function dotStacks(player: PlayerState, field: string): number {
  const kind = field === 'burn' ? 'burn' : field === 'poison' ? 'poison' : 'regen'
  const dot = player.dots.find((instance) => instance.kind === kind)
  return dot === undefined ? 0 : Math.round(dot.stacks)
}

function resolveRef(ref: string, context: EvalContext): number {
  // self.<stat> / self.speed / self.cooldown / ...（规则 §8.3 封闭引用表）
  if (ref.startsWith('self.')) return resolveSelfRef(ref.slice('self.'.length), context)

  // 全场/单侧场上卡牌数量（规则 §8.3 三条：cardsOnBoard / ownCardsOnBoard / enemyCardsOnBoard）
  if (ref === 'cardsOnBoard') return countCards(context, 'both')
  if (ref === 'ownCardsOnBoard') return countCards(context, 'own')
  if (ref === 'enemyCardsOnBoard') return countCards(context, 'enemy')

  if (ref.startsWith('ownPlayer.')) {
    return resolvePlayerRef(context.ownPlayer, ref.slice('ownPlayer.'.length))
  }
  if (ref.startsWith('enemyPlayer.')) {
    return resolvePlayerRef(context.enemyPlayer, ref.slice('enemyPlayer.'.length))
  }
  throw new Error(`未知引用：${ref}（封闭引用表见规则 §8.3）`)
}

/** 场上卡牌计数（复用 selectors 的 self / allOwnCards / allEnemyCards 三个选择器） */
function countCards(context: EvalContext, whose: 'own' | 'enemy' | 'both'): number {
  if (whose === 'both') return countCards(context, 'own') + countCards(context, 'enemy')
  return selectTargets(whose === 'own' ? 'allOwnCards' : 'allEnemyCards', context).cards.length
}

function resolvePlayerRef(player: PlayerState, field: string): number {
  switch (field) {
    case 'hp':
      return player.hp
    case 'maxHp':
      return player.maxHp
    case 'hpPct':
      // 除零保护：maxHp 为 0 时视为满血，避免产生 NaN 污染确定性
      return player.maxHp === 0 ? 1 : player.hp / player.maxHp
    case 'shield':
      return player.shield
    case 'burn':
    case 'poison':
    case 'regen':
      return dotStacks(player, field)
    default:
      throw new Error(`未知玩家引用：${field}（可用：hp / maxHp / hpPct / shield / burn / poison / regen）`)
  }
}

/** 求值一个表达式（规则 §8.2） */
export function evaluateExpr(expr: Expr, context: EvalContext): number {
  if (typeof expr === 'number') return expr
  if (isRef(expr)) return resolveRef(expr.ref, context)
  if (isVar(expr)) {
    const value = context.vars[expr.var]
    if (typeof value === 'number') return value
    if (value === undefined) throw new Error(`事件参数 ${expr.var} 不存在（见参数表设计.md）`)
    throw new Error(`事件参数 ${expr.var} 不是数值（${value}）`)
  }
  if (isCount(expr)) return selectTargets(expr.count, context).cards.length
  if (isAdd(expr)) return expr.add.reduce((sum: number, item) => sum + evaluateExpr(item, context), 0)
  if (isSub(expr)) {
    const [first, ...rest] = expr.sub
    if (first === undefined) throw new Error('sub 至少需要一个参数')
    return rest.reduce((value: number, item) => value - evaluateExpr(item, context), evaluateExpr(first, context))
  }
  if (isMul(expr)) return expr.mul.reduce((product: number, item) => product * evaluateExpr(item, context), 1)
  if (isDiv(expr)) {
    const [first, ...rest] = expr.div
    if (first === undefined) throw new Error('div 至少需要一个参数')
    return rest.reduce((value: number, item) => {
      const divisor = evaluateExpr(item, context)
      if (divisor === 0) throw new Error('div 除数为 0')
      return value / divisor
    }, evaluateExpr(first, context))
  }
  throw new Error(`无法识别的表达式：${JSON.stringify(expr)}`)
}

const COMPARATORS: Record<string, (left: number, right: number) => boolean> = {
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  eq: (left, right) => left === right,
  neq: (left, right) => left !== right,
}

/** 判定条件（规则 §8.1）。缺省（undefined）= 恒真。 */
export function evaluateCondition(condition: Condition | undefined, context: EvalContext): boolean {
  if (condition === undefined) return true
  if ('cmp' in condition) {
    const comparator = COMPARATORS[condition.cmp]
    if (comparator === undefined) throw new Error(`未知比较符：${condition.cmp}`)
    return comparator(evaluateExpr(condition.left, context), evaluateExpr(condition.right, context))
  }
  if ('not' in condition) return !evaluateCondition(condition.not, context)
  if ('any' in condition) return condition.any.some((item) => evaluateCondition(item, context))
  return condition.all.every((item) => evaluateCondition(item, context))
}
