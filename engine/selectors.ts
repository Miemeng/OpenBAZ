// 选择器——两种写法语义完全等价：

// ① **字符串缩写**（13 条，永不废弃）：self / own_player / enemy_player / all_players /
//    all_own_cards / all_enemy_cards / all_cards / random_own_card / random_enemy_card /
//    adjacent_to_self / adjacent_left_self / adjacent_right_self / event_card；
// ② **查询对象**（`SelectorQuery`）：候选池 → destroyed → tags → filter → 洗牌或排序 → limit。

// 错误政策：**契约 / 书写错误一律抛异常**；
// **合法选择器但零目标 = 静默**（不报错、不记消息、不进 rng）。

// 确定性契约：
// - `random: true` 走战斗 rng 的 Fisher–Yates 洗牌（算法本身是对外契约 —— 实现就是
//   `engine/rng.ts` 的 `Rng.shuffle`：`for i = n-1 … 1: j = nextInt(i + 1); swap`），
//   等价缩写与查询对象**逐位 rng 一致**（`random_own_card` ≡ `{ side: own, random: true, limit: 1 }`）；
// - 排序稳定，平局兜底键：`side`（own 先）→ `slot` 升序 → `instanceId` 升序；
// - 空结果**不进入 rng**（洗牌在长度为 0 / 1 时消耗 0 次随机）。
import { activeCards, slotsOfBoardCard } from './board.ts'
import { effectiveStat, speedMultiplier } from './state.ts'
import type { BattleState, BoardCard, Condition, PlayerId, PlayerState, SelectorQuery } from './types.ts'
import type { Rng } from './rng.ts'

/**
 * 逐候选条件（`filter`）的求值回调。
 *
 * **为什么是回调而不是直接 import `evaluateCondition`**：`engine/expr.ts` 已经 import 了本文件
 * 的 `selectTargets`（`{ count: ... }` 要数卡牌），本文件再 import 回去就形成循环依赖。
 * 调用方（`engine/expr.ts`）在运行时注入，求值语义与 `{ ref }` / `{ count }` 完全同一份实现。
 * 上下文**原样传入**（不换 `side`）：`this` 是唯一的"候选相对"引用根，见 `passesFilter`。
 */
export type FilterResolver = (
  condition: Condition,
  context: SelectContext,
  candidate: BoardCard | PlayerId,
) => boolean

/** 选择器求值上下文 */
export interface SelectContext {
  readonly state: BattleState
  readonly rng: Rng
  /** 动作来源卡（技能为玩家侧动作时无来源卡；`self` / `adjacent_*` / `from: self` 都读它） */
  readonly self: BoardCard | null
  /** 当前触发帧序号（0 = 开局初始化阶段）。只用于记账消息的 `LogMessage.tick`，不参与判定 */
  readonly tick: number
  /**
   * 无来源卡时的 `self.<stat>` 取值来源：**技能自带 stats**（  决议
   * 技能的效果数值同样禁止字面量、一律 `{ ref: self.<stat> }` 引用**本技能** stats）。
   * 只有卡牌动作时该字段无意义（此时 `self` 不为 null）。
   */
  readonly selfStats?: Readonly<Record<string, number>>
  readonly side: PlayerId
  /**
   * 本次触发事件携带的参数。
   * 供 `filter` 里的 `{ var: ... }` 使用；引擎里没有生产者的参数一律**不存在**
   * （`{ var: X }` 仍会抛"事件参数不存在"）。`source` = 事件来源卡（技能触发时不存在）。
   *
   * 值域含 `PlayerState`：`player` 这类 player_ref 参数在本引擎里就是**玩家对象**
   * （与 `{ ref: 'own_player' }` 同一表示，才能用 `eq` / `neq` 比较）。
   */
  readonly vars: Readonly<Record<string, number | string | BoardCard | PlayerState>>
  /**
   * 动作发起方 / 敌方的玩家状态（从 `state.players` 取，随 `side` 一起给出）。
   *
   * 放在这里而不是让求值器自己取：`filter` 求值需要完整的求值上下文
   * （`engine/expr.ts` 的 `EvalContext` 扩展本接口），而它跨文件传递时不应丢字段。
   * **它们始终是"动作发起方"的视角**，不随 `filter` 的候选目标改变。
   */
  readonly ownPlayer: PlayerState
  readonly enemyPlayer: PlayerState
  /** `filter` 求值器（见 `FilterResolver` 的说明） */
  readonly filterResolver?: FilterResolver
  /** 记一条 NOTE（目前用于 第 3 条：`zone: player` 上的卡牌专属排序键） */
  readonly notify?: (text: string) => void
  /**
   * 记一条 `error` 级 `selector.type_mismatch`。
   * 由 `engine/tick.ts` 注入 `engine/messages.ts` 的 `recordSelectorMismatch`；
   * `{ count: ... }` 选玩家等"求值期就能发现"的契约错误会用它。
   */
  readonly mismatchReporter?: (report: SelectorMismatchReport) => void
}

/** 选择结果：卡牌列表与玩家 */
export interface Selection {
  readonly cards: BoardCard[]
  readonly players: PlayerId[]
}

/**
 * 一条 `selector.type_mismatch` 的全部上下文。
 *
 * 定义在本文件（而不是 `engine/messages.ts`）是为了**避开循环依赖**：
 * `messages.ts` → `log.ts` → `types.ts` 与 `expr.ts` 都依赖本文件，
 * 而本文件不依赖它们中的任何一个。`messages.ts` 的 `SelectorMismatchInput` 结构上兼容它。
 */
export interface SelectorMismatchReport {
  readonly tick: number
  readonly side?: PlayerId
  readonly actor?: string
  readonly selector: string
  readonly detail: string
}

/** 候选池（按 `zone` 分拣成两种目标；`from` 分支不走这里） */
interface Selected {
  readonly cards: BoardCard[]
  readonly players: PlayerId[]
}

const EMPTY: Selection = { cards: [], players: [] }

/** 全部合法查询对象字段（决定"未知查询字段 = 抛错"的封闭词表） */
const QUERY_FIELDS: readonly string[] = [
  'side',
  'zone',
  'from',
  'relative',
  'direction',
  'tags',
  'tagMode',
  'filter',
  'destroyed',
  'sort',
  'random',
  'limit',
]

/** 格位类排序键（`slot_index_*` 是 0 基对外口径的同义写法） */
const SLOT_ASC = new Set(['slot_asc', 'slot_index_asc'])
const SLOT_DESC = new Set(['slot_desc', 'slot_index_desc'])
/** 玩家专属排序键 */
const PLAYER_SORT_KEYS = new Set(['hp_asc', 'hp_desc', 'hp_pct_asc', 'hp_pct_desc', 'shield_asc', 'shield_desc'])
/** 其余保留键：卡牌专属的速度 / 行动条（玩家池上出现 = 忽略并记 NOTE） */
const OTHER_RESERVED_SORT_KEYS = new Set(['speed_asc', 'speed_desc', 'gauge_asc', 'gauge_desc'])

/** 敌方编号（1 ↔ 2）。放在这里而不是 import state.ts 的 `opponentOf`，与既有写法保持一致。 */
function enemyOf(side: PlayerId): PlayerId {
  return side === 1 ? 2 : 1
}

/** 某方场上未失效的卡（按 slot 升序 = 加载顺序） */
function ownCards(state: BattleState, side: PlayerId): BoardCard[] {
  return activeCards(state.players[side].board)
}

/** 双方存活玩家（**不含已败方** `hp ≤ 0`，；顺序恒为 1 → 2） */
function livePlayers(state: BattleState): PlayerId[] {
  const alive: PlayerId[] = []
  for (const side of [1, 2] as const) {
    if (state.players[side].hp > 0) alive.push(side)
  }
  return alive
}

/** 候选池（`side` × `zone`；`from` 分支不走这里） */
function candidatesOf(query: SelectorQuery, context: SelectContext, side: PlayerId): Selected {
  const whose = query.side ?? 'own'
  const zone = query.zone ?? 'cards'

  if (zone === 'player') {
    const players = whose === 'both' ? livePlayers(context.state) : [whose === 'own' ? side : enemyOf(side)]
    return { cards: [], players }
  }

  const cards = whose === 'both'
    ? [...ownCards(context.state, 1), ...ownCards(context.state, 2)]
    : ownCards(context.state, whose === 'own' ? side : enemyOf(side))
  return { cards, players: [] }
}

// ————————————————————————————————————————————————————————
// 候选池过滤
// ————————————————————————————————————————————————————————

/** 标签筛选：`any` = 命中任一（缺省），`all` = 必须全部命中；`hiddenTags` 不参与 */
function matchesTags(boardCard: BoardCard, tags: readonly string[], mode: 'any' | 'all'): boolean {
  const own = boardCard.card.tags ?? []
  if (mode === 'all') return tags.every((tag) => own.includes(tag))
  return tags.some((tag) => own.includes(tag))
}

/** 按 `destroyed` 取值过滤失效卡 */
function matchesDestroyed(boardCard: BoardCard, destroyed: 'exclude' | 'include' | 'only'): boolean {
  if (destroyed === 'include') return true
  if (destroyed === 'only') return boardCard.destroyed
  return !boardCard.destroyed
}

// ————————————————————————————————————————————————————————
// 排序
// ————————————————————————————————————————————————————————

/** 平局兜底键：`side`（own 先）→ `slot` 升序 → `instanceId` 升序 */
function tieBreak(left: BoardCard, right: BoardCard, side: PlayerId): number {
  if (left.owner !== right.owner) return left.owner === side ? -1 : 1
  if (left.slot !== right.slot) return left.slot - right.slot
  if (left.instanceId === right.instanceId) return 0
  return left.instanceId < right.instanceId ? -1 : 1
}

/**
 * 排序键的词形判定：`<name>_asc` / `<name>_desc`，且 `<name>` 非空。
 *
 * 形参收 `unknown`：`sort` 来自（将来由 YAML 装载的）数据，词形判定要在**运行期**真的成立，
 * 而不是只依赖类型注解。
 */
function isSortKeyShape(key: unknown): boolean {
  if (typeof key !== 'string') return false
  if (key.endsWith('_desc')) return key.length > '_desc'.length
  if (key.endsWith('_asc')) return key.length > '_asc'.length
  return false
}

/** 排序键里的 stat 名（`<stat>_asc` / `<stat>_desc`） */
function statOfSortKey(key: string): string {
  return key.slice(0, key.length - (key.endsWith('_desc') ? '_desc'.length : '_asc'.length))
}

/** 主键比较器：`card` 分支会先做拼写保护 */
function comparatorFor(
  key: string,
  cards: readonly BoardCard[],
  state: BattleState,
  side: PlayerId,
): (left: BoardCard, right: BoardCard) => number {
  if (SLOT_ASC.has(key)) return (left, right) => tieBreak(left, right, side)
  if (SLOT_DESC.has(key)) {
    return (left, right) => {
      if (left.slot !== right.slot) return right.slot - left.slot
      return tieBreak(left, right, side)
    }
  }

  const sign = key.endsWith('_desc') ? -1 : 1
  let stat: string
  if (key === 'speed_asc' || key === 'speed_desc') {
    stat = 'speed'
  } else if (key === 'gauge_asc' || key === 'gauge_desc') {
    return (left, right) => {
      if (left.gaugeCs !== right.gaugeCs) return sign * (left.gaugeCs - right.gaugeCs)
      return tieBreak(left, right, side)
    }
  } else {
    stat = statOfSortKey(key)
    // 拼写保护：`<stat>` 必须在该卡的 stats 里存在
    for (const boardCard of cards) {
      if (boardCard.card.stats[stat] === undefined) {
        throw new Error(
          `未知排序键：${key}（卡牌 ${boardCard.card.id} 的 stats 里没有 ${stat}； /  拼写保护）`,
        )
      }
    }
  }

  return (left, right) => {
    const a = stat === 'speed' ? speedMultiplier(left) : effectiveStat(state, left, stat)
    const b = stat === 'speed' ? speedMultiplier(right) : effectiveStat(state, right, stat)
    if (a !== b) return sign * (a - b)
    return tieBreak(left, right, side)
  }
}

/**
 * 玩家专属排序键的比较器。
 *
 * `slot_asc` / `slot_index_asc` 这类"保留键"对**玩家池**没有实际含义（玩家没有格位）：
 * 读取值恒为 0 ⇒ 两个玩家打平 ⇒ 落到兜底键（本方优先 → id 升序）。这里**不能**返回别的数值键，
 * 否则玩家池会按一个与请求的键无关的量排序（旧实现误用 `-shield` 兜底）。
 */
function playerComparator(key: string, context: SelectContext): (left: PlayerId, right: PlayerId) => number {
  const read = (player: PlayerId): number => {
    const target = context.state.players[player]
    switch (key) {
      case 'hp_asc':
        return target.hp
      case 'hp_desc':
        return -target.hp
      case 'hp_pct_asc':
        return target.maxHp === 0 ? 1 : target.hp / target.maxHp
      case 'hp_pct_desc':
        return -(target.maxHp === 0 ? 1 : target.hp / target.maxHp)
      case 'shield_asc':
        return target.shield
      case 'shield_desc':
        return -target.shield
      default:
        return 0
    }
  }
  return (left, right) => {
    const a = read(left)
    const b = read(right)
    if (a !== b) return a - b
    if (left !== right) return left === context.side ? -1 : 1
    return 0
  }
}

/** 排序键是否明确属于"卡牌专属"（玩家池上出现 = 忽略并记 NOTE） */
function isCardOnlySortKey(key: string): boolean {
  if (SLOT_ASC.has(key) || SLOT_DESC.has(key)) return false // 格位对玩家池同样可用（等价于 id 兜底）
  if (OTHER_RESERVED_SORT_KEYS.has(key)) return true
  if (PLAYER_SORT_KEYS.has(key)) return false
  return key.endsWith('_asc') || key.endsWith('_desc')
}

// ————————————————————————————————————————————————————————
// 查询对象校验
// ————————————————————————————————————————————————————————

/** 与 `from` 互斥的字段 */
const FROM_EXCLUSIVE_FIELDS: readonly string[] = [
  'side',
  'zone',
  'tags',
  'tagMode',
  'filter',
  'sort',
  'limit',
  'random',
  'destroyed',
]

/**
 * 校验查询对象。**任何书写错误都抛错**。
 * 第 9 / 12 条（原语 × 目标类型）在 `engine/primitives.ts`，第 11 条（`{ count }` 选玩家）在 `engine/expr.ts`。
 */
export function validateQuery(query: SelectorQuery): void {
  for (const field of Object.keys(query)) {
    if (!QUERY_FIELDS.includes(field)) {
      throw new Error(
        `未知的选择器查询字段：${field}（合法字段：${QUERY_FIELDS.join(' / ')}； /  第 1 条）`,
      )
    }
  }

  const side = query.side
  if (side !== undefined && side !== 'own' && side !== 'enemy' && side !== 'both') {
    throw new Error(`未知的 side 取值：${String(side)}（合法取值：own / enemy / both）`)
  }
  const zone = query.zone
  if (zone !== undefined && zone !== 'cards' && zone !== 'player') {
    throw new Error(`未知的 zone 取值：${String(zone)}（合法取值：cards / player）`)
  }

  const tagMode = query.tagMode
  if (tagMode !== undefined && tagMode !== 'any' && tagMode !== 'all') {
    throw new Error(`未知的 tagMode 取值：${String(tagMode)}（合法取值：any / all）`)
  }
  if (query.tags !== undefined) {
    if (!Array.isArray(query.tags) || query.tags.some((tag) => typeof tag !== 'string')) {
      throw new Error('tags 必须是字符串数组')
    }
  }

  const destroyed = query.destroyed
  if (destroyed !== undefined && destroyed !== 'exclude' && destroyed !== 'include' && destroyed !== 'only') {
    throw new Error(`未知的 destroyed 取值：${String(destroyed)}（合法取值：exclude / include / only）`)
  }

  if (query.random !== undefined && typeof query.random !== 'boolean') {
    throw new Error(`random 必须是布尔值，收到 ${String(query.random)}`)
  }

  const limit = query.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`limit 必须是正整数，收到 ${String(limit)}`)
  }

  // 排序键的词形：保留键与开放数值键**一律**是 `<name>_asc` / `<name>_desc`。
  // 先在这里判词形，`comparatorFor` 才能安全地按后缀取升降序；`<stat>` 是否真的存在于
  // 卡牌 stats 属"数据相关"的拼写保护，只能在拿到候选卡后判（见 comparatorFor）。
  const sort = query.sort
  if (sort !== undefined && !isSortKeyShape(sort)) {
    throw new Error(
      `未知排序键：${String(sort)}（写法是 <stat>_asc / <stat>_desc；` +
        '保留键：slot_asc / slot_desc / slot_index_asc / slot_index_desc / speed_asc / speed_desc / ' +
        'gauge_asc / gauge_desc / hp_asc / hp_desc / hp_pct_asc / hp_pct_desc / shield_asc / shield_desc；' +
        ' /  第 1 条）',
    )
  }

  const relative = query.relative
  if (relative !== undefined && relative !== 'adjacent') {
    throw new Error(`未知的 relative 取值：${String(relative)}（合法取值：adjacent）`)
  }
  const direction = query.direction
  if (direction !== undefined && direction !== 'both' && direction !== 'left' && direction !== 'right') {
    throw new Error(`未知的 direction 取值：${String(direction)}（合法取值：both / left / right）`)
  }

  // `from` 分支：只允许再带 relative / direction
  if (query.from !== undefined) {
    if (query.from !== 'self' && query.from !== 'event') {
      throw new Error(`未知的 from 取值：${String(query.from)}（合法取值：self / event）`)
    }
    const conflicts = FROM_EXCLUSIVE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(query, field))
    if (conflicts.length > 0) {
      throw new Error(`from 只能与 relative / direction 同用，不能再写 ${conflicts.join(' / ')}`)
    }
  }

  // `relative` / `direction` 缺 `from`
  if (query.from === undefined) {
    if (relative !== undefined) throw new Error('relative 必须与 from 同用')
    if (direction !== undefined) throw new Error('direction 必须与 relative 同用')
  }
  if (query.from !== undefined && direction !== undefined && relative === undefined) {
    throw new Error('direction 必须与 relative 同用')
  }

  // `random: true` 与 `sort` 同写
  if (query.random === true && query.sort !== undefined) {
    throw new Error('random: true 与 sort 不能同时写')
  }

  // `zone: player` 配 `tags` / `destroyed`
  if (zone === 'player' && query.tags !== undefined) {
    throw new Error('zone: player 没有标签维度，不能与 tags 同用')
  }
  if (zone === 'player' && destroyed !== undefined) {
    throw new Error('zone: player 没有失效维度，不能与 destroyed 同用')
  }
}

// ————————————————————————————————————————————————————————
// 求值
// ————————————————————————————————————————————————————————

/** 事件来源卡是不是一个卡牌实例（对 `unknown` 收窄，避免 `any`） */
function isBoardCard(value: unknown): value is BoardCard {
  return typeof value === 'object' && value !== null && 'instanceId' in value && 'card' in value
}

/** 与来源卡"相邻"的卡：同侧、slot 区间相隔正好 1 格 */
function adjacentCards(source: BoardCard, direction: 'both' | 'left' | 'right', context: SelectContext): BoardCard[] {
  const ownRange = slotSpan(source)
  return activeCards(context.state.players[source.owner].board).filter((other) => {
    if (other.instanceId === source.instanceId) return false
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

/**
 * `{ from: ... }` 分支：直接产出 0 或 1 个目标（两处旧实现都会**抛错**，
 * 按  的对照表与「合法选择器但零目标 = 静默」改为返回空选择）。
 */
function selectFrom(
  from: 'self' | 'event',
  relative: 'adjacent' | undefined,
  direction: 'both' | 'left' | 'right',
  context: SelectContext,
): Selection {
  const source = from === 'self' ? context.self : (context.vars?.['source'] ?? null)
  if (!isBoardCard(source)) return EMPTY
  if (relative === 'adjacent') return { ...EMPTY, cards: adjacentCards(source, direction, context) }
  return { ...EMPTY, cards: [source] }
}

/**
 * `filter` 的逐候选判定。
 *
 * **上下文原样传入**（只额外把候选绑定到 `this`，由 `FilterResolver` 的实现负责）：
 * `own_player` / `enemy_player` / `self` 在 `filter` 里**仍是动作发起方的视角**，
 * 只有 `this.<...>` 是"候选自己"。 只规定 `this` 的语义，
 * 故这里不擅自把 `side` 换成候选所属方（否则 `filter` 里的 `own_player.hp` 会随候选翻面）。
 */
function passesFilter(filter: Condition, context: SelectContext, candidate: BoardCard | PlayerId): boolean {
  const resolver = context.filterResolver
  if (resolver === undefined) {
    throw new Error('选择器 filter 需要注入 filterResolver（engine/expr.ts 的 selectTargets 已注入）')
  }
  return resolver(filter, context, candidate)
}

/**
 * 求值一个查询对象：
 * 候选池（`from` 分支例外）→ `destroyed` → `tags` / `tagMode` → `filter` → 洗牌或排序 → `limit`。
 *
 * @throws 契约 / 书写错误；合法但零目标返回空选择，**静默**（不记消息、不进 rng）
 */
export function evaluateQuery(query: SelectorQuery, context: SelectContext): Selection {
  validateQuery(query)

  if (query.from !== undefined) {
    return selectFrom(query.from, query.relative, query.direction ?? 'both', context)
  }

  // —— 1. 候选池
  const zone = query.zone ?? 'cards'
  const pool = candidatesOf(query, context, context.side)
  if (pool.cards.length === 0 && pool.players.length === 0) return EMPTY

  // —— 2. 过滤：destroyed → tags / tagMode → filter
  let items: (BoardCard | PlayerId)[] = zone === 'player' ? [...pool.players] : [...pool.cards]
  if (zone === 'cards') {
    const destroyed = query.destroyed ?? 'exclude'
    const tags = query.tags
    const tagMode = query.tagMode ?? 'any'
    const filter = query.filter
    items = (items as BoardCard[]).filter((boardCard) => {
      if (!matchesDestroyed(boardCard, destroyed)) return false
      if (tags !== undefined && tags.length > 0 && !matchesTags(boardCard, tags, tagMode)) return false
      if (filter !== undefined && !passesFilter(filter, context, boardCard)) return false
      return true
    })
  } else if (query.filter !== undefined) {
    const filter = query.filter
    items = (items as PlayerId[]).filter((player) => passesFilter(filter, context, player))
  }

  // —— 3. 取值前处理：random: true 时洗牌（契约 Fisher–Yates），否则按 sort 排序
  if (query.random === true) {
    // 洗牌算法就是对外契约本身——实现即 `Rng.shuffle`
    // （从后往前的 Fisher–Yates，`j = nextInt(i + 1)`）；长度 0 / 1 时消耗 0 次随机。
    context.rng.shuffle(items)
  } else if (items.length > 1) {
    const sortKey = query.sort ?? 'slot_asc'
    if (zone === 'player') {
      if (isCardOnlySortKey(sortKey)) {
        // 第 3 条：玩家池 + 卡牌专属排序键 = 忽略该键（按兜底键定序）
        context.notify?.(`zone: player 上的排序键 ${sortKey} 是卡牌专属键，本次忽略`)
      } else {
        // `zone === 'player'` ⇒ 池里只可能是玩家编号，此处收窄是类型安全的
        const playerItems = items as PlayerId[]
        playerItems.sort(playerComparator(sortKey, context))
      }
    } else {
      const comparator = comparatorFor(sortKey, items as BoardCard[], context.state, context.side)
      items.sort((left, right) => comparator(left as BoardCard, right as BoardCard))
    }
  }

  // —— 4. 取值：limit 截取前 N（缺省全取）
  const limit = query.limit ?? items.length
  const taken = items.slice(0, limit)
  if (zone === 'player') return { cards: [], players: taken as PlayerId[] }
  return { cards: taken as BoardCard[], players: [] }
}

/** 字符串缩写 → 等价的查询对象 */
function queryOfShorthand(selector: string): SelectorQuery | null {
  switch (selector) {
    case 'self':
      return { from: 'self' }
    case 'event_card':
      return { from: 'event' }
    case 'own_player':
      return { zone: 'player', side: 'own' }
    case 'enemy_player':
      return { zone: 'player', side: 'enemy' }
    case 'all_players':
      return { zone: 'player', side: 'both' }
    case 'all_own_cards':
      return { side: 'own' }
    case 'all_enemy_cards':
      return { side: 'enemy' }
    case 'all_cards':
      return { side: 'both' }
    case 'random_own_card':
      return { side: 'own', random: true, limit: 1 }
    case 'random_enemy_card':
      return { side: 'enemy', random: true, limit: 1 }
    case 'adjacent_to_self':
      return { from: 'self', relative: 'adjacent' }
    case 'adjacent_left_self':
      return { from: 'self', relative: 'adjacent', direction: 'left' }
    case 'adjacent_right_self':
      return { from: 'self', relative: 'adjacent', direction: 'right' }
    default:
      return null
  }
}

/** 13 条字符串缩写（对外可见的封闭词表；校验器与报错文案都读它） */
export const SELECTOR_SHORTHANDS: readonly string[] = [
  'self',
  'own_player',
  'enemy_player',
  'all_players',
  'all_own_cards',
  'all_enemy_cards',
  'all_cards',
  'random_own_card',
  'random_enemy_card',
  'adjacent_to_self',
  'adjacent_left_self',
  'adjacent_right_self',
  'event_card',
]

/**
 * 求值一个选择器。
 *
 * @throws 词表外的选择器名，或查询对象的任何书写错误
 */
export function selectTargets(selector: string | SelectorQuery, context: SelectContext): Selection {
  if (typeof selector === 'string') {
    const query = queryOfShorthand(selector)
    if (query === null) {
      throw new Error(
        `未知选择器：${selector}（封闭词表：${SELECTOR_SHORTHANDS.join(' / ')}）`,
      )
    }
    return evaluateQuery(query, context)
  }
  return evaluateQuery(selector, context)
}
