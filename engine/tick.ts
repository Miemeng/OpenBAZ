// 战斗主循环与胜负判定

// 关于"胜负判定放在哪里"——这是一个**语义决策**，不是代码组织偏好：

//  写的是"任一方 hp ≤ 0 → **立即**结束，对方获胜"。若把判定只放在触发帧末尾，
// 那么同一帧内已经死掉的一方，其剩余卡牌、被动触发、技能、持续效果仍会继续结算，
// 甚至可能把对方也打死。这既与"立即结束"矛盾，也让"双方同时归零 → 平局"这条规则
// 失去意义（顺序结算下永远不可能同时归零）。

// 因此本实现采用**因果点判定**：在**每一个会改变血量的原语之后**立刻检查胜负，
// 一旦分出胜负：
//   1. 设置 state.finished / winner；
//   2. **丢弃当前触发帧剩余的全部动作**（未结算的动作不再执行）；
//   3. 触发栈清空，后续事件不再入栈。
// 主循环末尾的检查保留，用于兜底 MAX_TIME 超时判平局。

// 三级节拍——本文件的循环结构就是它的直接映射：
//   - **全局帧（1cs）** 是唯一推进步长：每 cs 推进"持续效果周期 + 卡牌状态计时 + 行动条"，
//     并做因果点胜负判定。**行动条满只在那一 cs "记账"**（归零 + `actionCount+1` + 入队 + 内部事件
//     `active_action`），**效果不在这里结算**；
//   - **效果处理点（5cs，`EFFECT_TICK_CS`）** 才结算：唤醒 → 释放 → 按优先级结算
//     （主动效果与被动 / 技能同队）；行动条满的效果最多等 0.04s；
//   - **限流窗口（20cs = 触发帧）** 只当**配额**：每个触发器每窗口至多释放一条，
//     多出来的顺延到后续处理点 / 后续窗口。窗口边界同时负责重建光环、判胜负、采一帧快照。
//   故循环体仍是"每 1cs 一次、共 MAX_TIME_CS = 18000 次"。

// 事件（ 的"广播"）：本实现用一个**本触发帧内有效的事件集合 + 待结算队列** 表达。
//   - 只有"本触发帧真的发生过"的事件才会触发对应触发器（如 on_player_damaged）；
//     这一点必须显式追踪，否则像"敌方受伤时失效敌方一张卡"这类被动会每个触发帧都触发。
//   - 触发器入队后按  排序结算；结算过程中产生的新事件**只记账、并入下一个触发帧**
//     （ 末尾："结算过程中新产生的事件并入下一个触发帧"），本帧不再二次收集。
import {
  EFFECT_TICK_CS,
  GLOBAL_FRAME_CS,
  MAX_TIME_CS,
  TRIGGER_FRAME_CS,
  activeEnchantOf,
  advanceActionBar,
  advanceCardStatuses,
  actionPeriodCs,
  consumeActionBar,
  createBattleState,
  effectiveDotStacks,
  effectiveStat,
  opponentOf,
  pruneCardStatuses,
  speedMultiplier,
} from './state.ts'
import { DOT_STAT_KEYS } from './stat-keys.ts'
import { advanceDots, applyAction } from './primitives.ts'
import { refreshAuras } from './aura.ts'
import { evaluateCardFilter, evaluateCondition, type EvalContext } from './expr.ts'
import { DEFAULT_LOG_LEVEL, formatAction, formatMessage } from './log.ts'
import { recordMessage, recordSelectorMismatch } from './messages.ts'
import type {
  Ability,
  ActionEffect,
  ActionLog,
  ActionSpec,
  BattleOptions,
  BattleState,
  BoardCard,
  CardStatusKind,
  Condition,
  DotKind,
  FrameCard,
  FrameDot,
  FrameEvent,
  FramePlayer,
  FrameSnapshot,
  FrameStat,
  FrameStatus,
  LogLevel,
  LogMessage,
  PlayerId,
  PlayerState,
} from './types.ts'

export interface BattleResult {
  readonly state: BattleState
  /** 全部日志行（可直接逐行打印） */
  readonly lines: readonly string[]
  readonly log: readonly ActionLog[]
  readonly victory: 'hp' | 'timeout' | 'none'
  /**
   * 逐触发帧状态快照。**仅当 `BattleOptions.captureFrames` 为真时非空**（否则为空数组）。
   *
   * `[0]` = 开局（`triggerFrame = 0`）· 末项 = 分出胜负的那一帧。
   * **不进确定性 hash、不影响 `lines`** —— 开与不开的日志逐字节相同
   * （`engine/frames.test.ts` 把这条钉成断言）。
   */
  readonly frames: readonly FrameSnapshot[]
}

/** 待结算动作。priority 大者先；priority 相同按 loadOrder 升序（本方优先、从左到右）。 */
interface PendingAction {
  readonly tick: number
  readonly actorSide: PlayerId
  readonly actor: string
  readonly sourceKind: 'active' | 'passive' | 'skill'
  readonly priority: number
  readonly loadOrder: number
  /** 同优先级、同 loadOrder 时的稳定次序（如一张卡的多个被动；主动行动的 `multicast` 轮次也用它） */
  readonly tieBreak: number
  /** 主动行动：`kind: active` 的挂靠效果（**无内置普攻**）；被动/技能：动作列表 */
  readonly actions: readonly ActionLogSpec[]
}

interface ActionLogSpec {
  readonly spec: ActionSpec
  readonly self: BoardCard | null
  /**
   * 无来源卡时的 `self.<stat>` 取值来源（技能自带 stats）。
   *  ：技能效果数值同样禁止字面量、一律引用**本技能** stats。
   */
  readonly selfStats?: Readonly<Record<string, number>>
  readonly side: PlayerId
}

/**
 * 技能加载序号基准： 明确"同优先级时技能后于卡牌被动结算"，
 * 即技能的加载顺序视为最低。卡牌数量远小于此值，故用一个大数表示"排在最后"。
 */
const SKILL_LOAD_ORDER_BASE = 1_000_000

/**
 * **内部事件词**：一次主动行动"记账"时广播（条满的那一 cs），用来表达"这张卡这一 cs 要行动"。
 *
 * - **不对外开放**：不在《时机表》的 17 词词典里，`cards/schema.ts` 的 `KNOWN_EVENTS` 也不收它
 *   ⇒ 卡面写 `trigger: { event: active_action }` 会在校验期被拒；
 * - 它**进帧快照**（`FrameSnapshot.events`）—— 表现层的"行动条归零"锚点就取它的 `cs`；
 * - 主动效果本身不靠它驱动（效果是"记账时压进待释放队列"的），它只承担语义与快照。
 */
const ACTIVE_ACTION_EVENT = 'active_action'

/**
 * **内部事件词**：护盾被**消耗**时广播（伤害结算里 `absorbed > 0` 的那一刻），只进帧快照。
 *
 * **为什么需要它**：护盾是**存量**，同一个 20cs 帧内完全可以"先 +60、再被同一帧的伤害打空"。
 * 帧快照只给**端点值**（两端都是 0）⇒ 表现层看不到那一涨一落，于是出现
 * "有 `+60` 盾的跳字、盾条却是 0"（RW 实测）。把消耗也写进 `events`，表现层才能按 `cs`
 * 把盾的轨迹重放出来（`client/state/replay.ts` 的 `shieldPathOf` / `shieldShownAt`）。
 *
 * - **不对外开放**：不在《时机表》的 17 词词典里、`cards/schema.ts` 的 `KNOWN_EVENTS` 也不收它；
 * - **不驱动任何触发器**（没有监听者，收集后即丢弃）⇒ 对结算与确定性哈希**零影响**；
 * - 来源键固定 `engine:shield_spent`（不挂到卡 / 技能上，避免给它们记"触发高亮"）。
 */
const SHIELD_SPENT_EVENT = 'shield_spent'

/** 优先级缺省值与范围 */
const DEFAULT_PRIORITY = 5

function priorityOf(ability: Ability): number {
  return ability.priority ?? DEFAULT_PRIORITY
}

/**
 * 一次触发事件携带的参数。卡牌实例与玩家对象也是合法参数
 * （ 的 `card` / `source` / `player` 是引用型），故联合里含二者。
 *
 * 分可变 / 只读两个别名：广播点用**索引赋值**在可变别名上逐项填参数（`exactOptionalPropertyTypes`
 * 下"可能不存在"与"显式 undefined"是两回事，展开可选字段的写法在这里反而更难自证），
 * 而对外暴露的一律是只读视图。
 */
type MutableEventVars = Record<string, number | string | BoardCard | PlayerState>
type EventVars = Readonly<MutableEventVars>

/**
 * 构建一次动作结算的求值上下文。
 *
 * ：`vars` 就是**本次事件**携带的参数快照；`tick` 取当前触发帧号。
 * `filterResolver` / `mismatchReporter` 在这里接上 `engine/expr.ts` 的求值器与
 * `engine/messages.ts` 的记账实现 —— `engine/selectors.ts` 不 import 它们（避免循环依赖）。
 * `mismatchReporter` 只负责"记"，**抛错由发现问题的调用方负责**。
 */
function makeContext(
  state: BattleState,
  side: PlayerId,
  self: BoardCard | null,
  vars: EventVars,
  selfStats?: Readonly<Record<string, number>>,
  logLevel: LogLevel = DEFAULT_LOG_LEVEL,
): EvalContext {
  return {
    state,
    rng: state.rng,
    self,
    tick: state.triggerFrame,
    ...(selfStats === undefined ? {} : { selfStats }),
    side,
    vars,
    logLevel,
    filterResolver: evaluateCardFilter,
    notify: (text: string): void => {
      recordMessage(state, { level: 'note', code: 'selector.sort_key_ignored', tick: state.triggerFrame, data: { text } }, logLevel)
    },
    mismatchReporter: (report): void => {
      recordSelectorMismatch(state, report, logLevel)
    },
    ownPlayer: state.players[side],
    enemyPlayer: state.players[opponentOf(side)],
  }
}

/** 触发队列条目：已通过条件判定的触发器，等待排序结算 */
interface QueuedTrigger {
  readonly pending: PendingAction
  readonly context: EvalContext
}

/**
 * 条件与效果中的上下文需要最新状态，故入队时只记录"是谁的什么"，结算时重建上下文。
 *
 * `sourceKind` 现在有三种：`active`（卡牌主动行动，**由记账时直接压入**，占本卡的限流配额）、
 * `passive`（卡牌被动）、`skill`（玩家技能）。
 */
interface TriggerSource {
  readonly actor: string
  readonly sourceKind: 'active' | 'passive' | 'skill'
  readonly priority: number
  readonly loadOrder: number
  readonly tieBreak: number
  readonly actions: readonly ActionLogSpec[]
  readonly condition: Condition | undefined
  readonly side: PlayerId
  readonly self: BoardCard | null
  /** 技能自带 stats（供 condition 里的 `self.<stat>` 求值；卡牌被动不需要） */
  readonly selfStats?: Readonly<Record<string, number>>
  /** 触发本被动 / 技能的事件参数快照（入队时记下来，结算时重建上下文用） */
  readonly vars: EventVars
}

/**
 * 事件实例的键 = **（事件 × 来源 × 目标）**。
 *
 * 这是**结算去重**的口径：
 * - 同帧、同来源、同目标、同事件 **只结算一次**（参数取该来源最后一次）——例：一张卡
 *   `multicast: 2` 一帧里打同一目标两跳 ⇒ 接收方只被唤醒一次；
 * - **来源不同**（另一张卡 / 另一个能力条目 / 另一个持续效果实例）或**目标不同**
 *   （一次 `apply_status` 冻 3 张卡 ⇒ 三个目标）⇒ **各自结算一次**。
 *
 * 用 `\u0000` 分隔（不可能出现在 id 里），避免 `a#b` 与 `a` + `#b` 撞键。
 */
function instanceKey(event: string, sourceKey: string, targetKey: string): string {
  return `${event}\u0000${sourceKey}\u0000${targetKey}`
}

/** 一个尚未被收集的事件实例 */
interface EventInstance {
  readonly event: string
  readonly sourceKey: string
  readonly targetKey: string
  readonly vars: EventVars
}

/** `EventVars` 里的值是"引擎对象或标量"的联合，这里做两个最小判定（避免 `as` 断言散落） */
function isPlayerState(value: unknown): value is PlayerState {
  return typeof value === 'object' && value !== null && 'id' in value && 'hp' in value
}

function isBoardCard(value: unknown): value is BoardCard {
  return typeof value === 'object' && value !== null && 'instanceId' in value && 'slot' in value
}

/** 事件参数 → 对外可序列化的 `FrameEvent`（**只取 id / 数字**，不搬对象引用） */
function toFrameEvent(
  event: string,
  sourceKey: string,
  targetKey: string,
  vars: EventVars,
  cs: number,
): FrameEvent {
  const player = vars['player']
  const card = vars['card'] ?? vars['source']
  // 事件的"那个数"在不同时机词里参数名不同（`amount` / `overflow` / `duration` / `heal` / `damage`），
  // 对外统一收口成 `amount`（每个事件只会用到其中**一个**键，故串成一个回退链即可）
  const amount = vars['amount'] ?? vars['overflow'] ?? vars['duration'] ?? vars['heal'] ?? vars['damage']
  const slotIndex = vars['slot_index']
  return {
    cs,
    event,
    sourceKey,
    targetKey,
    ...(isPlayerState(player) ? { playerId: player.id } : {}),
    ...(isBoardCard(card) ? { instanceId: card.instanceId, slot: card.slot } : {}),
    ...(typeof amount === 'number' ? { amount } : {}),
    ...(typeof slotIndex === 'number' ? { slot: slotIndex + 1 } : {}),
  }
}

/**
 * 事件总线：记录**本触发帧**发生过的事件实例，并管理触发器的"待释放"积压与待结算队列。
 *
 * **三段结构（刻意为之）**：
 * 1. **事件实例**（`pending` / `instanceKey` = 事件 × 来源 × 目标）：同实例一帧只收集一次、
 *    参数取最后一次；**不同实例各自收集** ⇒ 同帧可因多来源 / 多目标唤醒多次；
 * 2. **待释放队列**（`releases`）：每次唤醒压一条，**每个触发帧只释放一条** ⇒ 多出来的
 *    **顺延到后续帧**（不是丢弃）—— 这就是"每帧最多触发一次"的限流，用来压节奏；
 * 3. **记账全量**（`records`）：`broadcast` 每次都追加一条（不覆盖）⇒ `FrameSnapshot.events`
 *    能看到"哪些实例、各发生过几次"，前端飘字 / 调试都不丢信息。
 */
class EventQueue {
  /**
   * **尚未被收集**的事件实例 → 该实例最后一次广播的参数快照。
   *
   * 参数是**只读快照**——入队时拷进触发器，后续广播不会回头改写已入队的触发器。
   * 收集过的实例由 `endProcessing` 摘掉；**没收集的留着**（结算期新产生 / 落在非处理点 cs 的事件
   * 留到下一次收集，即"顺延"）。
   */
  private readonly pending = new Map<string, EventInstance>()
  /** 本次收集轮次里已收集过的实例键（防同一实例重复收集；`endProcessing` 时随 `pending` 一起清） */
  private readonly collected = new Set<string>()
  /**
   * **触发器 → 待释放队列**（键 = 侧 + 触发器身份）。
   *
   * **第二道闸门，刻意为之**：一个触发器被唤醒几次就攒几条，但**每个限流窗口（20cs）只释放一条**
   * —— 多出来的**不丢弃，而是顺延到后续处理点 / 后续窗口**：三张卡同一帧各打一次 ⇒ 那个
   * "受伤就治疗"在本窗口放 1 次，之后每窗口再放 1 次，直到放完（即"多余次数顺延"）。
   *
   * 队列**跨窗口存活**（`endWindow` 不清它）；条目里存该实例的参数快照，其中卡 / 玩家是
   * **实时引用** ⇒ 释放时读到的是释放那一刻的值。
   */
  private readonly releases = new Map<string, TriggerSource[]>()
  /** 本窗口**已经释放过**的触发器键（每个限流窗口 20cs 一次；`endWindow` 清空 ⇒ 下一窗口恢复） */
  private readonly released = new Set<string>()
  /** 本窗口事件**全量**记录（按发生顺序 append；采集进 `FrameSnapshot.events`） */
  private records: FrameEvent[] = []
  private queue: QueuedTrigger[] = []
  /** 自上次 `endProcessing()` 以来是否广播过新事件 */
  private dirty = false

  /**
   * 广播一个事件实例。
   *
   * `sourceKey` / `targetKey` 见 `instanceKey`；`cs` = **发生时刻**（`state.timeCs`），
   * 它进帧快照的 `events`（0.01s 粒度 ⇒ 动画不必对齐到 0.2s 网格）。
   */
  broadcast(event: string, vars: EventVars, sourceKey: string, targetKey: string, cs: number): void {
    this.pending.set(instanceKey(event, sourceKey, targetKey), { event, sourceKey, targetKey, vars })
    this.records.push(toFrameEvent(event, sourceKey, targetKey, vars, cs))
    this.dirty = true
  }

  /**
   * 取出**尚未收集**的实例并标记为已收集。
   *
   * 顺序必须**确定**（否则同一局两次跑的顺序可能不同）：时机词表序 → 来源键 → 目标键。
   */
  takeUncollected(eventOrder: readonly string[]): EventInstance[] {
    const rank = new Map(eventOrder.map((event, index) => [event, index]))
    const out: EventInstance[] = []
    const entries = [...this.pending.entries()]
      .filter(([key]) => !this.collected.has(key))
      .sort(([, left], [, right]) => {
        const byEvent =
          (rank.get(left.event) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.event) ?? Number.MAX_SAFE_INTEGER)
        if (byEvent !== 0) return byEvent
        if (left.sourceKey !== right.sourceKey) return left.sourceKey < right.sourceKey ? -1 : 1
        if (left.targetKey !== right.targetKey) return left.targetKey < right.targetKey ? -1 : 1
        return 0
      })
    for (const [key, instance] of entries) {
      this.collected.add(key)
      out.push(instance)
    }
    return out
  }

  /**
   * **唤醒**一个触发器：把"这个触发器的这一条"（`TriggerSource` 自带该实例的参数快照
   * `vars`）压进待释放队列。
   *
   * 这里**不判条件**（条件留到释放那一刻、用当时状态判），只记"被哪个实例唤醒"。
   */
  pushRelease(key: string, source: TriggerSource): void {
    const list = this.releases.get(key)
    if (list === undefined) this.releases.set(key, [source])
    else list.push(source)
    this.dirty = true
  }

  /** 是否还有未释放的积压（决定"没有新事件也要继续进 drainEffects"） */
  hasPendingReleases(): boolean {
    for (const list of this.releases.values()) {
      if (list.length > 0) return true
    }
    return false
  }

  /** 尚未收集的实例数（`drainEffects` 判断"还能不能继续收集"用） */
  uncollectedCount(): number {
    let count = 0
    for (const key of this.pending.keys()) {
      if (!this.collected.has(key)) count += 1
    }
    return count
  }

  /** 自上次清理以来是否有新事件（决定触发帧边界要不要重新收集触发器） */
  isDirty(): boolean {
    return this.dirty
  }

  /**
   * **处理点收尾**（每 5cs 一次，见 `EFFECT_TICK_CS`）：把**已收集过**的实例从 `pending` 里摘掉
   * ——它们的使命已经完成（唤醒已经写进各自的待释放队列），**未收集的留着**下次收集；
   * 然后按"还有没有积压"重算 `dirty`。
   *
   * ⚠️ **不动 `released`**：限流窗口是 **20cs（触发帧）**，不是 5cs 的处理点 ——
   * 否则同一个触发器在一个窗口里能放 4 条，限流就白设了。
   */
  endProcessing(): void {
    for (const key of this.collected) this.pending.delete(key)
    this.collected.clear()
    this.dirty = this.hasPendingReleases() || this.uncollectedCount() > 0
  }

  /**
   * **限流窗口开始**（每个 20cs 窗口的第一 cs，进入处理点之前调）：清掉"本窗口已释放过"的标记
   * ⇒ 每个触发器每窗口又能放一条。
   *
   * 必须在**窗口第一 cs 的处理点之前**清：否则上一窗口末尾刚释放过的触发器，会在新窗口的第一
   * 个处理点被判成"本窗口已释放"而白等一个处理点。
   */
  beginWindow(): void {
    this.released.clear()
  }

  /**
   * 交出本窗口的事件**全量**记录（采集进 `FrameSnapshot.events`）并清空。
   * 在窗口最后一 cs（即窗口边界那一 cs）的处理**之后**调用。
   */
  takeRecords(): readonly FrameEvent[] {
    const out = this.records
    this.records = []
    return out
  }

  /**
   * **释放**：每个触发器本窗口放一条（队首起，遇到条件为真的就结算）。
   *
   * - **条件用当时状态判**（`makeContext` 取的是当前 `state`）；
   * - 条件为假的条目**直接丢弃**（不占本窗口的释放机会，继续看下一条 ⇒ 队列必然收敛）；
   * - 来源卡已 `destroyed` 的**被动 / 技能**条目一并丢弃（沿用"destroyed 卡的被动停用"）；
   *   **主动行动例外** —— "行动已记账 ⇒ 效果照常结算"（《待办》§七 第 4 条），不因来源卡失效而丢；
   * - 释放顺序按触发器键升序 ⇒ **确定性**（同一局两次跑顺序一致）。
   */
  releaseReady(state: BattleState, logLevel: LogLevel = DEFAULT_LOG_LEVEL): void {
    const keys = [...this.releases.keys()].sort()
    for (const key of keys) {
      if (this.released.has(key)) continue
      const list = this.releases.get(key)
      if (list === undefined) continue
      while (list.length > 0) {
        const entry = list.shift()
        if (entry === undefined) break
        const self = entry.self
        if (entry.sourceKind !== 'active' && self !== null && self.destroyed) continue // 来源卡已失效 ⇒ 丢弃该条
        const context = makeContext(state, entry.side, self, entry.vars, entry.selfStats, logLevel)
        if (!evaluateCondition(entry.condition, context)) continue // 当时状态下条件为假 ⇒ 丢弃
        this.queue.push({
          pending: {
            tick: state.triggerFrame,
            actorSide: entry.side,
            actor: entry.actor,
            sourceKind: entry.sourceKind,
            priority: entry.priority,
            loadOrder: entry.loadOrder,
            tieBreak: entry.tieBreak,
            actions: entry.actions,
          },
          context,
        })
        this.released.add(key)
        break
      }
    }
  }

  /** 弹出下一个待结算触发器 */
  dequeue(): QueuedTrigger | undefined {
    if (this.queue.length === 0) return undefined
    this.queue.sort((left, right) => comparePending(left.pending, right.pending))
    return this.queue.shift()
  }

  /** 清空（分出胜负后不再结算任何已入队的触发器与积压的待释放） */
  clear(): void {
    this.queue = []
    this.releases.clear()
    this.released.clear()
  }
}

/** 排序规则：priority 降序 → loadOrder 升序 → tieBreak 升序 */
function comparePending(left: PendingAction, right: PendingAction): number {
  if (left.priority !== right.priority) return right.priority - left.priority
  if (left.loadOrder !== right.loadOrder) return left.loadOrder - right.loadOrder
  return left.tieBreak - right.tieBreak
}

/**
 * **记账**：把本 cs 达满的卡"用掉这一次行动"，但**不结算效果**。
 *
 * 一次记账（同一 cs 完成）做三件事：
 * 1. `gaugeCs -= periodCs`（余量结转）—— 行动条**立刻归零**；
 * 2. `actionCount += 1` —— `everyN` / 卡面角标据此计数（一次行动只加一次）；
 * 3. 广播**内部事件** `active_action`（只记账，进帧快照），并把这次行动的效果压进待释放队列
 *    —— 效果由**最近的效果处理点**（5cs 网格，见 `EFFECT_TICK_CS`）结算。
 *
 * 顺序口径 = `loadOrder` 升序（先本方后敌方、各自从左到右）⇒ 与摆盘数组次序无关。
 *
 * 三类卡天然不入选：**已失效**（destroyed）、**纯被动**（`cooldown: -1`）、**冰冻**（速度 = 0）
 * —— 后两者由 `actionPeriodCs` 给出 `Infinity`，而 `gaugeCs < Infinity` 恒真。
 *
 * @param recordedThisCs 本 cs 已记账过的卡实例 id（**同一卡同一 cs 至多记账一次**）
 */
function recordReadyActions(state: BattleState, queue: EventQueue, recordedThisCs: Set<string>): void {
  const ready: BoardCard[] = []
  for (const side of [1, 2] as const) {
    for (const boardCard of state.players[side].board) {
      if (boardCard.destroyed) continue
      if (recordedThisCs.has(boardCard.instanceId)) continue
      if (boardCard.gaugeCs < actionPeriodCs(boardCard)) continue
      ready.push(boardCard)
    }
  }
  ready.sort((left, right) => left.loadOrder - right.loadOrder)
  for (const boardCard of ready) {
    recordedThisCs.add(boardCard.instanceId)
    recordAction(state, queue, boardCard)
  }
}

/**
 * 一张卡的一次行动：**只记账**（见 `recordReadyActions`）。
 *
 * - `multicast: N` ⇒ 压 **N 条**释放条目（《待办》§七 第 3 条）⇒ 第 2 条起会顺延到后续窗口；
 * - `everyN` 按**本次行动的序号**（`actionCount`）过滤 —— 记账这一刻就确定，与之后状态无关；
 * - 释放条目的**键 = `<方>|<实例id>`**（每张卡一个）⇒ 限流粒度 = "每卡每 20cs 至多一条"。
 */
function recordAction(state: BattleState, queue: EventQueue, boardCard: BoardCard): void {
  boardCard.actionCount += 1
  const actionIndex = boardCard.actionCount
  const side = boardCard.owner

  // 条归零：减一个充满周期、余量结转（这一 cs 立刻生效）
  consumeActionBar(boardCard)

  // 本次行动的事件参数：`{ var: card }` / `{ var: slot_index }` / `after_action` 都从这里取
  const vars: MutableEventVars = {
    event_name: ACTIVE_ACTION_EVENT,
    tick: state.triggerFrame,
    source_side: side,
    card: boardCard,
    source: boardCard,
    slot_index: boardCard.slot - 1,
  }
  // 内部事件：只记账（进帧快照的 `events`）；不对外开放、不进时机词词典
  queue.broadcast(ACTIVE_ACTION_EVENT, vars, `active:${boardCard.instanceId}`, '-', state.timeCs)

  const specs = activeSpecsFor(boardCard, actionIndex)
  // 没有主动效果也照样入队：一次行动 = 一条释放条目（`actions` 为空是合法的，"使用了这张卡"
  // 仍要广播 `after_action`）—— 与旧的"无条件广播"口径一致。
  const multicast = boardCard.card.multicast ?? 1
  for (let round = 0; round < multicast; round += 1) {
    queue.pushRelease(`${String(side)}|${boardCard.instanceId}`, {
      actor: boardCard.instanceId,
      sourceKind: 'active',
      // 主动效果与被动**同队**比较（《待办》§七 第 2 条）：priority 取缺省值，先后由 loadOrder / tieBreak 决定
      priority: DEFAULT_PRIORITY,
      loadOrder: boardCard.loadOrder,
      tieBreak: round,
      actions: specs,
      condition: undefined,
      side,
      self: boardCard,
      vars,
    })
  }
}

/**
 * 本次行动要跑的效果：卡面 `kind: active` 的条目按书写顺序；
 * `everyN` 不在第 N 的整数倍次行动时跳过（`actionIndex` = 本卡第几次行动，1 基）。
 *
 * 主动效果**不走 `condition`**（与旧口径一致：主动条目没有前置条件）——故释放时条件恒为真。
 */
function activeSpecsFor(boardCard: BoardCard, actionIndex: number): ActionLogSpec[] {
  const specs: ActionLogSpec[] = []
  const abilities = (boardCard.card.abilities ?? []).filter((ability) => ability.kind === 'active')
  for (const ability of abilities) {
    if (ability.everyN !== undefined && actionIndex % ability.everyN !== 0) continue
    for (const spec of ability.actions) specs.push({ spec, self: boardCard, side: boardCard.owner })
  }
  // 附魔的附加组（AD.1 = A）：追加在**本卡主动效果的末尾**，作为同一次行动的一部分。
  // 因为它在 `specs` 里，`multicast: N` 的**每一条重复**都各带一份（RW 口径：附魔也参与 multicast）。
  // 卡面没有 kind: active 的条目也照样追加 —— "这张卡行动了"就包括它的附魔。
  const enchant = activeEnchantOf(boardCard)
  for (const spec of enchant?.actions ?? []) {
    specs.push({ spec, self: boardCard, side: boardCard.owner })
  }
  return specs
}

/**
 * 胜负判定。
 * @returns 是否已经分出结果
 */
export function checkOutcome(state: BattleState): boolean {
  if (state.finished) return true
  const aDead = state.players[1].hp <= 0
  const bDead = state.players[2].hp <= 0
  if (aDead && bDead) {
    // 双方同时归零 → 平局；平局视为我方（模拟发起方 = sideA）获胜
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
  // 一次持续效果结算产生两类事件：
  //   ① **跳变时机词**（`on_burn_tick` / `on_poison_tick` / `on_regen_tick`）—— 本次**到点的每个种类**各广播一次，
  //      参数 = `player` + `stacks`（该种类本次**结算前**的派生态读数）+ `damage`（灼烧 / 剧毒）或 `heal`（再生）
  //      —— 剧毒与再生合并净值结算时，两个词各自的 `damage` / `heal` 是**自己的分量**（不是实际血量变化）；
  //   ② **伤害事件**（`on_player_damaged`）—— 只有**真的造成伤害**的结算才广播（参数 `amount` = 实际扣血量）。
  //      ⚠️ 再生是回血，**不借用** `on_player_damaged`（它由 ① 的 `on_regen_tick` 承载）。
  // `player` 是 player_ref：用**玩家对象**（与 `{ ref: 'own_player' }` 同一表示，才能 eq / neq）。
  // 缺了它，写着 `{ var: player }` 的被动 / 技能会在求值时抛"事件参数 player 不存在"而**中止整局**
  // —— 跳变时机词与伤害事件都必须带上它（历史踩坑记录见 engine/tick.test.ts 的文件头）。
  const subject = log.effects[0]
  const damageEvent = log.effects.find((effect) => effect.kind === 'damage')
  // 来源 = 该持续效果实例（`dot:<kind>@<承受方>`）—— **双方各自的灼烧是两个来源**，各自结算；
  // 目标 = 承受跳变的那位玩家。
  const dotSide = subject?.targetSide
  const dotTargetKey = dotSide === undefined ? '-' : `player:${String(dotSide)}`
  const dotSourceKeyOf = (kind: DotKind): string =>
    `dot:${kind}@${dotSide === undefined ? '-' : String(dotSide)}`

  // ① 跳变时机词：本次到点的每个种类各一条（来源 = 该种类的实例）
  if (subject !== undefined) {
    for (const kind of subject.dots ?? []) {
      const tickWord = dotTickWord(kind)
      if (tickWord === undefined) continue
      const stacks = dotReadStacks(subject, kind)
      const tickVars: MutableEventVars = {
        event_name: tickWord,
        tick: state.triggerFrame,
        player: state.players[subject.targetSide],
        stacks,
      }
      // 分量口径：灼烧 / 剧毒给 `damage`、再生给 `heal`（净值结算的实际变化见 ② 的 `amount`）
      if (kind === 'regen') tickVars['heal'] = stacks
      else tickVars['damage'] = stacks
      queue.broadcast(tickWord, tickVars, dotSourceKeyOf(kind), dotTargetKey, state.timeCs)
    }
  }

  // ② 伤害事件：只有真的有伤害观测结果时才广播（再生不在此列）
  if (damageEvent !== undefined) {
    const damageKind = primaryDotKind(damageEvent.dots)
    const dotVars: MutableEventVars = {
      event_name: 'on_player_damaged',
      tick: state.triggerFrame,
      player: state.players[damageEvent.targetSide],
      amount: damageEvent.amount,
      shield_absorbed: damageEvent.absorbed,
      damage_type: dotDamageType(damageEvent.dots),
      // `source` / `source_side`：持续效果实例里只留了来源卡的**字符串标识**（不构成卡引用），
      // 拿不到来源卡，故不写 `source`；`source_side` 只能取受伤方的对面。
      source_side: opponentOf(damageEvent.targetSide),
    }
    queue.broadcast(
      'on_player_damaged',
      dotVars,
      damageKind === undefined ? dotSourceKeyOf('poison') : dotSourceKeyOf(damageKind),
      dotTargetKey,
      state.timeCs,
    )

    // 护盾消耗也进帧快照：盾是存量，同一帧内可能"先涨后空"，只给端点值表现层看不出来。
    if (damageEvent.absorbed > 0) {
      queue.broadcast(
        SHIELD_SPENT_EVENT,
        {
          event_name: SHIELD_SPENT_EVENT,
          tick: state.triggerFrame,
          player: state.players[damageEvent.targetSide],
          amount: damageEvent.absorbed,
        },
        `engine:${SHIELD_SPENT_EVENT}`,
        `player:${String(damageEvent.targetSide)}`,
        state.timeCs,
      )
    }

    // 灼烧跳伤同样可能**一次打空护盾池** ⇒ 按同一口径广播击穿（剧毒无视护盾，
    // `absorbed` 恒为 0，自然不会命中这条）。
    if (damageEvent.absorbed > 0 && damageEvent.shieldAfter === 0) {
      const brokenVars: MutableEventVars = {
        event_name: 'on_shield_broken',
        tick: state.triggerFrame,
        player: state.players[damageEvent.targetSide],
        overflow: damageEvent.amount,
        source_side: opponentOf(damageEvent.targetSide),
      }
      queue.broadcast(
        'on_shield_broken',
        brokenVars,
        damageKind === undefined ? dotSourceKeyOf('burn') : dotSourceKeyOf(damageKind),
        `player:${String(damageEvent.targetSide)}`,
        state.timeCs,
      )
    }
  }
  emit(log)
  if (checkOutcome(state)) {
    queue.clear()
    return true
  }
  return false
}

/**
 * 伤害类型（`on_player_damaged.damage_type` = `normal` / `burn` / `poison`）。
 *
 * **伤害类型只有三种**：取本次结算涉及的种类里"更靠前"的那一个（灼烧 > 剧毒）；
 * 再生不是伤害，故只涉及再生时给 `normal`。
 */
function dotDamageType(dots: readonly DotKind[] | undefined): string {
  const kind = primaryDotKind(dots)
  return kind === 'burn' || kind === 'poison' ? kind : 'normal'
}

/** 本次结算的"主导种类"：灼烧优先于剧毒；只涉及再生（或没有种类）时为 undefined */
function primaryDotKind(dots: readonly DotKind[] | undefined): DotKind | undefined {
  if (dots === undefined) return undefined
  if (dots.includes('burn')) return 'burn'
  return dots.includes('poison') ? 'poison' : undefined
}

/** 本次结算里某种类的**结算前派生态读数**（净值结算的两个分量各取各的） */
function dotReadStacks(effect: ActionEffect, kind: DotKind): number {
  if (kind === 'burn') return effect.burnStacks ?? 0
  return kind === 'poison' ? (effect.poisonStacks ?? 0) : (effect.regenStacks ?? 0)
}

/** 持续效果种类 → 对应的跳变时机词（三者各一个；`undefined` = 不是持续效果跳变） */
function dotTickWord(kind: DotKind | undefined): string | undefined {
  if (kind === 'burn') return 'on_burn_tick'
  if (kind === 'poison') return 'on_poison_tick'
  if (kind === 'regen') return 'on_regen_tick'
  return undefined
}

/** 卡牌状态 → 对应的事件词（`apply_status` 的三个状态各有一个时机词） */
function statusEventWord(status: CardStatusKind | undefined): string | undefined {
  if (status === 'freeze') return 'on_card_frozen'
  if (status === 'haste') return 'on_card_hasted'
  if (status === 'slow') return 'on_card_slowed'
  return undefined
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
  vars: EventVars,
  logLevel: LogLevel = DEFAULT_LOG_LEVEL,
  /**
   * 可选：收集"本次行动实际造成的伤害"（每条伤到**玩家**的观测结果一个元素）。
   * `after_action` 的 `damage_dealt` 参数需要它，而在 `applyAction` 之外无从预知伤害值
   * （`amount` 是 `{ ref: ... }`，依赖结算时的实时状态），故由调用方传入收集器。
   */
  damageSink?: number[],
): void {
  const effects: ActionEffect[] = []
  for (const entry of pending.actions) {
    if (state.finished) break
    // 这里的 `vars` 是**触发本动作的事件**的参数快照（主动行动取 `after_action` 的，
    // 被动 / 技能取各自时机词的）。同一批动作共享同一份快照 —— 快照只在入队时采集，结算期间不变。
    const context = makeContext(state, entry.side, entry.self, vars, entry.selfStats, logLevel)
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

  // 本动作的**来源**：`active:<卡实例id>` / `passive:<卡实例id>#<能力id>` / `skill:<技能id>`。
  // 事件参数里的 `source`（来源卡）只有卡牌动作才有：技能动作的 `self` 为 null ⇒ 不给该参数。
  const sourceKey = `${pending.sourceKind}:${pending.actor}`
  let sourceCard: BoardCard | undefined
  for (const entry of pending.actions) {
    if (entry.self !== null) {
      sourceCard = entry.self
      break
    }
  }

  // 逐条观测结果广播玩家侧事件。同一动作可能同时影响两个玩家（`side: both`）⇒ 每条各广播一次，
  // 形成各自独立的**事件实例**（"同帧同实例取最后一次参数"由 EventQueue 的去重负责，这里不做取舍）。
  // 参数只填"这个点确实知道"的那些。
  const playerDamages = effects.filter(
    (effect) => effect.kind === 'damage' && effect.amount > 0 && effect.card === undefined,
  )
  // 护盾消耗单独走一遍 **全部** 伤害观测 —— 刻意**不**复用下面"只有真的掉血才广播"的过滤：
  // 伤害**全被护盾吃掉**时 `amount = 0`（生命一点没掉），但盾确实少了；
  // 漏掉它，"同一帧里先 +60 再被吃干净"在帧快照上仍然只剩端点 0（正是 RW 报的那一帧）。
  for (const effect of effects) {
    if (effect.kind !== 'damage' || effect.card !== undefined || effect.absorbed <= 0) continue
    queue.broadcast(
      SHIELD_SPENT_EVENT,
      {
        event_name: SHIELD_SPENT_EVENT,
        tick: pending.tick,
        player: state.players[effect.targetSide],
        amount: effect.absorbed,
      },
      `engine:${SHIELD_SPENT_EVENT}`,
      `player:${String(effect.targetSide)}`,
      state.timeCs,
    )
  }
  for (const effect of playerDamages) {
    damageSink?.push(effect.amount)
    const damageVars: MutableEventVars = {
      event_name: 'on_player_damaged',
      tick: pending.tick,
      player: state.players[effect.targetSide],
      amount: effect.amount,
      shield_absorbed: effect.absorbed,
      damage_type: dotDamageType(effect.dots),
      source_side: pending.actorSide,
    }
    if (sourceCard !== undefined) damageVars['source'] = sourceCard
    queue.broadcast(
      'on_player_damaged',
      damageVars,
      sourceKey,
      `player:${String(effect.targetSide)}`,
      state.timeCs,
    )
    // 护盾池被**这一次伤害**从 >0 打空 ⇒ 广播击穿，`overflow` = 溢出到血量的那部分伤害。
  }
  // 击穿判定（《审阅.md》§AC = A）：与持续效果一侧**统一口径** ——
  // 只要"这一次伤害吸收了 >0 的盾、并把盾池打到 0"就算一次击穿；
  // 伤害**全被盾吃掉**（`amount = 0`、溢出 0）也算，故这一遍**不看 `amount`**。
  for (const effect of effects) {
    if (effect.kind !== 'damage' || effect.card !== undefined) continue
    if (effect.absorbed <= 0 || effect.shieldAfter !== 0) continue
    const brokenVars: MutableEventVars = {
      event_name: 'on_shield_broken',
      tick: pending.tick,
      player: state.players[effect.targetSide],
      overflow: effect.amount,
      source_side: pending.actorSide,
    }
    if (sourceCard !== undefined) brokenVars['source'] = sourceCard
    queue.broadcast(
      'on_shield_broken',
      brokenVars,
      sourceKey,
      `player:${String(effect.targetSide)}`,
      state.timeCs,
    )
  }

  // 治疗：**满血 0 治疗也算一次发生**，故不看 `amount`（与伤害事件的口径刻意不同）。
  // `cleansed_burn` / `cleansed_poison` = 本次治疗按 `实际恢复量 × 0.05` 真正清掉的层数。
  for (const effect of effects) {
    if (effect.kind !== 'heal') continue
    const healVars: MutableEventVars = {
      event_name: 'on_player_healed',
      tick: pending.tick,
      player: state.players[effect.targetSide],
      amount: effect.amount,
      cleansed_burn: effect.cleansedBurn ?? 0,
      cleansed_poison: effect.cleansedPoison ?? 0,
      source_side: pending.actorSide,
    }
    if (sourceCard !== undefined) healVars['source'] = sourceCard
    queue.broadcast(
      'on_player_healed',
      healVars,
      sourceKey,
      `player:${String(effect.targetSide)}`,
      state.timeCs,
    )
  }

  // 护盾：真的加上盾才算"获得"（加 0 是空转），故要求 `amount > 0`。
  for (const effect of effects) {
    if (effect.kind !== 'shield' || effect.amount <= 0) continue
    const shieldVars: MutableEventVars = {
      event_name: 'on_shield_gained',
      tick: pending.tick,
      player: state.players[effect.targetSide],
      amount: effect.amount,
      source_side: pending.actorSide,
    }
    if (sourceCard !== undefined) shieldVars['source'] = sourceCard
    queue.broadcast(
      'on_shield_gained',
      shieldVars,
      sourceKey,
      `player:${String(effect.targetSide)}`,
      state.timeCs,
    )
  }

  // 卡牌侧事件：destroy / repair / apply_status / charge 的每条观测结果各广播一次。
  // 目标 = **被作用的那张卡**（`card:<实例id>`）；来源 = 本次动作的发出者（与玩家侧同一套口径）。
  // 一次作用 N 张卡 ⇒ N 个实例（目标不同）⇒ 各自唤醒一次。
  // `gain_stat` 的卡牌侧观测结果没有对应时机词 ⇒ 跳过。
  for (const effect of effects) {
    const card = effect.card
    if (card === undefined) continue
    const word =
      effect.kind === 'destroy'
        ? 'on_card_destroyed'
        : effect.kind === 'repair'
          ? 'on_card_repaired'
          : effect.kind === 'status'
            ? statusEventWord(effect.status)
            : effect.kind === 'charge'
              ? 'on_card_charged'
              : undefined
    if (word === undefined) continue
    const cardVars: MutableEventVars = {
      event_name: word,
      tick: pending.tick,
      card,
      source_side: pending.actorSide,
    }
    if (sourceCard !== undefined) cardVars['source'] = sourceCard
    if (effect.kind === 'destroy' || effect.kind === 'repair') cardVars['slot_index'] = card.slot - 1
    if (effect.kind === 'status') cardVars['duration'] = effect.durationSeconds ?? 0
    if (effect.kind === 'charge') cardVars['amount'] = effect.amount
    queue.broadcast(word, cardVars, sourceKey, `card:${card.instanceId}`, state.timeCs)
  }

  emit(log)
  if (checkOutcome(state)) queue.clear()
}

/**
 * 一个**效果处理点**（每 5cs 一次，见 `EFFECT_TICK_CS`）：**唤醒 → 释放 → 结算**，
 * 循环到"队列空且没有未收集的事件"，最后调 `endProcessing()` 收尾。
 *
 * 1. **唤醒**：尚未收集的事件实例逐个唤醒触发器 —— 每个被动 / 技能 / 主动效果被唤醒几次，
 *    就在自己的待释放队列里攒几条；
 * 2. **释放**：每个触发器**本窗口（20cs）放一条**（条件按**当时状态**判、动作里的数值实时取）；
 *    多出来的**顺延到后续处理点 / 后续窗口** —— 这就是"20cs 触发限制"的限流作用；
 * 3. **结算**：队首按 `comparePending` 排序结算，顺序确定；结算产生的新事件回到第 1 步。
 *
 * **主动行动的条目**额外广播 `after_action`（"这张卡用过了"），参数 `damage_dealt` = 本次释放
 * 实际造成的伤害 —— 与旧的"行动即广播"相比，`cs` 从"条满那一 cs"变成"**释放那一 cs**"。
 *
 * **必然收敛**：每个事件实例每个处理点最多被收集一次（`EventQueue.collected`），而实例数是有限的
 * （事件词 × 来源 × 目标）；每个触发器每个窗口最多释放一条 ⇒ 链式触发不会无限循环。
 */
function drainEffects(
  state: BattleState,
  queue: EventQueue,
  ctx: {
    ordinalRef: { value: number }
    emit: (entry: ActionLog) => void
    logLevel?: LogLevel
  },
): void {
  const logLevel = ctx.logLevel ?? DEFAULT_LOG_LEVEL
  for (;;) {
    // 1) 唤醒：尚未收集的事件实例 → 往对应触发器的待释放队列各压一条
    for (const instance of queue.takeUncollected(EVENT_WORDS)) {
      if (state.finished) break
      collectPassives(state, queue, instance)
      collectSkills(state, queue, instance)
    }
    if (state.finished) {
      queue.clear()
      return
    }

    // 2) 释放：每个触发器本窗口放一条（多出的留到后续窗口，由 endProcessing 重算 dirty 继续驱动）
    queue.releaseReady(state, logLevel)

    // 3) 结算队首；队列虽空但仍有未收集的事件 ⇒ 回第 1 步继续收集
    const next = queue.dequeue()
    if (next === undefined) {
      if (queue.uncollectedCount() === 0) break
      continue
    }
    ctx.ordinalRef.value += 1
    // 用**唤醒时**采集的事件参数快照重建上下文（`next.context` 只用于条件判定，
    // 结算期状态已变，故这里重新构建；参数快照本身是只读的，不随结算改变）
    const isActive = next.pending.sourceKind === 'active'
    const damageSink: number[] = []
    applyAll(
      state,
      queue,
      ctx.emit,
      next.pending,
      ctx.ordinalRef.value,
      next.context.vars,
      logLevel,
      isActive ? damageSink : undefined,
    )
    // 主动行动结算完 ⇒ 无广播 `after_action`（"这张卡用过了"；卡上没有 kind: active 也照发）
    if (isActive && !state.finished) {
      const damageDealt = damageSink.reduce((sum, amount) => sum + amount, 0)
      // 用**另一个对象**：`next.context.vars` 是这次行动的只读快照，不能回头改写
      const actionVars: MutableEventVars = { ...next.context.vars }
      actionVars['event_name'] = 'after_action'
      actionVars['tick'] = state.triggerFrame
      actionVars['damage_dealt'] = damageDealt
      // 来源 = 本次行动的卡；目标 = `-`（"用过了"没有目标）
      queue.broadcast('after_action', actionVars, `active:${next.pending.actor}`, '-', state.timeCs)
    }
  }
  if (!state.finished) queue.endProcessing()
}

/**
 * 推进**一个全局帧**：持续效果周期 → 卡牌状态计时与到期 → 行动条。
 *
 * 顺序就是 的 0a/0b：先持续效果与状态计时，再行动条。全部按整数 cs 推进。
 * 状态的"到期移除"放在**推进之后**（先递减、再判到期），这样"卡被 destroy 后立刻停用"
 * 与"buff 最后一 cs 仍生效"两条都能成立。
 *
 * 本函数**只推进**：满条者由调用方（`recordReadyActions`）在**同一 cs 记账**（归零），
 * 效果则等最近的效果处理点（`drainEffects`）结算。
 *
 * @returns 本全局帧发生的持续效果跳伤/回血观测（供日志；通常为空）
 */
function stepOneGlobalFrame(state: BattleState): { side: PlayerId; effect: ActionEffect }[] {
  const occurred: { side: PlayerId; effect: ActionEffect }[] = []
  for (const side of [1, 2] as const) {
    const player = state.players[side]
    for (const effect of advanceDots(state, player)) occurred.push({ side, effect })
    advanceCardStatuses(player)
    pruneCardStatuses(player)
    advanceActionBar(player)
  }
  return occurred
}

/**
 * 跑完一局。
 *
 * 主循环（**三级节拍**：1cs 记账 / 5cs 结算 / 20cs 限流）：
 * ```
 * 初始化：摆盘 → 广播 battle_start → 效果处理点（cs 0）
 * 循环（全局帧 timeCs += 1cs，直到 timeCs >= MAX_TIME_CS = 18000）：
 *   0a 持续效果周期 + 状态计时与到期 + 行动条推进（各推进 1cs，均按整数 cs）
 *   0b 因果点胜负判定（持续效果跳伤后立刻判）
 *   1. **记账**：本 cs 达满的卡按 loadOrder 依次「条归零 + actionCount+1 + 广播内部事件
 *      `active_action` + 把效果压进待释放队列」—— **效果不在这里结算**；
 *      同一张卡同一 cs 至多记账一次
 *   2. 若这一 cs 落在**效果处理点**（`timeCs % EFFECT_TICK_CS === 0`）：`drainEffects`
 *      —— 唤醒 → 释放（每触发器每 20cs 一条，多的顺延）→ 按 `comparePending` 结算；
 *      主动行动的条目结算完额外广播 `after_action`
 *   3. 若这一 cs 落在**限流窗口边界**（`timeCs % 20 === 0`）：
 *      清配额（`endWindow`）→ 判胜负 → 采一帧快照
 * 循环结束后：timeCs >= MAX_TIME_CS → 平局
 * ```
 */
export function runBattle(options: BattleOptions): BattleResult {
  const state = createBattleState(options)
  const log: ActionLog[] = []
  const lines: string[] = []
  const includeText = options.includeText ?? true
  const logLevel = options.logLevel ?? DEFAULT_LOG_LEVEL
  const ordinalRef = { value: 0 }
  const queue = new EventQueue()

  // —— 逐触发帧快照（默认关闭；只读 state、不耗 rng、不进 hash）
  const captureFrames = options.captureFrames === true
  const frames: FrameSnapshot[] = []
  const capture = (): void => {
    // 窗口收尾：交出本窗口的事件全量记录（**无论开不开快照都要做**，否则会跨窗口累积）
    // —— 采集进帧快照的 `events`。
    const events = queue.takeRecords()
    if (captureFrames) frames.push(snapshotFrame(state, events))
  }

  /** 追加一条日志：同时进结构化数组与文本行（文本由 log.ts 渲染，两者同源） */
  const emit = (entry: ActionLog): void => {
    log.push(entry)
    if (includeText) lines.push(...formatAction(state, entry))
  }

  /**
   * 追加一条分级消息：低于阈值直接丢弃。
   * **丢弃只影响"看不看得见"，不影响任何判定**（不消耗 rng、不写状态字段），
   * 故 `logLevel` 可以随时调整而无需重跑回归。
   *
   * 记账走 `engine/messages.ts` 的 `recordMessage` —— 那是全项目唯一的记账入口，
   * `engine/primitives.ts`（原语 × 目标类型不匹配）与 `engine/expr.ts`（`{ count }` 选玩家）
   * 在运行时由 `makeContext` 注入的 `mismatchReporter` 也走同一个函数
   * （它们不能 import 本文件：`primitives.ts` 被本文件依赖，反向 import 会成环）。
   */
  const emitMessage = (message: LogMessage): void => {
    recordMessage(state, message, logLevel, (recorded) => {
      if (includeText) lines.push(formatMessage(state, recorded))
    })
  }

  // —— 初始化阶段：光环派生态（触发帧 0）→ 体检技能 → 广播 battle_start → 结算触发栈
  // 初始化结束时必须清掉事件集合，否则 battle_start 会被当成"本触发帧发生过的事件"再收集一次。
  // `battle_start` 没有专属参数，只有通用参数里的 `event_name`；
  // `tick` 由 `makeContext` 从 `state.triggerFrame` 取（初始化阶段为 0）。
  // 光环必须在体检**之前**求值：`reportInertSkills` 要按"有没有光环"判断技能是否空转。
  refreshAuras(state, emitMessage)
  reportInertSkills(state, emitMessage)
  queue.broadcast(
    'battle_start',
    { event_name: 'battle_start', tick: state.triggerFrame },
    'engine:battle_start',
    '-',
    state.timeCs,
  )
  /**
   * 本全局帧（cs）已**记账**过主动行动的卡实例 id。
   *
   * 口径 = **同一张卡同一 cs 至多记账一次**：`charge` 把同一张卡又在同一 cs 推满时不会重复记账
   * （下个 cs 才可能再记）—— 防的是"一次释放里反复充能自己"这类病态。每个 cs 开头清空。
   */
  const recordedThisCs = new Set<string>()

  // 开局：`battle_start` 的收集 / 释放发生在 **cs 0**（它是效果处理点：0 % EFFECT_TICK_CS === 0）
  drainEffects(state, queue, { ordinalRef, emit, logLevel })
  // 开局帧（triggerFrame = 0）也要有一份快照：回放的画面从"双方满血、无状态"开始
  capture()

  while (!state.finished && state.timeCs < MAX_TIME_CS) {
    // —— 三个节拍各自判定（都在**推进之前**，这样落在这一 cs 上的量记到同一帧号下）：
    //    窗口边界 = 触发帧边界（20cs，`triggerFrame += 1`）；处理点 = 5cs（`EFFECT_TICK_CS`）
    const isWindowBoundary = (state.timeCs + GLOBAL_FRAME_CS) % TRIGGER_FRAME_CS === 0
    const isProcessingPoint = (state.timeCs + GLOBAL_FRAME_CS) % EFFECT_TICK_CS === 0
    if (isWindowBoundary) {
      state.triggerFrame += 1
      // 新窗口 ⇒ 配额重置（必须在本次处理点之前）
      queue.beginWindow()
    }
    ordinalRef.value = 0
    recordedThisCs.clear()

    // —— 窗口边界重建光环派生态
    // 位置刻意选在"推进之前"：落在边界那一 cs 上的持续效果跳伤要按**新快照**算
    // （光环"来源离场下一帧消失"也由此成立）。见 engine/aura.ts。
    if (isWindowBoundary) refreshAuras(state, emitMessage)

    // —— 0a / 0b：推进一个全局帧并做因果点胜负判定
    state.timeCs += GLOBAL_FRAME_CS

    for (const { side, effect } of stepOneGlobalFrame(state)) {
      if (state.finished) break
      ordinalRef.value += 1
      const stopped = advanceDotsAndCheck(state, queue, emit, {
        tick: state.triggerFrame,
        actorSide: side,
        actor: `持续效果:${(effect.dots ?? ['unknown']).join('+')}`,
        sourceKind: 'dot',
        ordinal: ordinalRef.value,
        effects: [effect],
      })
      if (stopped) break
    }
    if (state.finished) break

    // 1. **记账**：本 cs 达满的卡立刻"用掉这次行动"（条归零 + 计数 + 入队），
    //    **效果不在这里结算** —— 等最近的效果处理点按限流规则释放。
    recordReadyActions(state, queue, recordedThisCs)
    if (state.finished) break

    // 2. **效果处理点**（5cs）：唤醒 → 释放（每触发器每 20cs 一条，多的顺延）→ 按 `comparePending` 结算。
    //    同一 cs 记账的行动也在**本点**结算（《待办》§七 第 11 条"当点结算"）。
    if (isProcessingPoint && queue.isDirty()) drainEffects(state, queue, { ordinalRef, emit, logLevel })
    if (state.finished) break

    // 3. **限流窗口边界**（20cs）：清配额 + 判胜负 + 采一帧快照。
    if (!isWindowBoundary) continue
    // 先判胜负、再采集：这样"分出胜负的那一帧"的快照里 `finished` / `winner` 是对的
    // （若先 break 就永远不会记下结局帧，回放会停在"上一帧"）。
    const settled = checkOutcome(state)
    capture()
    if (settled) break
  }

  // —— 超时兜底
  if (!state.finished && state.timeCs >= MAX_TIME_CS) {
    state.finished = true
    state.draw = true
    state.winner = 1
  }

  // —— 收尾快照（只补一帧，且只在必要时）
  // 胜负可能在**触发帧中途**由因果点判定（主循环里 `if (state.finished) break` 直接跳出），
  // 那条路径**到不了**帧末的 `capture()` ⇒ 上一条快照的 `finished` 还是 false。
  // 这里补一帧"判定结果帧"：`triggerFrame` 与上一帧相同（帧没走完）、`timeCs` 可能更大、
  // `finished` / `winner` 为真 —— 回放据此显示结算遮罩，不必回头再读 `BattleResult.victory`。
  if (captureFrames) {
    const last = frames[frames.length - 1]
    // 收尾帧要**收走本窗口剩下的帧事件**：窗口中途结束（因果点判出胜负）时，
    // 那一次 `capture()` 没走到，事件仍留在队列里 —— 不取走的话，回放里最后一击
    // 的飘字 / 破盾 / 盾的涨落会整段消失。`queue.clear()` 不清 `records`，故这里取得到。
    if (last === undefined || !last.finished) frames.push(snapshotFrame(state, queue.takeRecords()))
  }

  const victory: BattleResult['victory'] = state.draw ? 'timeout' : state.winner === null ? 'none' : 'hp'
  return { state, lines, log, victory, frames }
}

// ————————————————————————————————————————————————————————
// 逐触发帧快照的采集（只读；见 engine/types.ts 的 FrameSnapshot）
// ————————————————————————————————————————————————————————

/**
 * 采集"当前帧结束时"的只读快照。
 *
 * 三条确定性纪律：
 * 1. **只读**：只调现成的读数函数（`effectiveStat` / `effectiveDotStacks` / `speedMultiplier` /
 *    `actionPeriodCs`），不写任何状态字段、不碰 `state.rng` ⇒ 开与不开不改变任何判定；
 * 2. **固定次序**：玩家 `[1, 2]`、卡牌（方 → `slot` 升序）、`stats`（键名升序）、
 *    `statuses`（状态名升序）、DOT（`burn` → `poison` → `regen`）—— 不依赖 `Map` / `Set` 遍历序；
 * 3. **可序列化**：`Infinity` 一律转 `null`（`JSON.stringify(Infinity)` 会变 `null`，不如显式表达）。
 */
function snapshotFrame(state: BattleState, events: readonly FrameEvent[]): FrameSnapshot {
  const players: FramePlayer[] = []
  for (const side of [1, 2] as const) players.push(snapshotPlayer(state, state.players[side]))

  const cards: FrameCard[] = []
  for (const side of [1, 2] as const) {
    // 摆盘顺序即加载顺序，但**不依赖它**：显式按 slot 升序，序列化结果与数组原始次序无关
    const board = [...state.players[side].board].sort((left, right) => left.slot - right.slot)
    for (const boardCard of board) cards.push(snapshotCard(state, boardCard))
  }

  return {
    triggerFrame: state.triggerFrame,
    timeCs: state.timeCs,
    finished: state.finished,
    winner: state.winner,
    players,
    cards,
    auras: [...state.auras.entries],
    events,
  }
}

/** 某一方的一帧读数（DOT 恒三项，顺序固定） */
function snapshotPlayer(state: BattleState, player: PlayerState): FramePlayer {
  const dots: FrameDot[] = []
  for (const kind of DOT_STAT_KEYS) {
    const remaining = dotRemainingCs(player, kind)
    dots.push({
      kind,
      stacks: effectiveDotStacks(state, player, kind),
      ...(remaining === undefined ? {} : { remainingCs: remaining }),
    })
  }
  return { id: player.id, hp: player.hp, maxHp: player.maxHp, shield: player.shield, dots }
}

/**
 * 某种持续效果的"最长剩余时长"（cs）。
 *
 * `undefined` 表示**常驻**：无实例（层数可能整份来自光环派生态）或存在任一无时长的实例。
 */
function dotRemainingCs(player: PlayerState, kind: DotKind): number | undefined {
  let longest: number | undefined
  for (const dot of player.dots) {
    if (dot.kind !== kind) continue
    if (dot.remainingCs === undefined) return undefined
    longest = longest === undefined ? dot.remainingCs : Math.max(longest, dot.remainingCs)
  }
  return longest
}

/** 场上某张卡的一帧读数 */
function snapshotCard(state: BattleState, boardCard: BoardCard): FrameCard {
  // 数值键 = 卡面自带 ∪ 本局出现过的修正键 ∪ **当前生效附魔自带的键**；
  // `speed` 单独给（它不走 effectiveStat，见 state.ts）
  const keys = new Set<string>(Object.keys(boardCard.card.stats))
  for (const modifier of boardCard.stats) keys.add(modifier.stat)
  // ⚠️ 附魔的 `stats` 是"并入卡面基础层"的第三来源：不把它的键收进来，挂上绿宝石后
  //    卡面数值行永远不会出现"疗"（`effectiveStat('heal')` 有值，但键不在表里 ⇒ 不渲染）。
  for (const key of Object.keys(activeEnchantOf(boardCard)?.stats ?? {})) keys.add(key)
  keys.delete('speed')
  const stats: FrameStat[] = [...keys]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((stat) => ({ stat, value: effectiveStat(state, boardCard, stat) }))

  const statuses: FrameStatus[] = boardCard.statuses
    .map((status) => ({ kind: status.kind, remainingCs: status.remainingCs }))
    .sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))

  const periodCs = actionPeriodCs(boardCard)
  return {
    instanceId: boardCard.instanceId,
    owner: boardCard.owner,
    slot: boardCard.slot,
    gaugeCs: boardCard.gaugeCs,
    periodCs: Number.isFinite(periodCs) ? periodCs : null,
    actionCount: boardCard.actionCount,
    destroyed: boardCard.destroyed,
    stats,
    speed: speedMultiplier(boardCard),
    statuses,
    ...(boardCard.enchant === undefined ? {} : { enchant: boardCard.enchant }),
  }
}

/**
 * 引擎当前会广播的事件词（书写顺序 = 时机词表顺序；只影响同帧多事件的**收集**次序）。
 *
 * **玩家侧**
 * - `battle_start`：开局，在 `runBattle` 初始化阶段广播一次（不在触发帧循环里）。
 * - `on_player_damaged`：玩家真的掉血后（观测结果 `amount > 0` 才广播）。
 * - `on_player_healed`：`heal_player` 结算后 —— **满血 0 治疗也算一次发生**（`amount` 可为 0）。
 * - `on_shield_gained`：`shield` 真的加上护盾后（`amount > 0` 才广播；加 0 不算"获得护盾"）。
 * - `on_shield_broken`：护盾池被**一次伤害从 >0 打空**的那一次（`overflow` = 溢出到血量的伤害）。
 *
 * **行动 / 卡牌侧**
 * - `after_action`：任意卡牌主动行动**完成之后**（主循环步骤 1 无条件广播，
 *   **不看该卡有没有 `kind: active` 效果**）。
 * - `on_card_destroyed` / `on_card_repaired`：`destroy` / `repair` 的每条观测结果各广播一次
 *   （**对未失效的卡 `repair` 也算一次发生**，与"满血 0 治疗"同一口径）。
 * - `on_card_frozen` / `on_card_hasted` / `on_card_slowed`：`apply_status` 按 `status` 分派
 *   （参数 `duration` 单位 = **秒**，与 YAML 的书写单位一致）。
 * - `on_card_charged`：`charge` 的每条观测结果各广播一次（参数 `amount` 单位 = **秒**）。
 *
 * **持续效果跳变侧**
 * - `on_burn_tick` / `on_poison_tick` / `on_regen_tick`：`advanceDots` 本次**到点的每个种类**各广播一次
 *   （参数 `player` + `stacks` = 该种类结算前的派生态读数 + `damage`（灼烧 / 剧毒）或 `heal`（再生）；
 *   剧毒与再生合并净值结算时，两个词各给**自己的分量**，实际血量变化看 `on_player_damaged`）。
 *   来源 = 该持续效果实例（`dot:<kind>@<承受方>`）—— **双方各自的灼烧是两个来源**。
 *   ⚠️ 再生是回血，**不借用** `on_player_damaged`：后者只由真的造成伤害的结算广播。
 *
 * **内部事件**（不对外开放、不进时机词词典，但会进帧快照）
 * - `active_action`：一次主动行动"记账"时（条满的那一 cs）广播，见 `ACTIVE_ACTION_EVENT`。
 * - `shield_spent`：护盾被消耗时（`absorbed > 0`）广播，见 `SHIELD_SPENT_EVENT`。
 *
 * 一次动作作用 N 张卡 ⇒ **N 个事件实例**（目标不同）⇒ 唤醒 N 次；
 * 但每个触发器**每限流窗口（20cs）只释放一条**，多出来的顺延。
 * 数组顺序不影响结算顺序：本轮收集到的触发器全部并入同一个优先队列，由 `comparePending` 统一排序。
 *
 * **尚无广播点的时机词**（写在卡面上不会触发）：`before_action`、`battle_end`。
 */
const EVENT_WORDS = [
  'battle_start',
  'active_action',
  'shield_spent',
  'after_action',
  'on_player_damaged',
  'on_player_healed',
  'on_shield_gained',
  'on_shield_broken',
  'on_card_destroyed',
  'on_card_repaired',
  'on_card_frozen',
  'on_card_hasted',
  'on_card_slowed',
  'on_card_charged',
  'on_burn_tick',
  'on_poison_tick',
  'on_regen_tick',
] as const

/**
 * 收集**卡牌被动**并入队：`trigger.event` 精确匹配 + `condition` 为真；
 * 卡牌被 destroy 后被动停用。
 *
 * 本函数**按事件词调用**：主循环对每个命中事件调用一次，`event` 是本次要匹配的时机词。
 * 因为匹配是精确的（`ability.trigger?.event !== event` 直接 return），
 * 一帧内多次调用不会让同一条被动重复入队。
 */
function collectPassives(
  state: BattleState,
  queue: EventQueue,
  instance: EventInstance,
): void {
  // 本**实例**的参数快照（同实例多次广播取最后一次）——唤醒时随触发器一起记住
  const { event, vars } = instance
  for (const side of [1, 2] as const) {
    const player = state.players[side]

    for (const boardCard of player.board) {
      if (boardCard.destroyed) continue
      const abilities = boardCard.card.abilities ?? []
      abilities.forEach((ability, index) => {
        if (ability.kind !== 'passive') return
        if (ability.trigger?.event !== event) return
        // 唤醒 = 往该触发器的待释放队列压一条（条件与数值都留到释放那一刻再算）
        queue.pushRelease(`${String(side)}|${boardCard.instanceId}#${String(ability.id)}`, {
          actor: `${boardCard.instanceId}#${String(ability.id)}`,
          sourceKind: 'passive',
          priority: priorityOf(ability),
          loadOrder: boardCard.loadOrder,
          tieBreak: index,
          actions: ability.actions.map((spec) => ({ spec, self: boardCard, side })),
          condition: ability.condition,
          side,
          self: boardCard,
          vars,
        })
      })
    }
  }
}

/**
 * 开局体检：播报"既没有触发器也没有光环"的技能。
 *
 * `Skill.trigger` 自 **选填**，服务的是"纯光环技能"（只有 `aura`、不绑时机）。
 * 光环自 已实现（`engine/aura.ts`）⇒ **带 aura 的技能是合法写法，不再点名**；
 * 只有"既不写 trigger 也不写 aura"的技能才会整局无任何结算 —— 这**不是错误**（不抛错），
 * 但几乎肯定是作者漏写了东西，所以开局点名一次，时刻 = 触发帧 0（初始化阶段）。
 */
function reportInertSkills(state: BattleState, emit: (message: LogMessage) => void): void {
  for (const side of [1, 2] as const) {
    for (const skill of state.players[side].skills) {
      // 有触发器（按时机结算）或带光环（每触发帧持续施加）都算"有内容"
      if (skill.trigger !== undefined || skill.aura !== undefined) continue
      emit({
        level: 'note',
        code: 'skill.no_trigger_no_aura',
        tick: state.triggerFrame,
        side,
        actor: `技能:${skill.id}`,
        data: { skill: skill.id },
      })
    }
  }
}

/**
 * 收集**技能**并入队：技能绑定时机词（`Skill.trigger`，与卡牌被动同语义），
 * 只有"本实例的事件词"命中该技能的技能才进入候选。
 *
 * **按事件实例收集**（由 `drainEffects` 逐实例调用）：同一实例只命中一次，故技能不会因
 * "同一处理点命中 N 个事件词"而结算 N 次；而**不同实例各自命中一次**。
 *
 * 加载顺序视为最低（`SKILL_LOAD_ORDER_BASE`），故同优先级时技能后于卡牌被动结算。
 */
function collectSkills(
  state: BattleState,
  queue: EventQueue,
  instance: EventInstance,
): void {
  for (const side of [1, 2] as const) {
    const player = state.players[side]

    player.skills.forEach((skill, index) => {
      // `trigger` 选填：不写就没有匹配条件 ⇒ 永不进触发栈（而非每帧结算）。
      // 这类技能由 `reportInertSkills` 在开局播报一条 NOTE，收集阶段静默跳过。
      if (skill.trigger === undefined) return
      if (skill.trigger.event !== instance.event) return
      // 唤醒 = 往该技能的待释放队列压一条（条件与数值都留到释放那一刻再算）
      queue.pushRelease(`${String(side)}|技能:${skill.id}`, {
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
        vars: instance.vars,
      })
    })
  }
}

/**
 * 主动行动的**效果来源**：只取 `kind: active` 的条目（实现见 `activeSpecsFor` / `recordAction`）。
 *
 * 卡的主动 / 被动属性**只由 `cooldown` 决定**，与有没有写 `kind: active` 无关：
 * - `cooldown !== -1` = 主动卡。行动条充满就是"使用该卡"：即使一条 `kind: active` 都没写
 *   （或被 `everyN` 全部过滤掉），这次行动也照常记账、照常广播 `after_action`，
 *   只是不产生任何效果——`actions` 为空是合法状态，不是错误。
 * - `cooldown: -1` = 纯被动卡。卡面上**写了 `kind: active` 也完全无效**，且不受充能影响：
 *   唯一闸门是 `actionPeriodCs` 对它返回 `Infinity`，主循环据此跳过（既不充能也不满条），
 *   `recordAction` 因此永远不会被它调用。引擎不为此报错、也不新增错误码。
 *
 * 卡牌**没有内置普攻 / 基础行动**——`stats.atk` 只是"可被引用、可被 buff 的数值"，
 * 引擎不会自动把它变成伤害。想把 `atk` 打出去，卡面必须自己写一条
 * `{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }`。
 */
