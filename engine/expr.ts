// 表达式求值与条件判定

// 封闭引用表：
//   self.atk / self.<stat>  该卡 stats 当前值（含 buff）
//   self.speed              该卡当前速度倍率（含状态）
//   self.hp                 该卡"生命"——卡牌无血量，恒为 0，保留引用以免校验报错
//   own_player.hp / hp_pct / shield      本方玩家
//   enemy_player.hp / hp_pct / shield    敌方玩家
//   { var: <name> }         本次触发事件携带的参数
//   { count: <Selector> }   满足选择器的目标数量
import { effectiveDotStacks, effectiveStat, speedMultiplier } from './state.ts'
import { selectTargets, type FilterResolver, type SelectContext } from './selectors.ts'
import type {
  BattleState,
  BoardCard,
  Condition,
  DotKind,
  Expr,
  LogLevel,
  PlayerId,
  PlayerState,
  SelectorQuery,
} from './types.ts'

// ————————————————————————————————————————————————————————
// 类型守卫

// 这些守卫是**必需的**，不是风格偏好：`Expr` 是"数字 | 各种对象"的联合，
// 而 `'add' in expr` 这类收窄在含 `readonly Expr[]` 递归成员的联合上不能可靠工作
// （tsc 会把 `expr.add` 推断为 `Expr` 而非 `Expr[]`，报 TS2322/TS2365）。
// 显式守卫让每个分支的类型一次到位。
// ————————————————————————————————————————————————————————

function hasKey<K extends string>(value: object, key: K): value is Record<K, unknown> {
  return key in value
}

function isRef(value: Expr): value is { readonly ref: string } {
  return typeof value === 'object' && value !== null && hasKey(value, 'ref')
}

function isVar(value: Expr): value is { readonly var: string } {
  return typeof value === 'object' && value !== null && hasKey(value, 'var')
}

function isCount(value: Expr): value is { readonly count: string | SelectorQuery } {
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
  /**
   * 本次触发事件携带的参数，如 amount / player / card / source_side
   * （a-lite：除数值与字符串外，事件参数也可以是**引用**——卡牌实例与玩家）
   */
  readonly vars: Readonly<Record<string, number | string | BoardCard | PlayerState>>
  /**
   * `filter` 内的 `this` 引用根：
   * 当前候选目标——选卡牌时是 `BoardCard`，`zone: player` 时是玩家编号。
   *
   * 除 `filter` 之外，**光环顶层 `condition` 也会绑定 `this`**（= 光环来源卡，
   * ）⇒ `this` 本身**不再是"正在 filter 里"的判据**，
   * 该判据改用 `inFilter`。
   */
  readonly this?: BoardCard | PlayerId
  /**
   * 是否正在求值某个 `filter`（ 第 6 条：`filter` 内禁止嵌套选择器）。
   * 由 `evaluateCardFilter` 逐候选绑定，`{ count: ... }` 用它判断自己是否身处 `filter`。
   */
  readonly inFilter?: boolean
  /**
   * 记录阈值（`BattleOptions.logLevel`）。
   *
   * **为什么求值上下文需要它**：`{ count: ... }` 选玩家要在**求值期**记一条
   * `error` 级消息再抛错，而"记不记"由阈值决定。上下文是**每次动作结算现建**的，
   * 故把当下的阈值随上下文一起传下去，省掉给队列与投放队列的动作再穿一个参数。
   * 阈值只影响"看不看得见"，绝不参与判定（不消耗 rng、不写判定字段）。
   */
  readonly logLevel?: LogLevel
  readonly ownPlayer: PlayerState
  readonly enemyPlayer: PlayerState
}

/**
 * 求值结果——带类型标签。
 *
 * 数值表达式（四则 / `{ count }` / 数值引用与参数）仍然产出 `number`；
 * 引用型表达式产出**指针**：`self` 与 `{ var: card }` → 卡牌实例，
 * `own_player` / `enemy_player` 与 `{ var: player }` → 玩家对象，
 * 阵营与字符串型参数 → `string`。
 *
 * 类型约束（校验期报错、运行期同样抛错）：
 * - `lt` / `lte` / `gt` / `gte` 只接受两侧都是 `number`；
 * - `eq` / `neq` 接受两侧同类型（number、string、card、player），**两侧类型不一致即报错**。
 */
export type ExprValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'card'; readonly card: BoardCard }
  | { readonly kind: 'player'; readonly player: PlayerState }

/** 卡牌顶层字段型引用（不是 stats 里的自定义数值） */
const CARD_FIELD_REFS = new Set(['cooldown', 'multicast', 'slot_index'])

/**
 * 卡牌实例的字段读数 —— `self.<字段>` / `{ var: card.<字段> }` **共用同一张表**：
 * `speed`（当前速度倍率）· `cooldown` · `multicast` · `slot_index`（**0 基**，引擎内部 slot 从 1 起）·
 * `hp`（卡牌无血量，恒 0，保留以免校验报错），其余一律按 `effectiveStat` 读 stats 有效值
 * （含局内 buff 与光环派生态）。
 *
 * **写法是平铺的一层**：`atk` 而不是 `stats.atk`（`stats` 这一级在引用里不出现）。
 */
function cardFieldOf(boardCard: BoardCard, name: string, context: EvalContext): number {
  if (name === 'speed') return speedMultiplier(boardCard)
  if (name === 'hp') return 0
  if (name === 'cooldown') return boardCard.card.cooldown
  if (name === 'multicast') return boardCard.card.multicast ?? 1
  if (name === 'slot_index') return boardCard.slot - 1
  return effectiveStat(context.state, boardCard, name)
}

/** `self.<name>` 求值。有来源卡走卡牌；无来源卡但有 stats（技能）走技能 stats。 */
function resolveSelfRef(name: string, context: EvalContext): number {
  const self = context.self

  if (self !== null) return cardFieldOf(self, name, context)

  const stats = context.selfStats
  if (stats !== undefined) {
    // 技能无行动条、无占格，故不含卡牌专属字段
    if (CARD_FIELD_REFS.has(name) || name === 'speed') {
      throw new Error(`引用 self.${name} 是卡牌专属字段，技能（无来源卡）不能使用`)
    }
    const value = stats[name]
    if (typeof value === 'number') return value
    if (value === undefined) throw new Error(`技能 stats 未定义字段：self.${name}`)
    throw new Error(`技能 stats.${name} 不是数值：${String(value)}`)
  }

  throw new Error(`引用 self.${name} 既无来源卡也无技能 stats，无法求值`)
}

/**
 * 玩家侧的持续效果层数。
 *
 * 读的是**派生态层数**（`Σ 该种类实例 stacks + 光环贡献`，见 `effectiveDotStacks`）：
 * 条件比较与"算伤害用的层数"必须是同一个读数，否则光环加了层数却不影响条件。
 *
 * 灼烧层数是 唯一保留小数的累加器，**对外读取一律四舍五入取整**
 * （条件比较也是对外读取，否则 `burn >= 1` 会因为 0.8 层而失真）。
 */
function dotStacks(state: BattleState, player: PlayerState, field: string): number {
  const kind: DotKind = field === 'burn' ? 'burn' : field === 'poison' ? 'poison' : 'regen'
  return effectiveDotStacks(state, player, kind)
}

/**
 * `this.<name>` 求值：**只在 `filter` 内合法**。
 *
 * **带类型标签**，因为 `this.id` / `this.instance_id` / `this.tags` 是字符串型
 * （用 `eq` / `neq` 与字符串字面量比较，例如 `{ cmp: 'eq', left: { ref: 'this.id' }, right: 'cinder_wolf' }`），
 * 其余字段是数值型。
 *
 * 数值字段（卡牌候选）：`this.<stat>`（走 `effectiveStat`，含局内修正与光环层，与结算同一读数）、
 * `this.speed`（当前速度倍率）、`this.cooldown` / `this.multicast`、`this.slot_index`（0 基）、
 * `this.hp`（卡牌无血量，恒 0，保留以免校验报错）、`this.destroyed`（1 / 0）。
 * 字符串字段：`this.id`（**卡面 id**，如 `cinder_wolf`）、`this.instance_id`（**本局唯一 id**）、
 * `this.tags`（字符串数组，只参与 `eq` / `neq`）。
 * 玩家候选（`zone: player`）：`this.hp` / `max_hp` / `hp_pct` / `shield` / `burn` / `poison` / `regen`。
 *
 * 注意 TS 内部字段名是 camelCase 的 `instanceId`，而**作者可见的引用名**一律小写下划线
 * （`this.instance_id`）—— 二者只在这一处对应关系里交汇。
 */
function resolveThisRef(name: string, context: EvalContext): number {
  const candidate = context.this

  if (typeof candidate === 'number') {
    // `zone: player` 的候选：沿用玩家侧封闭字段表（与 own_player.<field> 同一实现）
    return resolvePlayerRef(context.state, context.state.players[candidate], name)
  }

  if (candidate !== undefined) {
    if (name === 'speed') return speedMultiplier(candidate)
    if (name === 'hp') return 0 // 卡牌无血量
    if (name === 'cooldown') return candidate.card.cooldown
    if (name === 'multicast') return candidate.card.multicast ?? 1
    if (name === 'slot_index') return candidate.slot - 1 // 0 基对外口径
    if (name === 'destroyed') return candidate.destroyed ? 1 : 0
    if (name === 'id' || name === 'instance_id' || name === 'tags') {
      throw new Error(`引用 this.${name} 是字符串型，只能参与 eq / neq 比较，不能当数值用`)
    }
    // 其余一律按卡牌 stats 的有效值读（含 buff）。
    // **拼写保护**：`effectiveStat` 对未定义的 stat 会兜底成 0（ 对 `self.<stat>` 的宽松口径），
    // 但 filter 引用不存在的字段属**硬失败**（ 第 10 条：`this.nope` 必须当场发现），
    // 故这里先自查卡面 stats。
    if (candidate.card.stats[name] === undefined) {
      throw new Error(
        `filter 引用了不存在的字段 this.${name}（卡牌 ${candidate.card.id} 的 stats 里没有该字段； 第 10 条）`,
      )
    }
    return effectiveStat(context.state, candidate, name)
  }

  throw new Error(
    'this 引用此处不可用：只在本选择器的 query.filter 内、或卡牌光环的 condition 内合法' +
      '',
  )
}

/** `this.<name>` 的字符串型分支（`this.id` / `this.instance_id` / `this.tags`） */
function resolveThisRefValue(name: string, context: EvalContext): ExprValue {
  const candidate = context.this
  if (candidate === undefined) {
    throw new Error('引用 this 需要 this 引用根（filter 候选目标或光环来源卡），此处不可用')
  }
  if (typeof candidate === 'number') {
    if (name === 'instance_id' || name === 'id' || name === 'tags') {
      // 玩家候选没有牌名 / 实例 id；此时 this.<name> 属书写错误
      throw new Error(`引用 this.${name} 只对卡牌候选有效`)
    }
    return { kind: 'number', value: resolveThisRef(name, context) }
  }
  // `this.tags` 是数组：用逗号连接成稳定字符串，`eq` 与同一个字面量比较即"标签集合完全一致"
  if (name === 'tags') return { kind: 'string', value: (candidate.card.tags ?? []).join(',') }
  if (name === 'id') return { kind: 'string', value: candidate.card.id }
  if (name === 'instance_id') return { kind: 'string', value: candidate.instanceId }
  return { kind: 'number', value: resolveThisRef(name, context) }
}

function resolveRef(ref: string, context: EvalContext): number {
  // self.<stat> / self.speed / self.cooldown / ...
  if (ref.startsWith('self.')) return resolveSelfRef(ref.slice('self.'.length), context)

  // this.<field>
  if (ref === 'this') throw new Error('引用 this 需要 this 引用根（filter 候选目标或光环来源卡），此处不可用')
  if (ref.startsWith('this.')) return resolveThisRef(ref.slice('this.'.length), context)

  // 全场/单侧场上卡牌数量
  if (ref === 'cards_on_board') return countCards(context, 'both')
  if (ref === 'own_cards_on_board') return countCards(context, 'own')
  if (ref === 'enemy_cards_on_board') return countCards(context, 'enemy')

  if (ref.startsWith('own_player.')) {
    return resolvePlayerRef(context.state, context.ownPlayer, ref.slice('own_player.'.length))
  }
  if (ref.startsWith('enemy_player.')) {
    return resolvePlayerRef(context.state, context.enemyPlayer, ref.slice('enemy_player.'.length))
  }
  throw new Error(`未知引用：${ref}`)
}

/** 类型守卫：事件参数里的卡牌实例与玩家对象（a-lite 的引用型参数） */
function isBoardCardValue(value: unknown): value is BoardCard {
  return typeof value === 'object' && value !== null && 'instanceId' in value && 'card' in value
}

function isPlayerStateValue(value: unknown): value is PlayerState {
  return typeof value === 'object' && value !== null && 'hp' in value && 'maxHp' in value && 'shield' in value
}

/**
 * 引用（`{ ref: ... }`）求值**带类型标签**。
 *
 * 裸名 `self` / `own_player` / `enemy_player` 只在引用型位置可用（数值位置仍报"未知引用"）；
 * `this.<field>` 先在这里分流（字符串型字段原样返回字符串）；
 * 其余形态（`self.<stat>`、`own_player.<field>`、三个计数）一律是数值，转交 `resolveRef`。
 */
function resolveRefValue(ref: string, context: EvalContext): ExprValue {
  if (ref === 'self') {
    if (context.self === null) throw new Error('引用 self 需要来源卡，技能（无来源卡）不能用它做比较')
    return { kind: 'card', card: context.self }
  }
  if (ref === 'this') {
    const candidate = context.this
    if (candidate === undefined) {
      throw new Error('引用 this 需要 this 引用根（filter 候选目标或光环来源卡），此处不可用')
    }
    return typeof candidate === 'number'
      ? { kind: 'player', player: context.state.players[candidate] }
      : { kind: 'card', card: candidate }
  }
  if (ref.startsWith('this.')) return resolveThisRefValue(ref.slice('this.'.length), context)
  if (ref === 'own_player') return { kind: 'player', player: context.ownPlayer }
  if (ref === 'enemy_player') return { kind: 'player', player: context.enemyPlayer }
  return { kind: 'number', value: resolveRef(ref, context) }
}

/**
 * 事件参数（`{ var: ... }`）求值**带类型标签**。
 *
 * 两种写法：
 * 1. **平铺参数名** —— `{ var: amount }` / `{ var: card }` / `{ var: player }`；
 * 2. **对象取属性** —— `{ var: card.atk }` / `{ var: player.hp_pct }`：对引用型参数
 *    （卡牌实例 / 玩家对象）取属性，**字段表与 `self.<字段>` / `this.<字段>` 同一张**。
 *
 * ⚠️ **只能一层**：`card.atk` 合法，`card.stats.atk` **不合法**（`stats` 这一级在引用里不出现
 * —— 与 `self.atk` 同一口径）。
 */
function resolveVarValue(name: string, context: EvalContext): ExprValue {
  // `{ var: <参数名>.<字段> }`：先按首个点号切分，再对参数值取属性
  const dot = name.indexOf('.')
  if (dot > 0) {
    const base = name.slice(0, dot)
    const field = name.slice(dot + 1)
    const subject = context.vars[base]
    if (subject === undefined) throw new Error(`事件参数 ${base} 不存在（见参数表设计.md）`)
    if (isBoardCardValue(subject)) {
      return { kind: 'number', value: cardFieldOf(subject, field, context) }
    }
    if (isPlayerStateValue(subject)) {
      return { kind: 'number', value: resolvePlayerRef(context.state, subject, field) }
    }
    throw new Error(`事件参数 ${base} 不是卡牌 / 玩家引用，不能用 ${name} 取属性`)
  }

  const value = context.vars[name]
  if (value === undefined) throw new Error(`事件参数 ${name} 不存在（见参数表设计.md）`)
  if (typeof value === 'number') return { kind: 'number', value }
  if (typeof value === 'string') return { kind: 'string', value }
  if (isBoardCardValue(value)) return { kind: 'card', card: value }
  if (isPlayerStateValue(value)) return { kind: 'player', player: value }
  throw new Error(`事件参数 ${name} 的类型无法识别：${JSON.stringify(value)}`)
}

/** 取数值：非数值的求值结果在数值位置一律报错（a-lite 的类型约束） */
function expectNumber(value: ExprValue, where: string): number {
  if (value.kind === 'number') return value.value
  throw new Error(`${where} 需要数值，但得到 ${value.kind} 类型的引用`)
}

/**
 * 求值一个表达式并保留类型标签。
 *
 * 只有 `cmp` 的判定需要区分类型（`eq` / `neq` 可用于引用），其余位置一律走 `evaluateExpr`。
 */
export function evaluateValue(expr: Expr, context: EvalContext): ExprValue {
  if (typeof expr === 'number') return { kind: 'number', value: expr }
  if (typeof expr === 'string') return { kind: 'string', value: expr }
  if (isRef(expr)) return resolveRefValue(expr.ref, context)
  if (isVar(expr)) return resolveVarValue(expr.var, context)
  return { kind: 'number', value: evaluateExpr(expr, context) }
}

/** 场上卡牌计数（复用 selectors 的 self / all_own_cards / all_enemy_cards 三个选择器） */
function countCards(context: EvalContext, whose: 'own' | 'enemy' | 'both'): number {
  if (whose === 'both') return countCards(context, 'own') + countCards(context, 'enemy')
  return selectTargets(whose === 'own' ? 'all_own_cards' : 'all_enemy_cards', context).cards.length
}

function resolvePlayerRef(state: BattleState, player: PlayerState, field: string): number {
  switch (field) {
    case 'hp':
      return player.hp
    case 'max_hp':
      return player.maxHp
    case 'hp_pct':
      // 除零保护：maxHp 为 0 时视为满血，避免产生 NaN 污染确定性
      return player.maxHp === 0 ? 1 : player.hp / player.maxHp
    case 'shield':
      return player.shield
    case 'burn':
    case 'poison':
    case 'regen':
      return dotStacks(state, player, field)
    default:
      throw new Error(`未知玩家引用：${field}（可用：hp / max_hp / hp_pct / shield / burn / poison / regen）`)
  }
}

/** `{ count: ... }` 的玩家侧选择器 */
const PLAYER_COUNT_SELECTORS: readonly string[] = ['own_player', 'enemy_player', 'all_players']

/** `{ count: ... }` 选到的是不是玩家 */
function countsPlayers(selector: string | SelectorQuery): boolean {
  if (typeof selector === 'string') return PLAYER_COUNT_SELECTORS.includes(selector)
  return selector.zone === 'player'
}

/** 选择器文本（只用于报错 / 记账；`primitives.ts` 有同名实现，这里避免循环依赖而就地展开） */
function countSelectorText(selector: string | SelectorQuery): string {
  if (typeof selector === 'string') return selector
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector)) {
    parts.push(`${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
  }
  return `{ ${parts.join(', ')} }`
}

/**
 * `{ count: ... }` 求值。
 *
 * 接受**字符串缩写或查询对象**，走**完整求值管线**（候选池 → destroyed → tags / filter →
 * 洗牌或排序 → limit），最后**只取结果里的卡牌数**（`limit` 生效）。
 * **选玩家**（`zone: player` / `own_player` / `enemy_player` / `all_players`）= 契约错误：
 * 先记一条 error 级 `selector.type_mismatch`，再抛错。
 */
function countTargets(selector: string | SelectorQuery, context: EvalContext): number {
  //  第 6 条：`filter` 内禁止嵌套选择器。判据是 `inFilter`（由 `evaluateCardFilter`
  // 逐候选绑定）**不能再用 `this !== undefined`**：光环顶层 `condition` 也会绑定 `this`
  // ，那时 `{ count: ... }` 是合法写法。
  if (context.inFilter === true) {
    const nested = 'filter 内禁止嵌套选择器（`{ count }` 不能出现在 filter 里）'
    reportSelectorMismatch(context, countSelectorText(selector), nested)
    throw new Error(`${nested}`)
  }
  if (countsPlayers(selector)) {
    const detail = '`{ count: ... }` 只统计卡牌数量，不能使用玩家侧选择器'
    reportSelectorMismatch(context, countSelectorText(selector), detail)
    throw new Error(`${detail}（选择器 ${countSelectorText(selector)}； /  第 11 条）`)
  }
  return selectTargets(selector, context).cards.length
}

/**
 * 记一条 `selector.type_mismatch`。
 *
 * 记账实现由调用方注入（`engine/tick.ts` 的 `makeContext` 传 `engine/messages.ts` 的
 * `recordSelectorMismatch`）—— 本文件不认识 `BattleState.messages` 的写入细节，也不产生循环依赖。
 */
function reportSelectorMismatch(context: EvalContext, selector: string, detail: string): void {
  context.mismatchReporter?.({
    tick: context.tick,
    side: context.side,
    ...(context.self === null ? {} : { actor: context.self.instanceId }),
    selector,
    detail,
  })
}

/** 求值一个表达式 */
export function evaluateExpr(expr: Expr, context: EvalContext): number {
  if (typeof expr === 'number') return expr
  if (typeof expr === 'string') {
    throw new Error(`数值位置不能使用字符串字面量：${expr}（字符串只用于 eq / neq 比较）`)
  }
  if (isRef(expr)) return resolveRef(expr.ref, context)
  if (isVar(expr)) return expectNumber(resolveVarValue(expr.var, context), `事件参数 ${expr.var}`)
  if (isCount(expr)) return countTargets(expr.count, context)
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

/**
 * `eq` / `neq` 的**同类型**比较（a-lite）：
 * 卡牌比 `instanceId`（同一张实例），玩家比对象身份，数值与字符串比字面量。
 */
function sameValue(left: ExprValue, right: ExprValue): boolean {
  if (left.kind === 'number' && right.kind === 'number') return left.value === right.value
  if (left.kind === 'string' && right.kind === 'string') return left.value === right.value
  if (left.kind === 'card' && right.kind === 'card') return left.card.instanceId === right.card.instanceId
  if (left.kind === 'player' && right.kind === 'player') return left.player === right.player
  throw new Error(`eq / neq 两侧类型不一致：${left.kind} 与 ${right.kind}`)
}

/** 比较（a-lite 类型规则）：四个序比较符只吃数值；`eq` / `neq` 还接受同类型的引用与字符串 */
function compareValues(cmp: string, left: ExprValue, right: ExprValue): boolean {
  const comparator = COMPARATORS[cmp]
  if (comparator === undefined) throw new Error(`未知比较符：${cmp}`)
  if (left.kind === 'number' && right.kind === 'number') return comparator(left.value, right.value)
  if (cmp === 'eq' || cmp === 'neq') {
    const equal = sameValue(left, right)
    return cmp === 'eq' ? equal : !equal
  }
  throw new Error(`比较符 ${cmp} 需要两侧都是数值，但得到 ${left.kind} 与 ${right.kind}`)
}

/** 判定条件。缺省（undefined）= 恒真。 */
export function evaluateCondition(condition: Condition | undefined, context: EvalContext): boolean {
  if (condition === undefined) return true
  if ('cmp' in condition) {
    return compareValues(condition.cmp, evaluateValue(condition.left, context), evaluateValue(condition.right, context))
  }
  if ('not' in condition) return !evaluateCondition(condition.not, context)
  if ('any' in condition) return condition.any.some((item) => evaluateCondition(item, context))
  return condition.all.every((item) => evaluateCondition(item, context))
}

/**
 * 选择器 `filter` 的求值入口（交给 `engine/selectors.ts` 逐候选调用）。
 *
 * **为什么在这里**：`selectors.ts` 不能 import 本文件（会形成循环依赖），所以它把 filter 求值
 * 声明成回调（`FilterResolver`），由 `engine/tick.ts` 在构造上下文时接上本函数 —— 于是
 * `filter` 里的条件与 `trigger.condition`、动作数值走的是**同一份** `evaluateCondition` 实现。
 *
 * `this` 绑定为当前候选（卡牌候选是 `BoardCard`，`zone: player` 时是玩家编号），
 * 并置 `inFilter` 标记 —— `{ count: ... }` 靠它判断"自己是否身处 filter"。
 */
export const evaluateCardFilter: FilterResolver = (condition, context, candidate) =>
  evaluateCondition(condition, { ...context, this: candidate, inFilter: true })
