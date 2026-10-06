// 战斗主循环（规则 §4 / §14 / §15）与胜负判定
//
// 关于"胜负判定放在哪里"——这是一个**语义决策**，不是代码组织偏好：
//
// 规则 §3 写的是"任一方 hp ≤ 0 → **立即**结束，对方获胜"。若把判定只放在触发帧末尾，
// 那么同一帧内已经死掉的一方，其剩余卡牌、被动触发、技能、持续效果仍会继续结算，
// 甚至可能把对方也打死。这既与"立即结束"矛盾，也让"双方同时归零 → 平局"这条规则
// 失去意义（顺序结算下永远不可能同时归零）。
//
// 因此本实现采用**因果点判定**：在**每一个会改变血量的原语之后**立刻检查胜负，
// 一旦分出胜负：
//   1. 设置 state.finished / winner；
//   2. **丢弃当前触发帧剩余的全部动作**（未结算的动作不再执行）；
//   3. 触发栈清空，后续事件不再入栈。
// 主循环末尾的检查保留，用于兜底 MAX_TIME 超时判平局。
//
// 两级时钟（规则 §14 v0.19）——本文件的循环结构就是它的直接映射：
//   - **全局帧**（1cs = 0.01s）是唯一推进步长：每个全局帧推进"持续效果周期 +
//     卡牌状态计时 + 行动条"，并做因果点胜负判定；
//   - **触发帧**（20cs = 0.2s）边界只做三件事：① 消费满条者执行主动行动
//     ② 收集本帧已发生的事件 → 按 §6.2 排序结算被动与技能 ③ 判胜负。
//   故循环体是"每 1cs 一次、共 MAX_TIME_CS = 18000 次"。
//
// 事件（规则 §4 的"广播"）：本实现用一个**本触发帧内有效的事件集合 + 待结算队列** 表达。
//   - 只有"本触发帧真的发生过"的事件才会触发对应触发器（如 on_player_damaged）；
//     这一点必须显式追踪，否则像"敌方受伤时失效敌方一张卡"这类被动会每个触发帧都触发。
//   - 触发器入队后按 §6.2 排序结算；结算过程中产生的新事件**只记账、并入下一个触发帧**
//     （规则 §15 末尾："结算过程中新产生的事件并入下一个触发帧"），本帧不再二次收集。
import {
  GLOBAL_FRAME_CS,
  MAX_TIME_CS,
  TRIGGER_FRAME_CS,
  advanceActionBar,
  advanceCardStatuses,
  actionPeriodCs,
  consumeActionBar,
  createBattleState,
  opponentOf,
  pruneCardStatuses,
} from './state.ts'
import { advanceDots, applyAction } from './primitives.ts'
import { evaluateCondition, type EvalContext } from './expr.ts'
import { formatAction } from './log.ts'
import type {
  Ability,
  ActionEffect,
  ActionLog,
  ActionSpec,
  BattleOptions,
  BattleState,
  BoardCard,
  Condition,
  PlayerId,
} from './types.ts'

export interface BattleResult {
  readonly state: BattleState
  /** 全部日志行（可直接逐行打印） */
  readonly lines: readonly string[]
  readonly log: readonly ActionLog[]
  readonly victory: 'hp' | 'timeout' | 'none'
}

/** 待结算动作。priority 大者先；priority 相同按 loadOrder 升序（本方优先、从左到右）。 */
interface PendingAction {
  readonly tick: number
  readonly actorSide: PlayerId
  readonly actor: string
  readonly sourceKind: 'active' | 'passive' | 'skill'
  readonly priority: number
  readonly loadOrder: number
  /** 同优先级、同 loadOrder 时的稳定次序（如一张卡的多个被动） */
  readonly tieBreak: number
  /** 主动行动：`kind: active` 的挂靠效果（**无内置普攻**）；被动/技能：动作列表 */
  readonly actions: readonly ActionLogSpec[]
}

interface ActionLogSpec {
  readonly spec: ActionSpec
  readonly self: BoardCard | null
  /**
   * 无来源卡时的 `self.<stat>` 取值来源（技能自带 stats）。
   * 规则 §8.2 v0.10：技能效果数值同样禁止字面量、一律引用**本技能** stats。
   */
  readonly selfStats?: Readonly<Record<string, number>>
  readonly side: PlayerId
}

/**
 * 技能加载序号基准：规则 §6.2 明确"同优先级时技能后于卡牌被动结算"，
 * 即技能的加载顺序视为最低。卡牌数量远小于此值，故用一个大数表示"排在最后"。
 */
const SKILL_LOAD_ORDER_BASE = 1_000_000

/** 优先级缺省值与范围（规则 §6.2 第 1 条：数值大者优先，缺省 5，取值 1–10） */
const DEFAULT_PRIORITY = 5

function priorityOf(ability: Ability): number {
  return ability.priority ?? DEFAULT_PRIORITY
}

/** 构建一次动作结算的求值上下文 */
function makeContext(
  state: BattleState,
  side: PlayerId,
  self: BoardCard | null,
  vars: Record<string, number | string>,
  selfStats?: Readonly<Record<string, number>>,
): EvalContext {
  return {
    state,
    rng: state.rng,
    self,
    ...(selfStats === undefined ? {} : { selfStats }),
    side,
    vars,
    ownPlayer: state.players[side],
    enemyPlayer: state.players[opponentOf(side)],
  }
}

/** 触发队列条目：已通过条件判定的触发器，等待排序结算 */
interface QueuedTrigger {
  readonly pending: PendingAction
  readonly context: EvalContext
}

/** 条件与效果中的上下文需要最新状态，故入队时只记录"是谁的什么"，结算时重建上下文 */
interface TriggerSource {
  readonly actor: string
  readonly sourceKind: 'passive' | 'skill'
  readonly priority: number
  readonly loadOrder: number
  readonly tieBreak: number
  readonly actions: readonly ActionLogSpec[]
  readonly condition: Condition | undefined
  readonly side: PlayerId
  readonly self: BoardCard | null
  /** 技能自带 stats（供 condition 里的 `self.<stat>` 求值；卡牌被动不需要） */
  readonly selfStats?: Readonly<Record<string, number>>
}

/**
 * 事件总线：记录**本触发帧**发生过的事件，并暂存已入队的触发器。
 *
 * `dirty` 是"自上次收集以来有没有新事件"的标志，供主循环在触发帧边界判断是否需要再收集：
 * 收集发生在边界、结算也发生在边界，而结算过程中产生的新事件只置位 `dirty`、
 * 留到**下一个触发帧**才收集（规则 §15）。
 */
class EventQueue {
  private readonly fired = new Set<string>()
  private queue: QueuedTrigger[] = []
  /** 自上次 `clearFrameEvents()` 以来是否广播过新事件 */
  private dirty = false

  /** 广播一个事件（去重：同一事件本触发帧只需要知道"发生过"） */
  broadcast(event: string): void {
    this.fired.add(event)
    this.dirty = true
  }

  /** 本触发帧是否发生过该事件 */
  hasFired(event: string): boolean {
    return this.fired.has(event)
  }

  /** 自上次清理以来是否有新事件（决定触发帧边界要不要重新收集触发器） */
  isDirty(): boolean {
    return this.dirty
  }

  /** 触发帧收尾：清空事件集合（触发器队列不动，由 drainQueue 排空） */
  clearFrameEvents(): void {
    this.fired.clear()
    this.dirty = false
  }

  /** 入队一个触发器（条件在入队时判定，用当下的状态） */
  enqueue(source: TriggerSource, state: BattleState): void {
    const context = makeContext(state, source.side, source.self, {}, source.selfStats)
    if (!evaluateCondition(source.condition, context)) return
    this.queue.push({
      pending: {
        tick: state.triggerFrame,
        actorSide: source.side,
        actor: source.actor,
        sourceKind: source.sourceKind,
        priority: source.priority,
        loadOrder: source.loadOrder,
        tieBreak: source.tieBreak,
        actions: source.actions,
      },
      context,
    })
  }

  /** 弹出下一个待结算触发器（按 §6.2 排序） */
  dequeue(): QueuedTrigger | undefined {
    if (this.queue.length === 0) return undefined
    this.queue.sort((left, right) => comparePending(left.pending, right.pending))
    return this.queue.shift()
  }

  /** 清空（分出胜负后不再结算任何已入队的触发器） */
  clear(): void {
    this.queue = []
  }
}

/** 排序规则（规则 §6.2）：priority 降序 → loadOrder 升序 → tieBreak 升序 */
function comparePending(left: PendingAction, right: PendingAction): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  if (left.loadOrder !== right.loadOrder) return left.loadOrder - right.loadOrder
  return left.tieBreak - right.tieBreak
}

/**
 * 胜负判定（规则 §3）。
 * @returns 是否已经分出结果
 */
export function checkOutcome(state: BattleState): boolean {
  if (state.finished) return true
  const aDead = state.players[1].hp <= 0
  const bDead = state.players[2].hp <= 0
  if (aDead && bDead) {
    // 双方同时归零 → 平局；平局视为我方（模拟发起方 = sideA）获胜（规则 §3 第 2/3 条）
    state.finished = true
    state.draw = true
    state.winner = 1
    return true
  }
  if (aDead) {
    state.finished = true
    state.winner = 2
    return true
  }
  if (bDead) {
    state.finished = true
    state.winner = 1
    return true
  }
  return false
}

/** 结算持续效果跳伤/回血并立刻判定胜负 */
function advanceDotsAndCheck(
  state: BattleState,
  queue: EventQueue,
  emit: (entry: ActionLog) => void,
  log: ActionLog,
): boolean {
  queue.broadcast('on_player_damaged')
  emit(log)
  if (checkOutcome(state)) {
    queue.clear()
    return true
  }
  return false
}

/**
 * 结算一组动作。每个改变血量的原语之后立刻判定胜负（因果点），分出胜负即停止。
 */
function applyAll(
  state: BattleState,
  queue: EventQueue,
  emit: (entry: ActionLog) => void,
  pending: PendingAction,
  ordinal: number,
): void {
  const effects: ActionEffect[] = []
  for (const entry of pending.actions) {
    if (state.finished) break
    const context = makeContext(state, entry.side, entry.self, {}, entry.selfStats)
    for (const effect of applyAction(state, entry.spec, context)) {
      effects.push(effect)
    }
    if (checkOutcome(state)) {
      queue.clear()
      break
    }
  }

  const log: ActionLog = {
    tick: pending.tick,
    actorSide: pending.actorSide,
    actor: pending.actor,
    sourceKind: pending.sourceKind,
    ordinal,
    effects,
  }

  // 伤害事件：本动作是否真的造成了伤害，决定 on_player_damaged 是否广播
  const dealtDamage = effects.some((effect) => effect.kind === 'damage' && effect.amount > 0)
  if (dealtDamage) {
    // 伤害事件广播：先记账再 emit（emit 会顺带判定胜负）
    queue.broadcast('on_player_damaged')
  }
  emit(log)
  if (checkOutcome(state)) queue.clear()
}

/** 结算触发队列：不断弹出队首结算，结算产生的新事件继续入队，直到队列空 */
function drainQueue(
  state: BattleState,
  queue: EventQueue,
  ctx: { ordinalRef: { value: number }; emit: (entry: ActionLog) => void },
): void {
  let next = queue.dequeue()
  while (next !== undefined && !state.finished) {
    ctx.ordinalRef.value += 1
    applyAll(state, queue, ctx.emit, next.pending, ctx.ordinalRef.value)
    next = queue.dequeue()
  }
}

/**
 * 推进**一个全局帧**：持续效果周期 → 卡牌状态计时与到期 → 行动条。
 *
 * 顺序就是规则 §15 的 0a/0b：先持续效果与状态计时，再行动条。全部按整数 cs 推进。
 * 状态的"到期移除"放在**推进之后**（先递减、再判到期），这样"卡被 destroy 后立刻停用"
 * 与"buff 最后一 cs 仍生效"两条都能成立。
 *
 * @returns 本全局帧发生的持续效果跳伤/回血观测（供日志；通常为空）
 */
function stepOneGlobalFrame(state: BattleState): { side: PlayerId; effect: ActionEffect }[] {
  const occurred: { side: PlayerId; effect: ActionEffect }[] = []
  for (const side of [1, 2] as const) {
    const player = state.players[side]
    for (const effect of advanceDots(player)) occurred.push({ side, effect })
    advanceCardStatuses(player)
    pruneCardStatuses(player)
    advanceActionBar(player)
  }
  return occurred
}

/**
 * 跑完一局。
 *
 * 主循环（规则 §14 / §15）：
 * ```
 * 初始化：摆盘 → 广播 battle_start → 按优先级结算触发栈（技能与 battle_start 被动）
 * 循环（全局帧 timeCs += 1cs，直到 timeCs >= MAX_TIME_CS = 18000）：
 *   0a 持续效果周期 + 状态计时与到期 + 行动条推进（各推进 1cs，均按整数 cs）
 *   0b 因果点胜负判定（持续效果跳伤后立刻判）
 *   0c 若这一 cs 落在触发帧边界（自增后 timeCs % 20cs === 0，triggerFrame += 1）：
 *      1. 本触发帧内满条者按 §6.2 排序，依次执行主动行动（同卡本帧至多一次），随后消费行动条
 *      2. 收集本帧已发生的事件 → drainQueue 结算被动与技能（新事件只记账、下帧才收集）
 *      3. 判胜负
 * 循环结束后：timeCs >= MAX_TIME_CS → 平局（规则 §3 第 2 条）
 * ```
 */
export function runBattle(options: BattleOptions): BattleResult {
  const state = createBattleState(options)
  const log: ActionLog[] = []
  const lines: string[] = []
  const includeText = options.includeText ?? true
  const ordinalRef = { value: 0 }
  const queue = new EventQueue()

  /** 追加一条日志：同时进结构化数组与文本行（文本由 log.ts 渲染，两者同源） */
  const emit = (entry: ActionLog): void => {
    log.push(entry)
    if (includeText) lines.push(...formatAction(state, entry))
  }

  // —— 初始化阶段：广播 battle_start → 按优先级结算触发栈（技能与 battle_start 被动）——
  // 初始化结束时必须清掉事件集合，否则 battle_start 会被当成"本触发帧发生过的事件"再收集一次。
  queue.broadcast('battle_start')
  collectPassives(state, queue, 'battle_start')
  // 传 hasFired 而不是事件名：collectSkills 的契约就是"按已广播事件判定"，
  // 与主循环保持同一种调用形式（`hasFired` 是队列自己的成员，这里不会失效）。
  collectSkills(state, queue, event => queue.hasFired(event))
  drainQueue(state, queue, { ordinalRef, emit })
  queue.clearFrameEvents()

  while (!state.finished && state.timeCs < MAX_TIME_CS) {
    // —— 0c：本全局帧是否就是触发帧边界 ——
    // 边界在**推进之前**判定并自增 `triggerFrame`：这样落在边界那一 cs 上的持续效果跳伤
    // 会被记到**同一个**触发帧号下（与"触发帧从 1 起、绝对时刻 = 帧号 × 0.2s"一致）。
    const isFrameBoundary = (state.timeCs + GLOBAL_FRAME_CS) % TRIGGER_FRAME_CS === 0
    if (isFrameBoundary) state.triggerFrame += 1
    ordinalRef.value = 0

    // —— 0a / 0b：推进一个全局帧并做因果点胜负判定 ——
    state.timeCs += GLOBAL_FRAME_CS

    for (const { side, effect } of stepOneGlobalFrame(state)) {
      if (state.finished) break
      ordinalRef.value += 1
      const stopped = advanceDotsAndCheck(state, queue, emit, {
        tick: state.triggerFrame,
        actorSide: side,
        actor: `持续效果:${effect.dot ?? 'unknown'}`,
        sourceKind: 'dot',
        ordinal: ordinalRef.value,
        effects: [effect],
      })
      if (stopped) break
    }
    if (state.finished) break
    if (!isFrameBoundary) continue

    // 1. 行动条满者执行主动行动。
    //    行动条在每个全局帧都会推进、可能在本触发帧的**任意**一 cs 达满（规则 §15 的 0b），
    //    但主动行动只在触发帧边界执行，故这里在边界统一收集"已满"者：
    //    **同一张卡在本触发帧至多执行一次主动行动**（规则 §6.3 第 5 条），
    //    执行顺序走 §6.2 的比较规则（等效于"本方先于敌方、同级按加载顺序"）。
    const ready: BoardCard[] = []
    for (const side of [1, 2] as const) {
      for (const boardCard of state.players[side].board) {
        if (boardCard.destroyed) continue
        const periodCs = actionPeriodCs(boardCard)
        if (!Number.isFinite(periodCs)) continue
        if (boardCard.gaugeCs >= periodCs) ready.push(boardCard)
      }
    }
    const sortedReady = ready
      .map((boardCard) => buildActiveAction(state, boardCard))
      .sort((left, right) => comparePending(left, right))
    for (const pending of sortedReady) {
      if (state.finished) break
      ordinalRef.value += 1
      applyAll(state, queue, emit, pending, ordinalRef.value)
      // 本卡主动行动完成 → 广播 `after_action`（《时机表.md》B 类）。
      // **无条件广播**：卡上没有 `kind: active` 效果时，它依然"使用"了这张卡，
      // 依然应当能驱动其他物品的被动（规则 §5：主动/被动只由 cooldown 决定）。
      // 广播只能记账：EventQueue.broadcast 用 Set 去重，故同一触发帧内多张卡行动
      // 也只算"发生过一次"，对应 §6.3"同一触发器每 tick 至多结算一次"。
      if (!state.finished) queue.broadcast('after_action')
    }
    // 行动条消费放在结算之后：即使行动过程中卡被 destroy / 冻结，也要把这一帧的满条消费掉，
    // 否则它会在下一个触发帧"再次满条"从而重复行动（残量按 §14 结转，由 consumeActionBar 保证）
    for (const boardCard of ready) consumeActionBar(boardCard)
    if (state.finished) break

    // 2. 触发栈：本触发帧已发生的事件 → 收集 → 按 §6.2 排序结算（新事件只记账，下帧才收集）
    //    只在 `isDirty()` 时才做：没有新事件就没有触发器候选，避免"每帧空收集"。
    //    注意 `hasFired` 是硬闸门 —— 只有**真的广播过**的事件才收集，
    //    否则"敌方受伤时"这类被动会在每个触发帧都触发（规则 §4 的广播语义）。
    if (queue.isDirty()) {
      for (const event of EVENT_WORDS) {
        if (state.finished) break
        if (!queue.hasFired(event)) continue
        collectPassives(state, queue, event)
      }
      // 技能只在触发帧边界收集一次，且按自己的 `trigger.event` 匹配（见 collectSkills）。
      // **不能放进上面的事件词循环**：那样同一帧命中 N 个事件词时，每侧技能就会结算 N 次
      // （P0.6 已修的实际缺陷，详见 Skill.trigger 的注释）。
      collectSkills(state, queue, event => queue.hasFired(event))
      drainQueue(state, queue, { ordinalRef, emit })
    }
    queue.clearFrameEvents()
    if (checkOutcome(state)) break
  }

  // —— 超时兜底（规则 §3 第 2 条：到达 180.00s 判平局，平局视为我方获胜）——
  if (!state.finished && state.timeCs >= MAX_TIME_CS) {
    state.finished = true
    state.draw = true
    state.winner = 1
  }

  const victory: BattleResult['victory'] = state.draw ? 'timeout' : state.winner === null ? 'none' : 'hp'
  return { state, lines, log, victory }
}

/**
 * 引擎当前会广播的事件词（《时机表.md》的子集，按 P0.6 实现范围）。
 *
 * - `battle_start`：开局，在 `runBattle` 初始化阶段广播一次（不在触发帧循环里）。
 * - `after_action`：任意卡牌主动行动**完成之后**（B 类）。由主循环步骤 1 在每张卡的
 *   `applyAll` 之后无条件广播，**不看该卡有没有 `kind: active` 效果**。
 * - `on_player_damaged`：玩家受到伤害后（`applyAll` 只在真有 `damage > 0` 时广播）。
 *
 * 数组顺序不影响结算顺序：本轮收集到的触发器全部并入同一个优先队列，
 * 由 `comparePending`（§6.2：priority 降序 → loadOrder 升序 → tieBreak 升序）统一排序。
 *
 * **尚未实现的时机词**：《时机表.md》B–E 类共 18 词均为 ✅，这里只落地了 3 个。
 * 其中 `before_action`（主动行动**之前**，框架 §5 伪代码 1a）与 `after_action` 对称、
 * 缺它就是"用了卡但没广播"；其余（`on_card_damaged` / `on_shield_gained` /
 * `on_burn_tick` / `on_card_destroyed` …）都需要各自的广播点，属 P0.6 之后的范围。
 */
const EVENT_WORDS = ['battle_start', 'after_action', 'on_player_damaged'] as const

/**
 * 收集**卡牌被动**并入队：`trigger.event` 精确匹配 + `condition` 为真；
 * 卡牌被 destroy 后被动停用（规则 §9）。
 *
 * 本函数**按事件词调用**：主循环对每个命中事件调用一次，`event` 是本次要匹配的时机词。
 * 因为匹配是精确的（`ability.trigger?.event !== event` 直接 return），
 * 一帧内多次调用不会让同一条被动重复入队。
 */
function collectPassives(state: BattleState, queue: EventQueue, event: string): void {
  for (const side of [1, 2] as const) {
    const player = state.players[side]

    for (const boardCard of player.board) {
      if (boardCard.destroyed) continue
      const abilities = boardCard.card.abilities ?? []
      abilities.forEach((ability, index) => {
        if (ability.kind !== 'passive') return
        if (ability.trigger?.event !== event) return
        queue.enqueue(
          {
            actor: `${boardCard.instanceId}#${String(ability.id)}`,
            sourceKind: 'passive',
            priority: priorityOf(ability),
            loadOrder: boardCard.loadOrder,
            tieBreak: index,
            actions: ability.actions.map((spec) => ({ spec, self: boardCard, side })),
            condition: ability.condition,
            side,
            self: boardCard,
          },
          state,
        )
      })
    }
  }
}

/**
 * 收集**技能**并入队：技能绑定时机词（`Skill.trigger`，与卡牌被动同语义），
 * 只有命中的技能才进入候选。
 *
 * **本函数每个触发帧只调用一次**——这是 P0.6 修复的核心：它不能放进按事件词循环的
 * 收集里，否则同一帧命中 N 个事件词时每侧技能会结算 N 次（详见 `Skill.trigger` 注释）。
 * 是否命中由调用方以 `hasFired` 判定后传入，故本函数与事件集合不耦合。
 *
 * 加载顺序视为最低（`SKILL_LOAD_ORDER_BASE`），故同优先级时技能后于卡牌被动结算（规则 §6.2）。
 */
function collectSkills(state: BattleState, queue: EventQueue, hasFired: (event: string) => boolean): void {
  for (const side of [1, 2] as const) {
    const player = state.players[side]

    player.skills.forEach((skill, index) => {
      if (!hasFired(skill.trigger.event)) return
      queue.enqueue(
        {
          actor: `技能:${skill.id}`,
          sourceKind: 'skill',
          priority: skill.priority ?? DEFAULT_PRIORITY,
          loadOrder: SKILL_LOAD_ORDER_BASE + index,
          tieBreak: index,
          actions: skill.actions.map((spec) => ({ spec, self: null, selfStats: skill.stats, side })),
          condition: skill.condition,
          side,
          self: null,
          selfStats: skill.stats,
        },
        state,
      )
    })
  }
}

/**
 * 主动行动：**只结算 `kind: active` 的条目**（规则 §1 / §5）。
 *
 * 卡的主动/被动属性**只由 `cooldown` 决定**，与有没有写 `kind: active` 无关：
 * - `cooldown !== -1` = 主动卡。行动条充满就是"使用该卡"：即使一条 `kind: active` 都没写
 *   （或被 `every_n` 全部过滤掉），这次主动行动也照常发生、照常广播 `after_action`，
 *   只是不产生任何效果——`actions` 为空是合法状态，不是错误。
 * - `cooldown: -1` = 纯被动卡。卡面上**写了 `kind: active` 也完全无效**，且不受充能影响：
 *   唯一闸门是 `actionPeriodCs` 对它返回 `Infinity`，主循环据此跳过（既不充能也不满条），
 *   本函数因此永远不会被它调用。引擎不为此报错、也不新增错误码。
 *
 * 卡牌**没有内置普攻 / 基础行动**——`stats.atk` 只是"可被引用、可被 buff 的数值"，
 * 引擎不会自动把它变成伤害。想把 `atk` 打出去，卡面必须自己写一条
 * `{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }`。
 */
function buildActiveAction(state: BattleState, boardCard: BoardCard): PendingAction {
  const actions: ActionLogSpec[] = []
  const abilities = (boardCard.card.abilities ?? []).filter((ability) => ability.kind === 'active')
  const actionIndex = boardCard.actionCount + 1

  // 挂靠效果：声明 every_n 者仅在本卡第 N 的整数倍次主动行动时结算
  for (const ability of abilities) {
    if (ability.every_n !== undefined && actionIndex % ability.every_n !== 0) continue
    for (const spec of ability.actions) {
      actions.push({ spec, self: boardCard, side: boardCard.owner })
    }
  }

  // multicast >1 时重复整段（规则 §5）
  const multicast = boardCard.card.multicast ?? 1
  const repeated: ActionLogSpec[] = []
  for (let round = 0; round < multicast; round += 1) {
    for (const action of actions) repeated.push(action)
  }

  boardCard.actionCount += 1

  return {
    tick: state.triggerFrame,
    actorSide: boardCard.owner,
    actor: boardCard.instanceId,
    sourceKind: 'active',
    // 主动行动不走被动优先级比较：行动条充满即结算（规则 §6.2 末段）
    priority: 0,
    loadOrder: boardCard.loadOrder,
    tieBreak: 0,
    actions: repeated,
  }
}
