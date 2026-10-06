// 状态构建、数值计算与快照
//
// 职责边界：本文件只做"建立初始状态 / 计算当前有效数值 / 复制状态"，
// **不含战斗流程**（流程在 tick.ts，原语在 primitives.ts）。
//
// 时间模型（规则 §14 v0.19 两级颗粒度，见 docs/待办.md 条目 14/15）：
//   - **全局帧**（global frame）= 0.01s = 1cs，是**一切连续量的唯一推进步长**：
//     行动条 gauge、灼烧/剧毒/再生周期、状态与 buff 时长；
//   - **触发帧**（trigger frame）= 0.2s = 20 全局帧，只决定"该不该结算被动/技能"
//     以及主动行动的**执行时机**（行动条何时被消费）；
//   - 拆两级的硬理由：灼烧周期 0.5s ÷ 0.2s = 2.5 除不尽，单颗粒度会让 debuff
//     相位在"隔 2 帧 / 隔 3 帧"之间抖动。
//   - **引擎内部时间量一律是以 cs 计的整数**（`timeCs` / `gaugeCs` / `remainingCs` /
//     `nextTickCs`），只在对外接口按秒写出/读入（`secondsToCs` / `csToSeconds`）。
//
// 所有平衡数值集中在下方常量区并标注【平衡待定】——AGENT.md §9 第 5 条：
// 只实现机制、不填平衡数值。
import { Rng } from './rng.ts'
import { buildBoardCards, validatePlacements, type BoardError, type Placement } from './board.ts'
import type {
  BattleOptions,
  BattleState,
  BoardCard,
  CardStatus,
  PlayerId,
  PlayerState,
  Skill,
} from './types.ts'

// ————————————————————————————————————————————————————————————
// 时间常量（规则 §14：全局帧 0.01s + 触发帧 0.2s；MAX_TIME = 180.00s）
// ————————————————————————————————————————————————————————————

/** 全局帧步长（秒）：0.01s */
export const GLOBAL_FRAME_SECONDS = 0.01
/** 1 秒 = 100cs（centisecond，厘秒 = 全局帧） */
export const CS_PER_SECOND = 100
/** 一个全局帧 = 1cs */
export const GLOBAL_FRAME_CS = 1
/** 触发帧步长（秒）：0.2s——只约束触发结算与主动行动的执行时机 */
export const TRIGGER_FRAME_SECONDS = 0.2
/** 1 触发帧 = 20 全局帧 = 20cs */
export const GLOBAL_FRAMES_PER_TRIGGER_FRAME = 20
/** 触发帧步长（cs）：20cs */
export const TRIGGER_FRAME_CS = GLOBAL_FRAMES_PER_TRIGGER_FRAME * GLOBAL_FRAME_CS

/**
 * 单局时间上限（秒）：180.00s。
 * 规则 §3 第 2 条：到达上限判平局，平局视为我方（sideA）获胜。
 */
export const MAX_TIME_SECONDS = 180
/** 单局时间上限（cs）：18000cs */
export const MAX_TIME_CS = MAX_TIME_SECONDS * CS_PER_SECOND
/**
 * 单局时间上限（触发帧）：900 帧。
 * 名称沿用文档里的旧称 MAX_TICK，但**单位已从"0.2s 单粒度 tick"改为"触发帧"**。
 */
export const MAX_TRIGGER_FRAME = MAX_TIME_CS / TRIGGER_FRAME_CS

/** 加速的等效行动间隔下限（规则 §5："加速的等效行动间隔最短不低于 1s"），单位 cs */
export const MIN_ACTION_PERIOD_CS = 1 * CS_PER_SECOND

/** 持续效果周期（规则 §18：灼烧每 0.5s 跳伤并 -20% 层数；剧毒每 1s 跳伤且不衰减；再生每 1s 回血），单位 cs */
export const DOT_PERIOD_CS: Readonly<Record<'burn' | 'poison' | 'regen', number>> = {
  burn: 50,
  poison: 100,
  regen: 100,
}
/** 灼烧每次跳伤后保留的层数比例（-20%） */
export const BURN_DECAY_RATIO = 0.8
/**
 * 持续效果层数的"视为已清空"阈值（规则 §14 的层数小数豁免）。
 * 灼烧每跳 ×0.8 是指数衰减，取整会卡死在 1 层，故累加器内部保留小数、只在读取时取整。
 * 文档原值是 0.01；本实现的层数取值粒度要么是 1（层）、要么是 0.05 的整数倍
 * （治疗清除 0.05X），两者都不落在 (0, 0.01) 区间内，故 0.01 与 0 在本实现里等价。
 */
export const DOT_MIN_STACKS = 0.01

/**
 * 秒 → cs（整数）。**唯一**的秒/厘秒换算入口：YAML 里的时间量写成"秒、两位小数"，
 * 乘 100 后必然是整数；出现小数则说明数据本身不足两位小数精度，属数据错误。
 *
 * @throws 入参不是有限数、为负、或乘 100 后不是整数
 */
export function secondsToCs(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new Error(`时间量必须是有限数（秒），收到 ${String(seconds)}`)
  if (seconds < 0) throw new Error(`时间量不能为负（秒），收到 ${String(seconds)}`)
  const cs = seconds * 100
  if (!Number.isInteger(cs)) {
    throw new Error(`时间量最多两位小数（0.01s 精度），收到 ${String(seconds)}s；换算得 ${String(cs)}cs 不是整数`)
  }
  return cs
}

/**
 * cs → 秒（供日志与界面显示）。
 *
 * 浮点除法必然引入表示误差（如 1234cs ÷ 100 = 12.340000000000002），
 * 故先四舍五入到 2 位小数，保证输出稳定、可逐字节比对（确定性要求）。
 */
export function csToSeconds(cs: number): number {
  return Math.round(cs) / CS_PER_SECOND
}

/** 全局帧数 → 秒（显示用） */
export function framesToSeconds(frames: number): number {
  return csToSeconds(frames * GLOBAL_FRAME_CS)
}

// ————————————————————————————————————————————————————————————
// 平衡待定数值【平衡待定】
// ————————————————————————————————————————————————————————————
/**
 * 玩家初始血量。
 * TODO(decision): 后续把玩家血量移入**角色设定的 yaml 文档**（每个角色/阵容自带 hp、maxHp），
 * 引擎只读取、不再内置默认值；届时本常量退化为"缺省值兜底"或直接删除。
 * 关联：规则 §2 血量行、模拟模式设计文档 §4.3（双方血量由摆盘界面配置）。
 */
export const INITIAL_HP = 300
/** 护盾缺省值（shield 原语未生效前为 0） */
export const INITIAL_SHIELD = 0
/** 冷却百分比系数缺省值（规则 §5：cdp 缺省 100） */
export const DEFAULT_CDP = 100
/** 速度倍率缺省值（规则 §5：speed 缺省 1） */
export const DEFAULT_SPEED = 1
/** 状态系数（规则 §5：加速 ×2 / 减速 ×0.5 / 冰冻 = 0） */
export const HASTE_MULTIPLIER = 2
export const SLOW_MULTIPLIER = 0.5
export const FREEZE_MULTIPLIER = 0

// ————————————————————————————————————————————————————————————
// 有效数值计算（buff / 状态参与后的当前值）
// ————————————————————————————————————————————————————————————

/** 某张卡的某个 stat 当前值 = 卡面基础值 + 所有修正之和（规则 §8.3 的 `self.<stat>`） */
export function effectiveStat(boardCard: BoardCard, stat: string): number {
  const base = boardCard.card.stats[stat] ?? 0
  let total = base
  for (const modifier of boardCard.stats) {
    if (modifier.stat === stat) total += modifier.amount
  }
  return total
}

/** 该卡当前是否处于某个状态 */
export function hasStatus(boardCard: BoardCard, kind: CardStatus['kind']): boolean {
  return boardCard.statuses.some((status) => status.kind === kind)
}

/**
 * 速度倍率 = `stats.speed`（缺省 1）× 状态系数（加速 ×2 / 减速 ×0.5 / 冰冻 = 0）。
 * 规则 §18.8：三者独立计时、不互相覆盖；冰冻期间加减速不生效（故冰冻优先判定）。
 *
 * 注意：速度倍率是**系数**而非时间量，保留小数（减速 0.5 / 加速 2）。
 */
export function speedMultiplier(boardCard: BoardCard): number {
  if (hasStatus(boardCard, 'freeze')) return FREEZE_MULTIPLIER
  const base = boardCard.card.stats['speed'] ?? DEFAULT_SPEED
  const haste = hasStatus(boardCard, 'haste') ? HASTE_MULTIPLIER : 1
  const slow = hasStatus(boardCard, 'slow') ? SLOW_MULTIPLIER : 1
  return base * haste * slow
}

/**
 * 行动条充满周期（cs）= `round(cooldown_cs × cdp ÷ 100 ÷ 速度倍率)`。
 * 规则 §14：单次中间结果一出现小数就四舍五入、之后按整数算。
 * 速度为 0（冰冻）时返回 Infinity，表示"本全局帧不推进"。
 * 加速后的等效间隔有 1s 下限（规则 §5）。
 *
 * @returns 周期 cs 数；`Infinity` 表示**永不行动**（冰冻，或 `cooldown: -1` 的纯被动物品）
 */
export function actionPeriodCs(boardCard: BoardCard): number {
  const cdp = boardCard.card.stats['cdp'] ?? DEFAULT_CDP
  const speed = speedMultiplier(boardCard)
  if (speed === 0) return Number.POSITIVE_INFINITY
  // Card.cooldown 的单位已是 cs（YAML 读入层负责 secondsToCs 换算；本仓目前无该层，
  // 故 simulator/demo-deck.ts 直接写整数 cs）。
  const cooldownCs = boardCard.card.cooldown
  if (!Number.isInteger(cooldownCs)) {
    throw new Error(`卡牌 ${boardCard.card.id} 的 cooldown 必须是整数 cs，收到 ${String(cooldownCs)}`)
  }
  // 规则 §5：`cooldown: -1` = 纯被动物品（无行动条、无主动行动）→ 永不进入"满条"分支。
  // 必须显式返回 Infinity：若让 cooldown_cs = -1 参与计算会得到负周期，
  // 使 `gaugeCs >= periodCs` 恒真，纯被动卡会每个触发帧都执行一次主动行动。
  if (cooldownCs === -1) return Number.POSITIVE_INFINITY
  const raw = Math.round((cooldownCs * cdp) / 100 / speed)
  // 下限只针对"加速把间隔压到 1s 以下"的情况：cooldown 本身小于 1s 的卡不受此限
  const basePeriodCs = Math.round((cooldownCs * cdp) / 100)
  if (basePeriodCs < MIN_ACTION_PERIOD_CS) return raw
  return Math.max(MIN_ACTION_PERIOD_CS, raw)
}

/**
 * 充能：把行动条直接推进 `chargeSeconds` 秒（规则 §9 charge 原语）。
 *
 * 充能单位是 cs（与 gauge 同单位），故取值口径与 `seconds` 字段一致：
 * YAML 写成秒、两位小数，这里乘 100 取整。速度为 0（冰冻）的卡充能无效。
 *
 * 是否停在满条由调用方（主循环的行动条消费）决定——"单次充能最多触发一次主动行动"
 * 是通过"同一卡同一触发帧最多执行一次主动行动"实现的，故此处不截断 gauge
 * （截断会丢掉余量，等于把充能换算成"上限一整个周期"，使高速卡的实际行动间隔变长）。
 *
 * @param chargeSeconds 充能秒数（两位小数）
 */
export function chargeActionBar(boardCard: BoardCard, chargeSeconds: number): void {
  if (!Number.isFinite(actionPeriodCs(boardCard))) return
  boardCard.gaugeCs += secondsToCs(chargeSeconds)
}

// ————————————————————————————————————————————————————————————
// 构建
// ————————————————————————————————————————————————————————————

function createPlayer(
  id: PlayerId,
  name: string,
  placements: readonly Placement[],
  skills: readonly Skill[],
): PlayerState {
  return {
    id,
    name,
    hp: INITIAL_HP,
    maxHp: INITIAL_HP,
    shield: INITIAL_SHIELD,
    board: buildBoardCards(id, placements),
    skills: [...skills],
    dots: [],
  }
}

/**
 * 建立一局战斗的初始状态。
 *
 * 加载顺序（规则 §6.2 第 2 条）：**先本方后敌方、各自从左到右**。
 * 具体做法：sideA 的卡占 `loadOrder` 0..n-1（按 slot 升序），sideB 紧接着排下去。
 * 技能的加载顺序视为**最低**（同优先级时技能后于卡牌被动结算），
 * 故技能的 `loadOrder` 从 `SKILL_LOAD_ORDER_BASE`（1000）起——见 tick.ts 的排序规则。
 *
 * 确定性契约：给定同一 `options`，必然得到结构完全相同的状态。
 *
 * 注意：**不做"必须写主动效果"的校验**。卡的主动/被动属性只由 `cooldown` 决定
 * （规则 §5）：`cooldown !== -1` 就是主动卡，没有 `kind: active` 也照常走行动条、
 * 照常"使用"并广播 `after_action`（只是不产生效果）；`cooldown: -1` 就是纯被动卡，
 * 卡面上写了 `kind: active` 也一律无效。故这里没有可拒绝的输入。
 */
export function createBattleState(options: BattleOptions): BattleState {
  const boardA = buildBoardCards(1, options.boardA)
  const boardB = buildBoardCards(2, options.boardB)

  // 全局加载序号：sideA 从左到右，然后 sideB 从左到右
  const aCount = boardA.length
  const withLoadOrder = (board: BoardCard[], offset: number): BoardCard[] =>
    board.map((boardCard, index) => ({ ...boardCard, loadOrder: offset + index }))

  const players: Record<PlayerId, PlayerState> = {
    1: { ...createPlayer(1, options.playerAName, options.boardA, options.skillsA ?? []), board: withLoadOrder(boardA, 0) },
    2: {
      ...createPlayer(2, options.playerBName, options.boardB, options.skillsB ?? []),
      board: withLoadOrder(boardB, aCount),
    },
  }

  return {
    seed: options.seed,
    players,
    // 时间原点：t = 0.00s。0 不是触发帧边界（0 % 20 === 0 但帧序号从 1 起）。
    timeCs: 0,
    triggerFrame: 0,
    finished: false,
    winner: null,
    draw: false,
    rng: new Rng(options.seed),
  }
}

/** 校验双方摆盘（几何合法性）；返回全部错误，空数组 = 合法 */
export function validateBattleInput(options: BattleOptions): BoardError[] {
  return [...validatePlacements(1, options.boardA), ...validatePlacements(2, options.boardB)]
}

/** 快照：复制一份完整状态（含 rng 状态），用于分支重放与确定性回归 */
export function cloneState(state: BattleState): BattleState {
  const cloneBoardCard = (boardCard: BoardCard): BoardCard => ({
    ...boardCard,
    stats: boardCard.stats.map((modifier) => ({ ...modifier })),
    statuses: boardCard.statuses.map((status) => ({ ...status })),
  })
  const clonePlayer = (player: PlayerState): PlayerState => ({
    ...player,
    board: player.board.map(cloneBoardCard),
    skills: [...player.skills],
    dots: player.dots.map((dot) => ({ ...dot })),
  })

  return {
    seed: state.seed,
    players: { 1: clonePlayer(state.players[1]), 2: clonePlayer(state.players[2]) },
    timeCs: state.timeCs,
    triggerFrame: state.triggerFrame,
    finished: state.finished,
    winner: state.winner,
    draw: state.draw,
    rng: state.rng.clone(),
  }
}

/** 取敌方编号（1 ↔ 2） */
export function opponentOf(side: PlayerId): PlayerId {
  return side === 1 ? 2 : 1
}

// ————————————————————————————————————————————————————————————
// 每个全局帧（0.01s）的状态推进
//
// 顺序（规则 §15 的 0a / 0b）：先推进持续效果与状态计时，再推进行动条。
// 本文件的两个 advance 函数**只推进、不结算、不判定到期**：
//   - 行动条只把满条者收集起来（`readyForAction`），行动由主循环在触发帧边界消费；
//   - 状态到期由主循环在每个全局帧的到期点移除（destroy 后立刻停用，见 tick.ts）。
// ————————————————————————————————————————————————————————————

/**
 * 推进一方的行动条一个全局帧（+1cs，就地修改）。
 *
 * 每张卡用**自己当前**的充满周期换算推进量，而周期含状态系数（加速 ×2 / 减速 ×0.5），
 * 故状态中途生效或到期会自然体现在后续推进里。本函数**只推进**：满条者只被收集起来，
 * 主动行动由主循环在触发帧边界统一执行并调用 `consumeActionBar`（规则 §15）。
 *
 * @returns 本全局帧内**达到满条**的卡（按 slot 升序 = 加载顺序）；同一张卡可能连续多个
 *   全局帧都在返回值里（gauge 一直 ≥ 周期），主循环靠"触发帧边界收集 + 去重后消费一次"处理
 */
export function advanceActionBar(player: PlayerState): BoardCard[] {
  const ready: BoardCard[] = []
  for (const boardCard of player.board) {
    if (boardCard.destroyed) continue
    if (boardCard.card.cooldown < 0) continue // 纯被动物品：无行动条、无主动行动
    const periodCs = actionPeriodCs(boardCard)
    if (!Number.isFinite(periodCs)) continue
    boardCard.gaugeCs += GLOBAL_FRAME_CS
    if (boardCard.gaugeCs >= periodCs) ready.push(boardCard)
  }
  return ready.sort((a, b) => a.slot - b.slot)
}

/**
 * 消费一次主动行动：行动条减去一个充满周期，余量结转（避免高速卡"丢帧"）。
 *
 * 规则 §15：主动行动在**触发帧边界**执行，故消费也发生在边界（而不是满条的那一全局帧），
 * 这样"同一卡同一触发帧最多执行一次主动行动"（规则 §6.3 第 5 条）得以成立。
 */
export function consumeActionBar(boardCard: BoardCard): void {
  const periodCs = actionPeriodCs(boardCard)
  if (!Number.isFinite(periodCs)) {
    boardCard.gaugeCs = 0
    return
  }
  boardCard.gaugeCs -= periodCs
  if (boardCard.gaugeCs < 0) boardCard.gaugeCs = 0
}

/**
 * 推进一方的卡牌状态计时（加速 / 减速 / 冰冻）一个全局帧。
 * 规则 §18.8：三者独立计时、不互相覆盖；冰冻期间加减速不生效但**时长照减**。
 * 这里只递减、不移除到期项（到期移除在 `pruneCardStatuses`）。
 */
export function advanceCardStatuses(player: PlayerState): void {
  for (const boardCard of player.board) {
    if (boardCard.statuses.length === 0) continue
    for (const status of boardCard.statuses) status.remainingCs -= GLOBAL_FRAME_CS
  }
}

/** 移除已到期的卡牌状态（先递减、再判到期：剩余 ≤ 0 即到期） */
export function pruneCardStatuses(player: PlayerState): void {
  for (const boardCard of player.board) {
    if (boardCard.statuses.length === 0) continue
    boardCard.statuses = boardCard.statuses.filter((status) => status.remainingCs > 0)
  }
}
