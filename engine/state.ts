// 状态构建、数值计算与快照

// 职责边界：本文件只做"建立初始状态 / 计算当前有效数值 / 复制状态"，
// **不含战斗流程**（流程在 tick.ts，原语在 primitives.ts）。

// 时间模型：
//   - **全局帧**（global frame）= 0.01s = 1cs，是**一切连续量的唯一推进步长**：
//     行动条 gauge、灼烧/剧毒/再生周期、状态与 buff 时长；
//   - **触发帧**（trigger frame）= 0.2s = 20 全局帧，只决定"该不该结算被动/技能"
//     以及主动行动的**执行时机**（行动条何时被消费）；
//   - 拆两级的硬理由：灼烧周期 0.5s ÷ 0.2s = 2.5 除不尽，单颗粒度会让 debuff
//     相位在"隔 2 帧 / 隔 3 帧"之间抖动。
//   - **引擎内部时间量一律是以 cs 计的整数**（`timeCs` / `gaugeCs` / `remainingCs` /
//     `status.remainingCs`），只在对外接口按秒写出/读入（`secondsToCs` / `csToSeconds`）。

// 所有平衡数值集中在下方常量区并标注【平衡待定】—— 第 5 条：
// 只实现机制、不填平衡数值。
import { Rng } from './rng.ts'
import { buildBoardCards, validatePlacements, type BoardError, type Placement } from './board.ts'
import type {
  AuraSnapshot,
  AuraTotals,
  BattleOptions,
  BattleState,
  BoardCard,
  CardStatus,
  DotKind,
  EnchantDef,
  PlayerId,
  PlayerState,
  Skill,
} from './types.ts'

// ————————————————————————————————————————————————————————
// 时间常量
// ————————————————————————————————————————————————————————

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
 * 效果处理点步长（cs）：**5cs**（0.05s）。
 *
 * 三级节拍的中层：**行动条满只在那一 cs "记账"**（归零、计数、入队），
 * **效果**等到最近的"处理点"才结算 —— 于是"即时"（最多晚 0.04s）与"限流"分开：
 * 结算节拍看它，**限流**只看 `TRIGGER_FRAME_CS`（每触发器每 20cs 至多释放一条）。
 *
 * 与其它网格的关系：`5` 整除 `20` / `50` / `100` ⇒ 触发帧、灼烧、毒 / 再生的跳点都落在处理点上，
 * 不需要为它们做特殊处理。
 */
export const EFFECT_TICK_SECONDS = 0.05
/** 效果处理点步长（cs）：5cs */
export const EFFECT_TICK_CS = Math.round(EFFECT_TICK_SECONDS * CS_PER_SECOND)

/**
 * 单局时间上限（秒）：180.00s。
 *  第 2 条：到达上限判平局，平局视为我方（sideA）获胜。
 */
export const MAX_TIME_SECONDS = 180
/** 单局时间上限（cs）：18000cs */
export const MAX_TIME_CS = MAX_TIME_SECONDS * CS_PER_SECOND
/**
 * 单局时间上限（触发帧）：900 帧。
 * 名称沿用文档里的旧称 MAX_TICK，但**单位已从"0.2s 单粒度 tick"改为"触发帧"**。
 */
export const MAX_TRIGGER_FRAME = MAX_TIME_CS / TRIGGER_FRAME_CS

/**
 * 行动周期的**绝对下限** 1s（= 100cs）。
 *
 * 口径沿革：草时只用于"加速把间隔压到 1s 以下"的场景；** 收紧为对一切卡牌生效**
 * （ ``，RW：「加速效果和 cd 小于 1 的全部控制到最终周期为 1s……目标是保证
 * 一张卡没有充能（charge）推进的情况下，一秒只能动一次」）—— 见 `actionPeriodCs`。
 */
export const MIN_ACTION_PERIOD_CS = 1 * CS_PER_SECOND

/** 持续效果周期，单位 cs（= 结算网格步长） */
export const DOT_PERIOD_CS: Readonly<Record<'burn' | 'poison' | 'regen', number>> = {
  burn: 50,
  poison: 100,
  regen: 100,
}

/**
 * 某个持续效果在给定的全局帧（cs）是否为**结算点**。
 *
 * 相位口径 = **按全局 cs 网格对齐**，与施加时刻无关：
 * 灼烧每 50cs（0.5s）、剧毒与再生每 100cs（1s）；
 * `100 = 5 × 20` 恰好落在触发帧末尾（每 5 个触发帧的末尾），
 * `50 = 2.5 × 20` 除不尽 ⇒ 灼烧的跳变会落在触发帧中间（按最细颗粒度 1cs 判定）。
 *
 * @param timeCs 当前全局时刻（cs，正整数；0 = 开局，尚无结算）
 */
export function isDotTickAt(kind: DotKind, timeCs: number): boolean {
  return timeCs > 0 && timeCs % DOT_PERIOD_CS[kind] === 0
}
/** 灼烧每次跳伤后保留的层数比例（-20%） */
export const BURN_DECAY_RATIO = 0.8
/**
 * 持续效果层数的"视为已清空"阈值。
 * 灼烧每跳 ×0.8 是指数衰减，取整会卡死在 1 层，故累加器内部保留小数、只在读取时取整。
 * 文档原值是 0.01；本实现的层数取值粒度要么是 1（层）、要么是 0.05 的整数倍
 * ，两者都不落在 (0, 0.01) 区间内，故 0.01 与 0 在本实现里等价。
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
    throw new Error(`时间量最多两位小数，收到 ${String(seconds)}s；换算得 ${String(cs)}cs 不是整数`)
  }
  return cs
}

/**
 * cs → 秒（供日志与界面显示）。
 *
 * 浮点除法必然引入表示误差，
 * 故先四舍五入到 2 位小数，保证输出稳定、可逐字节比对（确定性要求）。
 */
export function csToSeconds(cs: number): number {
  return Math.round(cs) / CS_PER_SECOND
}

/** 全局帧数 → 秒（显示用） */
export function framesToSeconds(frames: number): number {
  return csToSeconds(frames * GLOBAL_FRAME_CS)
}

// ————————————————————————————————————————————————————————
// 平衡待定数值【平衡待定】
// ————————————————————————————————————————————————————————
/**
 * 玩家初始血量的**兜底值**（ 定型， /  ``）。
 *
 * 开局血量按**三级优先级**取（`BattleOptions` 的 `hpA` / `maxHpA` / `hpB` / `maxHpB`）：
 *   ① 阵容文件 `decks/*.yml` 的 `hp` / `maxHp`（显式覆盖，调试 / 模拟模式专供）
 *   → ② 阵容引用的**角色**的 `initHp` / `initMaxHp`（`cards/map.ts` 的 `mapHero`）
 *   → ③ **本常量**（`createPlayer` 的缺省参数）。
 *
 * 保留本常量只为**没有阵容文件时的兜底** —— 保证 `simulator/run.ts` 裸跑
 * `--seed 42`（`demo-deck` 路径）的输出**逐字节不变**。真正的血量来源是角色文件。
 * 关联：、YAML ）/ （角色）、[simulator/deck.ts](../simulator/deck.ts)。
 */
export const INITIAL_HP = 300
/** 护盾缺省值（shield 原语未生效前为 0） */
export const INITIAL_SHIELD = 0
/** 冷却百分比系数缺省值 */
export const DEFAULT_CDP = 100
/** 速度倍率缺省值 */
export const DEFAULT_SPEED = 1
/** 状态系数 */
export const HASTE_MULTIPLIER = 2
export const SLOW_MULTIPLIER = 0.5
export const FREEZE_MULTIPLIER = 0

// ————————————————————————————————————————————————————————
// 有效数值计算（buff / 状态参与后的当前值）
// ————————————————————————————————————————————————————————

/**
 * 某张卡**当前生效的附魔定义**（`BoardCard.enchant` → `card.enchantments` 里那一件）。
 *
 * `enchant` 是**运行期状态**（卡面不写，由 `do: enchant` 施加）。三条约定：
 * 1. 没写 `enchant`（或写了但目录里找不到 —— 数据被替换 / id 写错）⇒ 视为**没有附魔**，不抛错；
 * 2. "整件替换"天然成立：一切派生（`stats` 并入 / 光环来源 / 附加动作）都**只认当前这一件**，
 *    换 id 即整体切换 ⇒ **不存在"残留旧附魔"的清除路径**；
 * 3. 纯只读访问器：不改状态、不耗 rng，可在求值期任意调用。
 *
 * @param boardCard 场上卡牌实例
 * @returns 生效中的附魔定义；没有则 `undefined`
 */
export function activeEnchantOf(boardCard: BoardCard): EnchantDef | undefined {
  const id = boardCard.enchant
  if (id === undefined) return undefined
  return (boardCard.card.enchantments ?? []).find((enchant) => enchant.id === id)
}

/**
 * 某张卡的某个 stat 当前值（ 的 `self.<stat>`，**含光环**）。
 *
 * 计算顺序是 第 1 条（唯一权威）：
 *   `（卡面基础值 + 局内 buff 修正 + Σ平铺光环）×（1 + Σ(factor − 1))`，**最后只取整一次**。
 * 倍率之间**加算**；中间过程一律不取整。
 *
 * **附魔自带的 `stats` 并入"卡面基础值"这一层**（`activeEnchantOf` 那一件，缺省 0）：
 * 于是它既参与倍率，也让这张卡"具有"该属性（选择器 / 是否治疗卡的判定都能看见）。
 * 光环取自 `state.auras`（触发帧边界重建的派生态快照，见 engine/aura.ts）。
 * 取整不改变既有行为：本仓全部 stats 都是整数时 `Math.round(x) === x`。
 * **速度不走这里**（光环不得作用于 speed；速度只有状态系数，见 `speedMultiplier`）。
 */
export function effectiveStat(state: BattleState, boardCard: BoardCard, stat: string): number {
  let total = preAuraStat(boardCard, stat)
  const aura = state.auras.cards.get(boardCard.instanceId)?.get(stat)
  if (aura !== undefined) total = (total + aura.flat) * (1 + aura.factor)
  return Math.round(total)
}

/**
 * `effectiveStat` 的**前两层**：卡面基础（含附魔自带 `stats`）+ 局内 buff 修正，**不含光环层**、
 * **不取整**。
 *
 * 用途只有一处：**光环定义里的表达式求值**（`amount: { ref: self.atk }`）——
 * 光环的数额不能读"被其它光环加成过的值"，否则
 * ① "本卡治疗 + 等同于攻击" 这类写法会逐帧自增（自我放大）；
 * ② 读到的是上一帧快照，结果会随帧序漂移（同一场景换个帧边界结果就变）。
 * 于是口径 = **光环里的引用只看"卡面 + buff"**，与光环叠加顺序无关。
 */
export function preAuraStat(boardCard: BoardCard, stat: string): number {
  const enchantStats = activeEnchantOf(boardCard)?.stats
  // 卡面基础层 = （卡面值 **被阵容覆盖**） + 附魔自带 stats（C5 叠加次序）
  const base = boardCard.statOverrides?.[stat] ?? boardCard.card.stats[stat] ?? 0
  let total = base + (enchantStats?.[stat] ?? 0)
  for (const modifier of boardCard.stats) {
    if (modifier.stat === stat) total += modifier.amount
  }
  return total
}

/**
 * 某个玩家某一种持续效果的**派生态层数**。
 *
 * = `Σ 该玩家该种类的实例 stacks + 光环贡献`，对外读取时取整。
 * 光环**不落状态**：不新建 `DotInstance`、不改 `stacks`、不参与 `×BURN_DECAY_RATIO` 衰减；
 * 来源离场后下一触发帧重建快照即自然消失。
 *
 * 跳伤（`advanceDots`）、条件比较（`expr.ts` 的 `own_player.burn` 等）与界面读数都走这里，
 * 保证"看到的层数 = 算伤害用的层数"。
 */
export function effectiveDotStacks(state: BattleState, player: PlayerState, kind: DotKind): number {
  return Math.round(preAuraDotStacks(player, kind) + (state.auras.dots.get(`${player.id}:${kind}`) ?? 0))
}

/**
 * 玩家某一种持续效果的**实例层数之和**（不含光环贡献、不取整）。
 *
 * 与 `preAuraStat` 同一用途：光环定义里的表达式（`amount: { ref: own_player.burn }`）只读这一层，
 * 免得"给灼烧加层数的光环"把自己的贡献读回来逐帧翻倍。
 */
export function preAuraDotStacks(player: PlayerState, kind: DotKind): number {
  let total = 0
  for (const dot of player.dots) {
    if (dot.kind === kind) total += dot.stacks
  }
  return total
}

/** 该卡当前是否处于某个状态 */
export function hasStatus(boardCard: BoardCard, kind: CardStatus['kind']): boolean {
  return boardCard.statuses.some((status) => status.kind === kind)
}

/**
 * 速度倍率 = `stats.speed`（缺省 1）× 状态系数。
 * ：三者独立计时、不互相覆盖；冰冻期间加减速不生效（故冰冻优先判定）。
 *
 * 注意：速度倍率是**系数**而非时间量，保留小数。
 */
export function speedMultiplier(boardCard: BoardCard): number {
  if (hasStatus(boardCard, 'freeze')) return FREEZE_MULTIPLIER
  const base = boardCard.card.stats['speed'] ?? DEFAULT_SPEED
  const haste = hasStatus(boardCard, 'haste') ? HASTE_MULTIPLIER : 1
  const slow = hasStatus(boardCard, 'slow') ? SLOW_MULTIPLIER : 1
  return base * haste * slow
}

/**
 * 行动条充满周期（cs）= `max(1s, round(cooldown_cs × cdp ÷ 100 ÷ 速度倍率))`。
 * ：单次中间结果一出现小数就四舍五入、之后按整数算。
 * 速度为 0（冰冻）时返回 Infinity，表示"本全局帧不推进"。
 *
 * **1s 下限**：最终周期**一律不低于 1s**。
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
  // `cooldown: -1` = 纯被动物品（无行动条、无主动行动）→ 永不进入"满条"分支。
  // 必须显式返回 Infinity：若让 cooldown_cs = -1 参与计算会得到负周期，
  // 使 `gaugeCs >= periodCs` 恒真，纯被动卡会每个触发帧都执行一次主动行动。
  if (cooldownCs === -1) return Number.POSITIVE_INFINITY
  const raw = Math.round((cooldownCs * cdp) / 100 / speed)
  // ⚠️  收紧（ ``）：**最终周期一律钳到 ≥ 1s**。
  //    目标是"一张卡在没有 `charge`（充能）推进的情况下，一秒至多动一次"。
  //    旧口径只在"基础周期 ≥ 1s"时才钳，等于允许 `cooldown < 1s` 的卡
  //    本身就快于 1s —— 该豁免**已作废**。
  return Math.max(MIN_ACTION_PERIOD_CS, raw)
}

/**
 * 周期变化后**按比例缩放行动条**，让"进度比例"连续（`gaugeCs ÷ periodCs` 不变）。
 *
 * 口径（)：加速 / 减速的生效与到期会改变 `actionPeriodCs`。若只换分母、不动分子，
 * 进度比例会在那一 cs **跳变**（表现层看到的是进度条"向后退"）。这里按 `新周期 ÷ 旧周期`
 * 缩放 `gaugeCs`（四舍五入），于是**只有斜率变化、没有跳变** —— 与"冰冻期间沿用最近一个
 * 非 `null` 周期"合起来构成一条总口径：**周期变化时保比例**。
 *
 * **冰冻的两端都不缩放**（`finite → Infinity` 与 `Infinity → finite`）：冻住时进度原样保留，
 * 解冻后从原处继续。其余情况（加速 / 减速的生效与到期）一律缩放。
 *
 * @param periodBeforeCs 变化**之前**的周期（调用方在改动状态前用 `actionPeriodCs` 取）
 */
export function syncActionBarPeriod(boardCard: BoardCard, periodBeforeCs: number): void {
  const periodAfterCs = actionPeriodCs(boardCard)
  if (periodAfterCs === periodBeforeCs) return
  if (!Number.isFinite(periodBeforeCs) || !Number.isFinite(periodAfterCs)) return
  boardCard.gaugeCs = Math.max(0, Math.round((boardCard.gaugeCs * periodAfterCs) / periodBeforeCs))
}

/**
 * 充能：把行动条直接推进 `chargeSeconds` 秒。
 *
 * 充能单位是 cs（与 gauge 同单位），故取值口径与 `seconds` 字段一致：
 * YAML 写成秒、两位小数，这里乘 100 取整。速度为 0（冰冻）的卡充能无效。
 *
 * 是否停在满条由调用方（主循环的记账 / 限流）决定 —— "单次充能最多让同一张卡记账一次"
 * 由"同一卡同一 cs 至多记账一次"（`engine/tick.ts` 的 `recordedThisCs`）保证，
 * 而"效果每 20cs 窗口至多一条"由限流窗口保证，故此处不截断 gauge
 * （截断会丢掉余量，等于把充能换算成"上限一整个周期"，使高速卡的实际行动间隔变长）。
 *
 * @param chargeSeconds 充能秒数（两位小数）
 */
export function chargeActionBar(boardCard: BoardCard, chargeSeconds: number): void {
  if (!Number.isFinite(actionPeriodCs(boardCard))) return
  boardCard.gaugeCs += secondsToCs(chargeSeconds)
}

// ————————————————————————————————————————————————————————
// 构建
// ————————————————————————————————————————————————————————

function createPlayer(
  id: PlayerId,
  name: string,
  placements: readonly Placement[],
  skills: readonly Skill[],
  hp: number = INITIAL_HP,
  maxHp: number = hp,
): PlayerState {
  return {
    id,
    name,
    hp,
    maxHp,
    shield: INITIAL_SHIELD,
    board: buildBoardCards(id, placements),
    skills: [...skills],
    dots: [],
  }
}

/**
 * 建立一局战斗的初始状态。
 *
 * 加载顺序：**先本方后敌方、各自从左到右**。
 * 具体做法：sideA 的卡占 `loadOrder` 0..n-1（按 slot 升序），sideB 紧接着排下去。
 * 技能的加载顺序视为**最低**（同优先级时技能后于卡牌被动结算），
 * 故技能的 `loadOrder` 从 `SKILL_LOAD_ORDER_BASE`（1000）起——见 tick.ts 的排序规则。
 *
 * 确定性契约：给定同一 `options`，必然得到结构完全相同的状态。
 *
 * 注意：**不做"必须写主动效果"的校验**。卡的主动/被动属性只由 `cooldown` 决定
 * ：`cooldown !== -1` 就是主动卡，没有 `kind: active` 也照常走行动条、
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
    1: {
      ...createPlayer(1, options.playerAName, options.boardA, options.skillsA ?? [], options.hpA, options.maxHpA),
      board: withLoadOrder(boardA, 0),
    },
    2: {
      ...createPlayer(2, options.playerBName, options.boardB, options.skillsB ?? [], options.hpB, options.maxHpB),
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
    messages: [],
    // 语言表是**纯数据引用**：只影响文本渲染，不参与判定（`exactOptionalPropertyTypes`
    // 下不能写成 `locale: undefined`，故按"有才写"展开）
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    auras: emptyAuras(),
  }
}

/** 校验双方摆盘（几何合法性）；返回全部错误，空数组 = 合法 */
export function validateBattleInput(options: BattleOptions): BoardError[] {
  return [...validatePlacements(1, options.boardA), ...validatePlacements(2, options.boardB)]
}

// ————————————————————————————————————————————————————————
// 光环派生态快照（每触发帧由 engine/aura.ts 的 refreshAuras 整体重建）
// ————————————————————————————————————————————————————————

/** 空光环快照：开局阶段（尚未到第一个触发帧边界）等价于"没有任何光环生效" */
export function emptyAuras(): AuraSnapshot {
  return {
    entries: [],
    cards: new Map<string, ReadonlyMap<string, AuraTotals>>(),
    dots: new Map<string, number>(),
  }
}

/**
 * 拷贝光环快照。快照本身是只读派生态（每帧整体替换），但快照要完整、
 * 且不能让分支重放共享同一批可变容器 ⇒ 连内层 Map 与合计对象一起复制。
 */
export function cloneAuras(auras: AuraSnapshot): AuraSnapshot {
  const cards = new Map<string, ReadonlyMap<string, AuraTotals>>()
  for (const [instanceId, totalsOfCard] of auras.cards) {
    const copied = new Map<string, AuraTotals>()
    for (const [stat, totals] of totalsOfCard) copied.set(stat, { ...totals })
    cards.set(instanceId, copied)
  }
  return {
    entries: auras.entries.map((entry) => ({ ...entry })),
    cards,
    dots: new Map(auras.dots),
  }
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
    // 消息是纯附加信息（不参与判定），但快照要完整 ⇒ 浅拷贝一层数组即可
    // （元素本身是只读结构，且没有任何地方改写已有消息）
    messages: [...state.messages],
    ...(state.locale === undefined ? {} : { locale: state.locale }),
    auras: cloneAuras(state.auras),
  }
}

/** 取敌方编号（1 ↔ 2） */
export function opponentOf(side: PlayerId): PlayerId {
  return side === 1 ? 2 : 1
}

// ————————————————————————————————————————————————————————
// 每个全局帧的状态推进

// 顺序：先推进持续效果与状态计时，再推进行动条。
// 本文件的两个 advance 函数**只推进、不结算、不判定到期**：
//   - 行动条只把满条者收集起来（返回值），行动由主循环在**满条的那一 cs 记账**（`recordReadyActions`）；
//   - 状态到期由主循环在每个全局帧的到期点移除（destroy 后立刻停用，见 tick.ts）。
// ————————————————————————————————————————————————————————

/**
 * 推进一方的行动条一个全局帧（+1cs，就地修改）。
 *
 * 每张卡用**自己当前**的充满周期换算推进量，而周期含状态系数，
 * 故状态中途生效或到期会自然体现在后续推进里。本函数**只推进**：满条者由主循环
 * （`engine/tick.ts` 的 `recordReadyActions`）在**同一 cs 记账**（条归零 + 计数 + 入队），
 * 效果再由最近的效果处理点结算（`drainEffects`）。
 *
 * @returns 本全局帧内**达到满条**的卡（按 slot 升序 = 加载顺序）。**仅供观察与测试**：
 *   主循环不看它 —— 记账要按 `loadOrder` 排序、还要看"本 cs 是否已记过账"，
 *   故主循环用 `gaugeCs >= actionPeriodCs` 自行重新挑选（见 `recordReadyActions`）。
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
 * 消费发生在**记账那一 cs**（"条满即归零"，见 `engine/tick.ts` 的 `recordAction`）——
 * 这正是"行动后归零立即发生"的落点：旧口径把它推迟到触发帧边界，观感上表现为"满条后还要等"。
 * 余量（`gaugeCs - periodCs`）**保留**，故消费后 `gaugeCs` 已经是下一轮的起点，下一 cs 继续走新条。
 * "同一张卡同一 cs 至多记账一次"由主循环的 `recordedThisCs` 保证。
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
 * ：三者独立计时、不互相覆盖；冰冻期间加减速不生效但**时长照减**。
 * 这里只递减、不移除到期项（到期移除在 `pruneCardStatuses`）。
 */
export function advanceCardStatuses(player: PlayerState): void {
  for (const boardCard of player.board) {
    if (boardCard.statuses.length === 0) continue
    for (const status of boardCard.statuses) status.remainingCs -= GLOBAL_FRAME_CS
  }
}

/** 移除已到期的卡牌状态（先递减、再判到期：剩余 ≤ 0 即到期）；周期若因此变化则**按比例缩放行动条** */
export function pruneCardStatuses(player: PlayerState): void {
  for (const boardCard of player.board) {
    if (boardCard.statuses.length === 0) continue
    const periodBeforeCs = actionPeriodCs(boardCard)
    const kept = boardCard.statuses.filter((status) => status.remainingCs > 0)
    if (kept.length === boardCard.statuses.length) continue
    boardCard.statuses = kept
    syncActionBarPeriod(boardCard, periodBeforeCs)
  }
}
