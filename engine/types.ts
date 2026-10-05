// 核心类型
//
// 本文件是**公共契约**：修改 CardDef / SkillDef / BattleState 必须同步
// docs/API文档.md 与 docs/YAML数据格式规范.md（AGENT.md §8 文档同步义务）。
//
// 命名与字段对齐既有文档：《规则说明书》、《玩家数据维护.md》（玩家侧 hp / shield）、
// 《卡牌设计细化.md》（单一主动条 + cooldown 秒制）、框架设计 §4.3。
import type { Rng } from './rng.ts'
import type { Placement } from './board.ts'

/** 玩家编号：1 = sideA（模拟发起方，规则规定平局判其胜），2 = sideB */
export type PlayerId = 1 | 2

/** 卡牌尺寸 → 占格数（规则 §2：small 1 / medium 2 / large 3，可被 `slots` 覆盖） */
export type CardSize = 'small' | 'medium' | 'large'

/** 卡牌效果种类（规则 §5：主动挂靠行动条；被动挂触发器） */
export type AbilityKind = 'active' | 'passive'

/** 卡牌状态种类（规则 §18.8：三者独立计时、不互相覆盖） */
export type CardStatusKind = 'haste' | 'slow' | 'freeze'

/** 玩家侧持续效果通道（规则 §18.9：灼烧 / 剧毒 / 再生） */
export type DotKind = 'burn' | 'poison' | 'regen'

// ————————————————————————————————————————————————————————————
// 数值与表达式（规则 §8）
// ————————————————————————————————————————————————————————————

/** 表达式：字面量 / 引用 / 事件参数 / 计数 / 四则（结构在 P1 阶段细化，先定形状） */
export type Expr =
  | number
  | { readonly ref: string }
  | { readonly var: string }
  | { readonly count: string }
  | { readonly add: readonly Expr[] }
  | { readonly sub: readonly Expr[] }
  | { readonly mul: readonly Expr[] }
  | { readonly div: readonly Expr[] }

/** 条件（规则 §8.1） */
export type Condition =
  | { readonly cmp: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'; readonly left: Expr; readonly right: Expr }
  | { readonly not: Condition }
  | { readonly any: readonly Condition[] }
  | { readonly all: readonly Condition[] }

// ————————————————————————————————————————————————————————————
// 卡牌与技能定义
// ————————————————————————————————————————————————————————————

/** 动作原语名（规则 §9 的封闭词表：8 个原语，enchant 已登记但实现搁置） */
export type PrimitiveName =
  | 'dealDamage'
  | 'healPlayer'
  | 'gainStat'
  | 'shield'
  | 'applyStatus'
  | 'charge'
  | 'destroy'
  | 'repair'

/** 一条动作（规则 §9；字段按原语不同而不同，P1 阶段收紧为可辨识联合） */
export interface ActionSpec {
  readonly do: PrimitiveName
  /** 选择器（规则 §10）：self / ownPlayer / enemyPlayer / allEnemyCards / randomOwnCard … */
  readonly target?: string
  readonly stat?: string
  readonly status?: CardStatusKind
  readonly amount?: Expr
  readonly seconds?: Expr
  readonly duration?: Expr
  readonly stackLimit?: number
}

/** 一条能力（规则 §6.1：触发器 = 时机词 + 参数 + 条件 + 动作列表） */
export interface Ability {
  /** 卡内唯一 id（v0.9 起必填），品质继承按它定位覆盖条目 */
  readonly id: number
  readonly kind: AbilityKind
  /** 数值大者优先；缺省 5，范围 1–10。**仅被动使用**——主动不走优先级比较 */
  readonly priority?: number
  /** 被动：时机词（取值见《时机表.md》） */
  readonly trigger?: { readonly event: string }
  readonly condition?: Condition
  readonly actions: readonly ActionSpec[]
  /** 仅本卡第 N 的整数倍次主动行动时结算（缺省每次） */
  readonly everyN?: number
}

/** 卡牌定义（字段全集见《YAML数据格式规范.md》与《卡牌YAML模板.yml》 v0.3.4） */
export interface Card {
  /** 小写下划线，必须与文件名一致（AGENT.md §5.2） */
  readonly id: string
  readonly name: string
  /** ≥1，每次修改任意字段必须 +1，旧版本保留 |
   */
  readonly version: number
  readonly size: CardSize
  /** 覆盖 size 推导的占格数（≥1） */
  readonly slots?: number
  /**
   * 行动条充满周期的基础冷却，单位 **cs（0.01s）整数**。
   * YAML 卡面仍按"秒、两位小数"书写，由读入层用 `secondsToCs()` 换算成本字段
   * （规则 §14：引擎内部时间量一律整数 cs）。
   * `-1` = 纯被动物品（无行动条、无主动行动）。
   */
  readonly cooldown: number
  readonly rarity: string
  readonly description?: string
  readonly owner?: string
  /** 数值表（stats 开放表：atk 必填，speed / cdp / shd / hel / bur / poi / reg / has / sol / fre / chg） */
  readonly stats: Readonly<Record<string, number>>
  /** 行动条充满后主动行动的次数（缺省 1） */
  readonly multicast?: number
  readonly tags?: readonly string[]
  readonly hiddenTags?: readonly string[]
  readonly abilities?: readonly Ability[]
  /** 附魔：常驻效果组，一张卡至多一个（规则 §18.7） */
  readonly enchant?: readonly ActionSpec[]
}

/** 技能定义（规则 §6.2：无冷却；priority 缺省 5、范围 1–10；同优先级时**后于**卡牌被动结算） */
export interface Skill {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly priority?: number
  readonly description?: string
  /**
   * 时机词（取值见《时机表.md》）。**与卡牌被动的 `Ability.trigger` 语义一致**：
   * 只有本触发帧命中了该事件，本技能才会进入候选队列。
   *
   * 为什么必填（P0.6 修正）：技能原先没有任何事件匹配判断，而收集逻辑是按
   * "本帧命中的每个事件词收集一次"驱动的，于是**同一触发帧命中两个事件词时，
   * 每侧技能会在这一帧结算两次**；叠加灼烧 `onPlayerDamaged` 自激后，开局技能
   * 变成每帧反复结算（实测 `--seed 42`：三个技能各 541 次、护盾膨胀到 10 万），
   * 直接导致双方锁血打满 180s。绑上 trigger 后技能才真正只在自己该响的时机响。
   */
  readonly trigger: { readonly event: string }
  /** 技能自带 stats 开放数值表（效果数值只能引用本技能 stats） */
  readonly stats: Readonly<Record<string, number>>
  readonly condition?: Condition
  readonly actions: readonly ActionSpec[]
}

// ————————————————————————————————————————————————————————————
// 运行时状态
// ————————————————————————————————————————————————————————————

/** 一条数值修正（buff / debuff）。层数、时长、来源都要记，供 stackLimit 与刷新逻辑使用 */
export interface StatModifier {
  readonly stat: string
  /** 可累加（同 stat、同 source 再次施加时叠加） */
  amount: number
  readonly source: string
  /** 剩余时长，单位 **cs（厘秒 = 全局帧，0.01s）**，整数；undefined = 常驻（会被刷新） */
  remainingCs?: number
  readonly stackLimit?: number
}

/** 卡牌身上的状态（加速 / 减速 / 冰冻：独立计时、不互相覆盖） */
export interface CardStatus {
  readonly kind: CardStatusKind
  /** 剩余时长，单位 **cs（0.01s）**，整数 */
  remainingCs: number
}

/** 场上一张卡。最小可跑版的"位置"是一等字段，因为行动顺序与相邻选择器都要用它。 */
export interface BoardCard {
  readonly card: Card
  readonly owner: PlayerId
  /** 左侧起始格，1–10（规则 §2） */
  readonly slot: number
  /** 实例 id：同名卡可多张，靠它区分（如 `1-cinder_wolf-3`） */
  readonly instanceId: string
  /**
   * 加载顺序的全局序号（0 基）。
   * 规则 §6.2 第 2 条："先本方后敌方、各自从左到右"——priority 相同时按本序号升序结算。
   */
  readonly loadOrder: number
  /**
   * 行动条累积进度，单位 **cs（厘秒 = 全局帧，0.01s）**，整数，取值 [0, 充满周期)。
   * 每个全局帧 +1（规则 §14："`gauge += 1`/全局帧"），满条则在触发帧边界被消费并结转余量。
   */
  gaugeCs: number
  /** 已执行的主动行动次数（`everyN` 与 charge 特例用它计数） */
  actionCount: number
  /** destroy 原语：失效（仍占位、不行动、被动停用） */
  destroyed: boolean
  /** 战斗内数值修正（含 buff 后的当前值由 `effectiveStat` 计算，不直接写回 card.stats） */
  stats: StatModifier[]
  /** 加速 / 减速 / 冰冻 */
  statuses: CardStatus[]
}

/** 玩家身上的持续效果实例（规则 §18.9：实例 = kind + stacks + duration + source） */
export interface DotInstance {
  readonly kind: DotKind
  /**
   * 层数。**唯一允许保留小数的累加器**（规则 §14 的层数小数豁免）：
   * 灼烧每跳 ×0.8 是指数衰减，逐跳取整会把 1 层卡死在 1 层、永不衰减，
   * 故内部保留小数，只在对外读取（算伤害 / 日志 / 界面 / 条件比较）时取整。
   */
  stacks: number
  /** 剩余时长，单位 **cs（0.01s）**，整数；undefined = 常驻 */
  remainingCs?: number
  readonly source: string
  /** 距离下次周期结算还有多少 cs（灼烧 50cs、剧毒 100cs、再生 100cs），整数 */
  nextTickCs: number
}

/** 玩家状态 */
export interface PlayerState {
  readonly id: PlayerId
  name: string
  hp: number
  maxHp: number
  shield: number
  /** 一行 10 格的摆盘 */
  board: BoardCard[]
  /** 本方的技能（无入场时机，优先级相同时后于卡牌被动结算） */
  skills: Skill[]
  /** 持续效果通道 */
  dots: DotInstance[]
}

/**
 * 一次原语结算的观测结果（日志与触发器判定都读它）。字段固定，不遍历对象键。
 *
 * 定义在本文件（而非 primitives.ts）的原因：`log.ts` 与 `tick.ts` 都要用它，
 * 而 `tick.ts → log.ts` 已存在依赖；放进公共契约文件可避免 `log.ts ↔ tick.ts` 循环 import。
 */
export interface ActionEffect {
  /**
   * 影响种类。**持续效果不单独占一个 kind**：灼烧/剧毒用 `damage`、再生用 `heal`，
   * 具体是哪一种由 `dot` 字段标明（这样"是否造成了伤害"只需看 kind，不必枚举）。
   */
  readonly kind: 'damage' | 'heal' | 'shield' | 'stat' | 'status' | 'charge' | 'destroy' | 'repair'
  readonly targetSide: PlayerId
  /** 玩家侧影响量（伤害 / 治疗 / 护盾均为正数，"方向"由 kind 决定） */
  readonly amount: number
  /** 目标玩家结算后的血量与护盾 */
  readonly hpAfter: number
  readonly shieldAfter: number
  /** 被护盾吸收的量（仅伤害有） */
  readonly absorbed: number
  /** 卡牌侧目标（stat / status / destroy / repair / charge 用） */
  readonly card?: BoardCard
  readonly stat?: string
  readonly status?: CardStatusKind
  /** 持续效果种类：标明本次伤害/治疗来自哪一种持续效果（burn / poison / regen） */
  readonly dot?: DotKind
}

/**
 * 一条动作日志：一次"动作结算"的结构化记录。
 * 纯文本行是它的渲染结果（`engine/log.ts`），客户端将来直接消费本结构。
 */
export interface ActionLog {
  /**
   * 发生本条动作结算的**触发帧序号**（0.2s 一帧，从 1 起；绝对时刻 = 该值 × 0.2s）。
   * 名称沿用旧的 `tick`（原口径下 tick = 0.2s 单粒度），两级时钟落地后它的语义是触发帧；
   * 改名属 P1（会连锁到 `docs/API文档.md` 的日志结构表与 `engine/log.ts`）。
   */
  readonly tick: number
  readonly actorSide: PlayerId
  /** 行动主体：卡牌 instanceId（被动带 `#id`）/ `技能:<id>` / `持续效果:<kind>` */
  readonly actor: string
  readonly sourceKind: 'active' | 'passive' | 'skill' | 'dot'
  /** 本触发帧内的结算序号（1 基），用于展示优先级顺序 */
  readonly ordinal: number
  readonly effects: readonly ActionEffect[]
}

/** 建立对局所需的输入 */
export interface BattleOptions {
  readonly seed: number
  readonly playerAName: string
  readonly playerBName: string
  /** 双方摆盘（含格位） */
  readonly boardA: readonly Placement[]
  readonly boardB: readonly Placement[]
  /** 双方技能（缺省空） */
  readonly skillsA?: readonly Skill[]
  readonly skillsB?: readonly Skill[]
  /**
   * 是否同时生成纯文本日志行（缺省 true）。
   * 批量模拟只关心结果时置 false，可省掉全部字符串拼接。
   */
  readonly includeText?: boolean
}

/** 战斗状态：引擎的全部可变状态都挂在这里，便于快照与重放 */
export interface BattleState {
  readonly seed: number
  readonly players: Record<PlayerId, PlayerState>
  /**
   * 已流逝的**全局帧数**（1 全局帧 = 0.01s = 1cs），整数。
   * 一切连续量（行动条 gauge、持续效果周期、状态与 buff 时长）都按它推进。
   */
  timeCs: number
  /**
   * 当前**触发帧序号**（0.2s 一帧，从 1 起；0 = 开局初始化阶段）。
   * 触发帧只决定"该不该结算被动 / 技能"与"主动行动何时执行"（规则 §14/§15）。
   */
  triggerFrame: number
  finished: boolean
  /** 胜者；平局按规则判 sideA（派发方）胜，故不会是 null（除非异常） */
  winner: PlayerId | null
  /** 是否因超时判的平局 */
  draw: boolean
  /** 随机源。**不得在引擎别处引入任何其他随机来源**（黄金法则 1）。 */
  readonly rng: Rng
}
