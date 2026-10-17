// 核心类型

// 本文件是**公共契约**：修改 CardDef / SkillDef / BattleState 必须同步
// docs/API文档.md 与 docs/YAML数据格式规范.md。

// 命名与字段对齐既有文档：、（玩家侧 hp / shield）、
// （单一主动条 + cooldown 秒制）、框架设计 。
import type { Rng } from './rng.ts'
import type { Placement } from './board.ts'

// `stats` / `stat` 的封闭词表**唯一来源** = `engine/stat-keys.ts`（技术债第 5 条收口，见该文件头）。
export { ALL_STAT_KEYS, DOT_STAT_KEYS, STAT_KEYS } from './stat-keys.ts'

/** 玩家编号：1 = sideA（模拟发起方，规则规定平局判其胜），2 = sideB */
export type PlayerId = 1 | 2

/** 卡牌尺寸 → 占格数（small 1 / medium 2 / large 3，可被 `slots` 覆盖） */
export type CardSize = 'small' | 'medium' | 'large'

/** 卡牌效果种类 */
export type AbilityKind = 'active' | 'passive'

/** 卡牌状态种类 */
export type CardStatusKind = 'haste' | 'slow' | 'freeze'
/** 玩家侧持续效果通道 */
export type DotKind = 'burn' | 'poison' | 'regen'

// ————————————————————————————————————————————————————————
// 数值与表达式
// ————————————————————————————————————————————————————————

/**
 * 选择器查询对象。
 *
 * 与字符串缩写是**两种等价写法**：`random_own_card` ≡ `{ side: 'own', random: true, limit: 1 }`，
 * 且必须**逐位 rng 一致**。
 *
 * 求值顺序固定：候选池（`from` / `zone` / `side`）→ `destroyed` → `tags` / `tagMode`
 * → `filter` → 洗牌（`random`）或排序（`sort`）→ `limit`。
 *
 * `from` 出现时**只允许再带 `relative` / `direction`**；其余写法错误一律抛错。
 * 注意：示例里出现过的 `stats` 字段在文档里标着 `##TODO`、**不在字段表内**，故本类型不含它
 * （写了会被"未知查询字段"拦下）。
 */
export interface SelectorQuery {
  /** 选哪一方（缺省 `own`）：own / enemy / both */
  readonly side?: 'own' | 'enemy' | 'both'
  /** 选卡牌还是玩家（缺省 `cards`）；`player` 时禁止 `tags` / `destroyed` */
  readonly zone?: 'cards' | 'player'
  /** 以「来源」直接取目标（`self` = 动作来源卡，`event` = 本次事件来源卡）；与其余筛选字段互斥 */
  readonly from?: 'self' | 'event'
  /** 以来源卡为基准的相对取法（目前只有 `adjacent`）；必须与 `from` 同用 */
  readonly relative?: 'adjacent'
  /** 相对方向（缺省 `both`）；必须与 `relative` 同用 */
  readonly direction?: 'both' | 'left' | 'right'
  /** 标签筛选（开放词表；`hiddenTags` 不参与） */
  readonly tags?: readonly string[]
  /** 标签命中口径（缺省 `any`）：any = 命中任一，all = 必须全部命中 */
  readonly tagMode?: 'any' | 'all'
  /** 逐候选条件（复用 `Condition`；`this` 绑定当前候选） */
  readonly filter?: Condition
  /** 失效卡口径（缺省 `exclude`）：exclude 只含未失效 / include 全含 / only 只含已失效 */
  readonly destroyed?: 'exclude' | 'include' | 'only'
  /**
   * 排序键（缺省 `slot_asc`）：`slot_asc` / `slot_desc` / `slot_index_asc` / `slot_index_desc` /
   * `speed_asc` / `speed_desc` / `gauge_asc` / `gauge_desc` / `hp_asc` / `hp_desc` /
   * `hp_pct_asc` / `hp_pct_desc` / `shield_asc` / `shield_desc`（后六个仅 `zone: player`），
   * 以及开放数值键 `<stat>_asc` / `<stat>_desc`（stat 必须在该卡 stats 里存在，否则硬失败）。
   */
  readonly sort?: string
  /** 随机抽样（缺省 `false`）：走战斗 rng 的 Fisher–Yates 洗牌；与 `sort` 互斥 */
  readonly random?: boolean
  /** 取前 N 个（正整数）；缺省不限 */
  readonly limit?: number
}

/**
 * 表达式：字面量 / 引用 / 事件参数 / 计数 / 四则（结构在  阶段细化，先定形状）。
 *
 * 允许**字符串字面量**（a-lite 引用型比较）：只用于 `cmp` 的 `eq` / `neq`，
 * 典型是阵营值（`right: own` / `right: enemy`）与字符串型事件参数（`event_name` / `winner`）。
 * 数值上下文里出现字符串字面量会直接报错。
 */
export type Expr =
  | number
  | string
  | { readonly ref: string }
  | { readonly var: string }
  /**
   * 筛选后计数：**只数卡牌**，走完整求值管线（`limit` 生效）。
   * 接受字符串缩写或查询对象；`zone: player` 的选择器**抛错**。
   */
  | { readonly count: string | SelectorQuery }
  | { readonly add: readonly Expr[] }
  | { readonly sub: readonly Expr[] }
  | { readonly mul: readonly Expr[] }
  | { readonly div: readonly Expr[] }

/** 条件 */
export type Condition =
  | { readonly cmp: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq'; readonly left: Expr; readonly right: Expr }
  | { readonly not: Condition }
  | { readonly any: readonly Condition[] }
  | { readonly all: readonly Condition[] }

// ————————————————————————————————————————————————————————
// 卡牌与技能定义
// ————————————————————————————————————————————————————————

/** 动作原语名 */
export type PrimitiveName =
  | 'deal_damage'
  | 'heal_player'
  | 'gain_stat'
  | 'shield'
  | 'apply_status'
  | 'charge'
  | 'destroy'
  | 'repair'
  | 'enchant'

/** 一条动作 */
export interface ActionSpec {
  readonly do: PrimitiveName
  /**
   * 选择器：字符串缩写（13 条）或 **查询对象** `SelectorQuery`。
   * 两种写法语义完全等价；写法错误与目标类型不匹配的处理见 / 。
   */
  readonly target?: string | SelectorQuery
  readonly stat?: string
  readonly status?: CardStatusKind
  readonly amount?: Expr
  readonly seconds?: Expr
  readonly duration?: Expr
  readonly stackLimit?: number
  /**
   * 附魔 id（**仅 `do: enchant` 使用**）：要施加到目标卡上的那一件附魔。
   *
   * 取值必须是**目标卡** `enchantments` 目录里存在的 id；目录里没有 ⇒ 该次动作**静默跳过**
   * （校验期只能看到施法者自己的目录，运行期目标可能是别的卡，故不报错、不中止）。
   */
  readonly enchant?: string
}

// ————————————————————————————————————————————————————————
// 光环
// ————————————————————————————————————————————————————————

/**
 * 光环的一条**平铺**修饰：`最终值` 里直接相加。
 *
 * `stat` 与卡牌 `stats` 同一张表（`atk` / `shield` / `charge` …），但 **`speed` 禁止**
 * ；`haste` / `slow` / `freeze`（加速 / 减速 / 冰冻）也禁止
 * —— 第 5 条「`status` 一律禁止」在本实现里的落点就是这三个 status 数值位。
 * `amount` 正数 = 增强、负数 = 削弱。
 */
export interface AuraApply {
  readonly stat: string
  readonly amount: number
}

/**
 * 光环的一条**倍率**修饰：`×（1 + Σ(factor − 1)）`，**倍率之间加算**。
 *
 * `factor` 保留两位小数（`1.50` = ×1.5、`0.80` = 削弱）。
 * **只作用于卡牌 `stats`**：不含 `speed` / `cdp`；玩家侧（DOT / 再生）没有倍率层。
 */
export interface AuraMul {
  readonly stat: string
  readonly factor: number
}

/**
 * 光环定义。
 *
 * - 两类载体：**卡牌光环**写在卡牌顶层（与 `abilities` 平级、不占 `kind`）；
 *   **技能光环**写在技能顶层（纯光环技能可不写 `trigger`、`actions` 可省略）。
 * - `select` **必填、无语义缺省**；`apply` 与 `mul` **至少一条非空**。
 * - **同一通道内同一 `stat` 不得重复写**；`apply` 与 `mul` 写同一 `stat` 允许（先平铺再乘倍率）。
 * - `condition` 为假 ⇒ 本帧贡献 0（不是"移除"，是"从未生效"）。
 * - **不落状态**：不写 `BoardCard.stats`、不加层数、无时长、无退场回滚；
 *   每触发帧按"来源集合 × 目标集合 × 条目"重新派生 ⇒ 来源离场下一帧直接消失。
 */
export interface AuraDef {
  /** 选择器（字符串缩写或查询对象），语义与动作 `target` 完全同一套 */
  readonly select: string | SelectorQuery
  /** 平铺通道（选填，与 `mul` 至少一条非空） */
  readonly apply?: readonly AuraApply[]
  /** 倍率通道（选填，与 `apply` 至少一条非空） */
  readonly mul?: readonly AuraMul[]
  /** 附加条件；为假时本帧贡献 0。`this` = 光环来源卡（技能光环无来源卡） */
  readonly condition?: Condition
}

/** 一条能力 */
export interface Ability {
  /** 卡内唯一 id，品质继承按它定位覆盖条目 */
  readonly id: number
  readonly kind: AbilityKind
  /** 数值大者优先；缺省 5，范围 1–10。**仅被动使用**——主动不走优先级比较 */
  readonly priority?: number
  /** 被动：时机词 */
  readonly trigger?: { readonly event: string }
  readonly condition?: Condition
  readonly actions: readonly ActionSpec[]
  /** 仅本卡第 N 的整数倍次主动行动时结算（缺省每次） */
  readonly everyN?: number
}

/**
 * 一件附魔（卡面 `enchantments` 目录里的一项）。
 *
 * 附魔是**常驻效果组**：存在即生效，**无时机词、无条件**；三块效果
 * （`aura` / `stats` / `actions`）**至少写一块**。目录写在卡面，
 * 而"当前生效哪一件"是运行期状态（`BoardCard.enchant`，由 `do: enchant` 施加）。
 */
export interface EnchantDef {
  /** 卡内唯一 id */
  readonly id: string
  /**
   * 显示名（选填；缺省 = `id`）。**只在表现层用**：悬浮窗"卡名上方"那一行附魔名。
   * 引擎判定不读它。
   */
  readonly name?: string
  /**
   * 玩家自定义的附魔颜色（`#rrggbb`；缺省 = 前端回落内置附魔色）。
   *
   * 只是**表现层**用色，引擎判定不读它 ⇒ 不影响任何对局结果，也不进确定性 hash。
   */
  readonly color?: string
  /** 光环通道：与卡牌 / 技能的光环同一套结构；来源 = 这张卡的这件附魔 */
  readonly aura?: AuraDef
  /** 属性通道：生效期间**并入卡牌 `stats` 表**（消失即移除） */
  readonly stats?: Readonly<Record<string, number>>
  /** 动作通道：随本卡主动行动一起结算（附加在主动效果的末尾） */
  readonly actions?: readonly ActionSpec[]
}

/** 卡牌定义 */
export interface Card {
  /** 小写下划线，必须与文件名一致 */
  readonly id: string
  readonly name: string
  /** ≥1，每次修改任意字段必须 +1，旧版本保留 |
   */
  readonly version: number
  readonly size: CardSize
  /** 覆盖 size 推导的占格数（≥1） */
  readonly slots?: number
  /**
   * 行动条充满周期的基础冷却，单位 **cs整数**。
   * YAML 卡面仍按"秒、两位小数"书写，由读入层用 `secondsToCs()` 换算成本字段
   * 。
   * `-1` = 纯被动物品（无行动条、无主动行动）。
   */
  readonly cooldown: number
  readonly rarity: string
  readonly description?: string
  readonly owner?: string
  /** 数值表（stats 开放表：atk 必填，speed / cdp / shield / heal / burn / poison / regen / haste / slow / freeze / charge） */
  readonly stats: Readonly<Record<string, number>>
  /** 行动条充满后主动行动的次数（缺省 1） */
  readonly multicast?: number
  readonly tags?: readonly string[]
  readonly hiddenTags?: readonly string[]
  readonly abilities?: readonly Ability[]
  /**
   * 卡牌光环。**与 `abilities` 平级、不占 `kind`**：
   * 有光环的卡不必写 `cooldown` 相关的任何主动效果，光环在卡牌存活期间持续生效。
   */
  readonly aura?: AuraDef
  /**
   * 附魔**目录**（卡面 `enchantments`）：这张卡"能有哪些附魔"。
   *
   * ⚠️ 目录 ≠ 生效：**"当前生效哪一件"不在卡面**，只能由 `do: enchant` 在局内施加
   * （写入 `BoardCard.enchant`；"出厂自带"将来走购买阶段 trigger）。
   */
  readonly enchantments?: readonly EnchantDef[]
}

/** 技能定义 */
export interface Skill {
  readonly id: string
  readonly name: string
  readonly version: number
  /**
   * **品阶 id**（**必填**；: 与卡牌 `Card.rarity` **同一张表** —— 本包 `rarities.yml` 的
   * `rarities[].id`，含自定义品阶）。
   *
   * **只是声明，不参与战斗计算**：引擎不读它，表现层用它取"技能框素材"
   * （`images/frames/<品阶 frame>/skill_frame.png`）与做筛选。
   *
   * ⚠️ **合成链不作用于技能**（《[审阅.md](../docs/审阅.md)》§V.2 = A：合成只作用于卡牌；
   * 技能的合成与框体绘制已排到 1.0 之后）。
   */
  readonly rarity: string
  readonly priority?: number
  readonly description?: string
  /**
   * 时机词。**与卡牌被动的 `Ability.trigger` 语义一致**：
   * 只有本触发帧命中了该事件，本技能才会进入候选队列。
   *
   * **选填**：不写 `trigger` 的技能**不进入触发栈**。
   * 这是给"纯光环技能"（只有 `aura`、不绑时机）留的写法 —— 光环自 已实现
   * （`engine/aura.ts`），故"不写 trigger 但有 aura"是**完全合法**的写法；
   * 只有"既不写 trigger 也没有 aura"的技能才整局不会有任何结算 —— 开局播报一条 NOTE，
   * **不抛错**（见 `runBattle` 的 `reportInertSkills`）。
   *
   * 为什么曾经必填：技能原先没有任何事件匹配判断，而收集逻辑是按
   * "本帧命中的每个事件词收集一次"驱动的，于是**同一触发帧命中两个事件词时，
   * 每侧技能会在这一帧结算两次**；叠加灼烧 `on_player_damaged` 自激后，开局技能
   * 变成每帧反复结算（实测 `--seed 42`：三个技能各 541 次、护盾膨胀到 10 万），
   * 直接导致双方锁血打满 180s。绑上 trigger 后技能才真正只在自己该响的时机响。
   * **"选填"不等于"没有匹配条件就每帧结算"**：没有 trigger 就永远不进触发栈。
   */
  readonly trigger?: { readonly event: string }
  /** 技能自带 stats 开放数值表（效果数值只能引用本技能 stats） */
  readonly stats: Readonly<Record<string, number>>
  readonly condition?: Condition
  readonly actions: readonly ActionSpec[]
  /**
   * 技能光环：纯光环技能可以不写 `trigger`。
   *
   * 注意：TS 契约里 `actions` 仍是必填（`readonly ActionSpec[]`，可写空数组）；
   * 是否放宽为"有 aura 即可省略 actions"留给 YAML 读取层的校验决定。
   */
  readonly aura?: AuraDef
}

// ————————————————————————————————————————————————————————
// 运行时状态
// ————————————————————————————————————————————————————————

/** 一条数值修正（buff / debuff）。层数、时长、来源都要记，供 stackLimit 与刷新逻辑使用 */
export interface StatModifier {
  readonly stat: string
  /** 可累加（同 stat、同 source 再次施加时叠加） */
  amount: number
  readonly source: string
  /** 剩余时长，单位 **cs**，整数；undefined = 常驻（会被刷新） */
  remainingCs?: number
  readonly stackLimit?: number
}

/** 卡牌身上的状态（加速 / 减速 / 冰冻：独立计时、不互相覆盖） */
export interface CardStatus {
  readonly kind: CardStatusKind
  /** 剩余时长，单位 **cs**，整数 */
  remainingCs: number
}

/** 场上一张卡。最小可跑版的"位置"是一等字段，因为行动顺序与相邻选择器都要用它。 */
export interface BoardCard {
  readonly card: Card
  readonly owner: PlayerId
  /** 左侧起始格，1–10 */
  readonly slot: number
  /** 实例 id：同名卡可多张，靠它区分（如 `1-cinder_wolf-3`） */
  readonly instanceId: string
  /**
   * 加载顺序的全局序号（0 基）。
   *  第 2 条："先本方后敌方、各自从左到右"——priority 相同时按本序号升序结算。
   */
  readonly loadOrder: number
  /**
   * 行动条累积进度，单位 **cs**，整数，取值 [0, 充满周期)。
   * 每个全局帧 +1（"`gauge += 1`/全局帧"）；**满条的那一 cs 立刻"记账"并归零**
   * （减一个充满周期、余量结转）—— 效果本身要等**最近的效果处理点**（5cs 网格）才结算。
   */
  gaugeCs: number
  /** 已**记账**的主动行动次数（每个行动 +1；`everyN` 与卡面角标用它计数） */
  actionCount: number
  /** destroy 原语：失效（仍占位、不行动、被动停用） */
  destroyed: boolean
  /** 战斗内数值修正（含 buff 后的当前值由 `effectiveStat` 计算，不直接写回 card.stats） */
  stats: StatModifier[]
  /** 加速 / 减速 / 冰冻 */
  statuses: CardStatus[]
  /**
   * **当前生效的附魔 id**（运行期状态；`undefined` = 没有附魔，等价于 `none`）。
   *
   * 取值必须是 `card.enchantments` 里存在的 id；由 `do: enchant` 写入
   * （单槽：写入即**整件替换**，旧件的 `aura` / `stats` / `actions` 一并回滚）。
   */
  enchant?: string
}

/** 玩家身上的持续效果实例 */
export interface DotInstance {
  readonly kind: DotKind
  /**
   * 层数。**唯一允许保留小数的累加器**：
   * 灼烧每跳 ×0.8 是指数衰减，逐跳取整会把 1 层卡死在 1 层、永不衰减，
   * 故内部保留小数，只在对外读取（算伤害 / 日志 / 界面 / 条件比较）时取整。
   */
  stacks: number
  /** 剩余时长，单位 **cs**，整数；undefined = 常驻 */
  remainingCs?: number
  readonly source: string
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
  readonly kind:
    | 'damage'
    | 'heal'
    | 'shield'
    | 'stat'
    | 'status'
    | 'charge'
    | 'destroy'
    | 'repair'
    | 'enchant'
  readonly targetSide: PlayerId
  /** 玩家侧影响量（伤害 / 治疗 / 护盾均为正数，"方向"由 kind 决定） */
  readonly amount: number
  /** 目标玩家结算后的血量与护盾 */
  readonly hpAfter: number
  readonly shieldAfter: number
  /** 被护盾吸收的量（仅伤害有） */
  readonly absorbed: number
  /**
   * 本次治疗**真正清掉**的灼烧层数（仅 `kind: 'heal'` 有；无灼烧时为 0）。
   * 治疗按 `实际恢复量 × 0.05` 清 DOT 层数，层数是唯一允许带小数的累加器 ⇒ 本字段也可能是小数。
   */
  readonly cleansedBurn?: number
  /** 本次治疗真正清掉的剧毒层数（仅 `kind: 'heal'` 有；无剧毒时为 0） */
  readonly cleansedPoison?: number
  /** 卡牌侧目标（stat / status / destroy / repair / charge 用） */
  readonly card?: BoardCard
  readonly stat?: string
  readonly status?: CardStatusKind
  /**
   * 本次施加的卡牌状态时长，**单位 = 秒**（仅 `kind: 'status'` 有）。
   * 与 YAML 里 `duration` 的书写单位一致；内部信号存的是 cs（`BoardCard.statuses[].remainingCs`），
   * 这里另留一份作者可见的秒数，供卡牌状态类事件广播当参数。
   */
  /** 本次施加的卡牌状态时长，**单位 = 秒**（仅 `kind: 'status'` 有）。 */
  readonly durationSeconds?: number
  /** 本次施加的附魔 id（仅 `kind: 'enchant'` 有） */
  readonly enchantId?: string
  /**
   * 本次涉及的持续效果种类（固定顺序 `burn` → `poison` → `regen`）。
   *
   * - `gain_stat` 施加持续效果时 = 被施加的那一种；
   * - 周期结算时 = **本次到点的全部种类**：灼烧 `['burn']`；
   *   剧毒与再生同在一个 1s 网格点 ⇒ **合并为一次净值结算**，此时为 `['poison', 'regen']`。
   */
  readonly dots?: readonly DotKind[]
  /**
   * 本次跳变**结算前**的层数（取整后的对外读数，与 `effectiveDotStacks` 同源）。
   * 净值结算时两个分量各给一个字段：`stacks` 的语义按种类拆开。
   * "结算前" = 本次伤害/治疗按它算，灼烧的 `×0.8` 衰减发生在这之后。
   */
  readonly burnStacks?: number
  readonly poisonStacks?: number
  readonly regenStacks?: number
}

/**
 * 一条动作日志：一次"动作结算"的结构化记录。
 * 纯文本行是它的渲染结果（`engine/log.ts`），客户端将来直接消费本结构。
 */
export interface ActionLog {
  /**
   * 发生本条动作结算的**触发帧序号**。
   * 名称沿用旧的 `tick`，两级时钟落地后它的语义是触发帧；
   * 改名属 （会连锁到 `docs/API文档.md` 的日志结构表与 `engine/log.ts`）。
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

/**
 * 日志级别。
 *
 * 严重程度从高到低：`error` > `warn` > `note` > `info` > `debug`。
 * - `error`：**跑不起来了**（引擎无法继续）。引擎碰到这类问题一律直接抛错，
 *   故本级别目前只作为词表占位，正常路径上不会产出消息。
 * - `warn`：**这个东西可能引起问题**（例：光环给卡牌施加火 / 毒）。
 * - `note`：**引擎能正常跑，但你的设计可能有问题**（例：原语选中的目标类型不匹配而空转）。
 * - `info`：正常流水（例：光环生效 / 退场播报）。动作流水另走 `ActionLog`。
 * - `debug`：开发细节，默认阈值下关闭。
 *
 * `BattleOptions.logLevel`（缺省 `note`）是**记录阈值**：低于阈值的消息既不进
 * `BattleState.messages`、也不渲染成文本行 —— 因此**调整阈值不改变任何对局结果**
 * （不消耗 rng、不写任何判定字段）。
 */
export type LogLevel = 'error' | 'warn' | 'note' | 'info' | 'debug'

/**
 * 消息码（封闭词表；**文案的唯一权威是 `engine/log.ts` 的 `messageText`**）。
 *
 * 命名约定：`<子系统>.<事件>`，小写下划线（与时机词、原语名同风格）。
 * 结构化记录里**只存 code + data**，文案一律在渲染层组装
 * 这样文案改动不影响结构化契约，日志文件里也能落下 code 便于机器检索。
 *
 * 生产者现状（光环批次后）：
 * - `skill.no_trigger_no_aura`：`engine/tick.ts` 的 `reportInertSkills`；
 * - `selector.type_mismatch`：`engine/primitives.ts`（原语 × 目标类型不匹配）、
 *   `engine/expr.ts`（`{ count: ... }` 选玩家）与 `engine/aura.ts`（光环玩家侧越界）；
 * - `selector.sort_key_ignored`：`engine/selectors.ts` 的 `notify` → `engine/tick.ts` 记 NOTE
 *   （第 3 条：`zone: player` 上的卡牌专属排序键被忽略）；
 * - `aura.dot_warning`：`engine/aura.ts`（光环把 `burn` / `poison` 施加给玩家，暂定 WARN）；
 * - `aura.entered` / `aura.exited`：`engine/aura.ts` 的 `refreshAuras` 做 diff（INFO 级）；
 * - `stack_limit.truncated` 仍是**已定案但尚未实现**的预留码（`stackLimit` 批次落地时接入；⚠️ 码名是**线上字面量**、不随字段改名，见  日志约定）。
 */
export type MessageCode =
  | 'skill.no_trigger_no_aura'
  | 'selector.type_mismatch'
  | 'selector.sort_key_ignored'
  | 'aura.dot_warning'
  | 'aura.entered'
  | 'aura.exited'
  | 'stack_limit.truncated'

/**
 * 一条分级消息（"需要注意的提示"）。
 *
 * 与 `ActionLog` 的分工：`ActionLog` 是"一次动作结算"的正常流水（必然发生）；
 * 本结构只装**异常与提示**（note 及以上）。两者都从 `BattleResult` 出去，
 * 但 messages **不参与确定性哈希、不进 `log` 数组**。
 */
export interface LogMessage {
  readonly level: LogLevel
  readonly code: MessageCode
  /** 发生时的**触发帧序号** */
  readonly tick: number
  readonly side?: PlayerId
  /** 行动主体，口径同 `ActionLog.actor`：卡牌 `instanceId` / `技能:<id>` / `持续效果:<kind>` */
  readonly actor?: string
  /** 定位信息：哪张卡的哪个能力、第几个动作、哪个原语（能填就填，便于检索与去重） */
  readonly where?: {
    readonly abilityId?: number
    readonly actionIndex?: number
    readonly primitive?: PrimitiveName
  }
  /** 消息参数（渲染文案用）。只放数字 / 字符串，保证结构化记录可直接序列化 */
  readonly data?: Readonly<Record<string, number | string>>
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
   * 双方**开局血量 / 上限**（ 新增， `` = A / ）：
   * 由阵容文件的角色（`heroes/<hero_id>.yml` 的 `initHp` / `initMaxHp`）或 deck 的
   * `hp` / `maxHp` 覆盖给出；**都不给时回落到 `INITIAL_HP`（过渡常量）**，
   * 保持裸跑 `simulator/run.ts --seed 42`（demo-deck 路径）的旧行为逐字节不变。
   */
  readonly hpA?: number
  readonly maxHpA?: number
  readonly hpB?: number
  readonly maxHpB?: number
  /**
   * 是否同时生成纯文本日志行（缺省 true）。
   * 批量模拟只关心结果时置 false，可省掉全部字符串拼接。
   */
  readonly includeText?: boolean
  /**
   * 消息记录阈值（缺省 `note`，即 `error` / `warn` / `note` 入账，`info` / `debug` 丢弃）。
   * 见 `LogLevel` 的说明：**只影响"记不记"，不影响任何对局结果**。
   */
  readonly logLevel?: LogLevel
  /**
   * 是否采集**逐触发帧状态快照**（缺省 `false`；开启后 `BattleResult.frames` 非空）。
   *
   * 用途 = 客户端回放（ ``）：卡面行动条百分比、buff / 状态剩余时长、
   * DOT 层数与"buff 以后的实时数值行"**都无法从 `ActionLog` 重建**，只能由引擎逐帧给出。
   *
   * **三条硬约束**（与 `messages` 同一套纪律）：① **不消耗 rng、不写任何状态字段** ⇒
   * 开启与否**不改变任何判定**；② **不进确定性 hash**、也**不影响 `lines`**（同一对局
   * 开与不开的日志逐字节相同）；③ **默认关闭** ⇒ CLI / 批量模拟的开销与输出不变。
   */
  readonly captureFrames?: boolean
}

// ————————————————————————————————————————————————————————
// 光环派生态（每触发帧重建一次，见 engine/aura.ts）
// ————————————————————————————————————————————————————————

/**
 * 一条**已生效**的光环贡献（来源 × 目标 × 条目）。
 *
 * 这是派生态台账：它只记录"这一触发帧里，谁因为哪条光环、对谁、产生了多少修饰"，
 * 供日志 diff与悬浮窗展示使用。
 */
export interface AuraEntry {
  /** 来源标识：卡牌 = `instanceId`；技能 = `技能:<skill_id>` */
  readonly source: string
  /** 来源所属方（源卡的 owner / 技能持有方） */
  readonly sourceSide: PlayerId
  readonly channel: 'apply' | 'mul'
  /** 被修饰的数值名；玩家目标时是 `burn` / `poison` / `regen` */
  readonly stat: string
  /** apply 通道 = 平铺量；mul 通道 = `factor − 1`（便于直接求和） */
  readonly amount: number
  /** 目标标识：卡牌 = `instanceId`；玩家 = `'1'` / `'2'` */
  readonly target: string
  readonly targetKind: 'card' | 'player'
  /** 展示用目标名（卡牌 = 卡面 id；玩家 = 玩家名） */
  readonly targetName: string
}

/** 某张卡某个 stat 上汇聚到的光环合计 */
export interface AuraTotals {
  /** Σ 平铺量（apply 通道） */
  readonly flat: number
  /** Σ(factor − 1) ⇒ 最终乘数 = `1 + factor` */
  readonly factor: number
}

/**
 * 光环派生态快照。
 *
 * **每触发帧边界整体重建、只读**：`effectiveStat` / `effectiveDotStacks` 只读它，
 * 绝不回写 `BoardCard.stats` 或 `DotInstance.stacks` ⇒ 无层数、无时长、无退场回滚
 * ；来源离场时下一帧重建即自然消失。
 *
 * **不进确定性哈希**：它完全由（来源集合 × 目标集合 × 光环条目）决定，
 * 而后两者是状态的纯函数 ⇒ 去掉它也不丢失任何信息。
 */
export interface AuraSnapshot {
  /** 本帧全部生效条目，按确定顺序排列（来源加载序 → 条目序 → 目标序） */
  readonly entries: readonly AuraEntry[]
  /** 卡牌通道：`instanceId` → 数值名 → 合计 */
  readonly cards: ReadonlyMap<string, ReadonlyMap<string, AuraTotals>>
  /** 玩家 DOT 通道：`` `${PlayerId}:${DotKind}` `` → 层数增量合计 */
  readonly dots: ReadonlyMap<string, number>
}

/** 战斗状态：引擎的全部可变状态都挂在这里，便于快照与重放 */
export interface BattleState {
  readonly seed: number
  readonly players: Record<PlayerId, PlayerState>
  /**
   * 已流逝的**全局帧数**，整数。
   * 一切连续量（行动条 gauge、持续效果周期、状态与 buff 时长）都按它推进。
   */
  timeCs: number
  /**
   * 当前**触发帧序号**（= 限流窗口序号，0.2s 一格）。
   * 它不决定"效果何时结算"（那是 5cs 的效果处理点），只决定**限流配额**：
   * 每个触发器每 20cs 至多释放一条；边界同时负责重建光环、判胜负、采一帧快照。
   */
  triggerFrame: number
  finished: boolean
  /** 胜者；平局按规则判 sideA（派发方）胜，故不会是 null（除非异常） */
  winner: PlayerId | null
  /** 是否因超时判的平局 */
  draw: boolean
  /** 随机源。**不得在引擎别处引入任何其他随机来源**。 */
  readonly rng: Rng
  /**
   * 分级消息（note 及以上的提示）。**不参与任何判定、不消耗 rng、不进确定性哈希**；
   * 门槛由 `BattleOptions.logLevel` 决定，末尾 = 整局的完整提示清单
   * 。
   */
  readonly messages: LogMessage[]
  /**
   * 光环派生态快照（每触发帧边界由 `refreshAuras` **整体替换**）。
   * **只读派生数据**：不参与任何判定之外的写入，不进确定性哈希。
   */
  auras: AuraSnapshot
}

// ————————————————————————————————————————————————————————
// 逐触发帧状态快照（ 新增； ``，供客户端回放）

// 为什么必须由引擎给：回放要画的"卡面纵向行动条百分比 / buff 与状态剩余时长 / DOT 层数 /
// buff 以后的实时数值行"**都不是 `ActionLog` 的字段**（动作日志只记"一次结算"），
// 而让前端按 `cooldown` / `cdp` / 速度自己推算 = 在表现层重实现战斗规则（违反）。
// 故引擎在**触发帧边界**（0.2s 粒度，与"逐 tick 步进"同一粒度）采集一份只读快照流。

// 四条纪律：**只读**（不写状态、不耗 rng）· **可 JSON 序列化**（字段固定、不遍历对象键）·
// **不进确定性 hash** · **默认关闭**（`BattleOptions.captureFrames`）。
// ————————————————————————————————————————————————————————

/** 某一方在某帧的读数 */
export interface FramePlayer {
  readonly id: PlayerId
  readonly hp: number
  readonly maxHp: number
  readonly shield: number
  /** 三种持续效果的派生态读数（**恒三项、顺序固定** `burn` → `poison` → `regen`） */
  readonly dots: readonly FrameDot[]
}

/** 某一种持续效果在某帧的派生态读数 */
export interface FrameDot {
  readonly kind: DotKind
  /** 派生态层数（取整后的对外读数，与 `effectiveDotStacks` 同源） */
  readonly stacks: number
  /**
   * 剩余时长（cs）。**省略 = 常驻**（实例无时长，或层数整份来自光环派生态 —— 光环不落状态、无时长）。
   * `stacks === 0` 时该字段无意义。
   */
  readonly remainingCs?: number
}

/** 场上一张卡在某帧的读数 */
export interface FrameCard {
  readonly instanceId: string
  readonly owner: PlayerId
  /** 左端所在格（1–10） */
  readonly slot: number
  /** 行动条累积进度（cs） */
  readonly gaugeCs: number
  /**
   * 行动条充满周期（cs）—— 进度条百分比的**分母**，只能由引擎给。
   * `null` = 本帧没有可用周期：`cooldown: -1` 的纯被动卡，或**冰冻**（速度 = 0）。
   * 两者由 `statuses` 区分；回放器向右推进时可沿用上一帧的非 `null` 值，
   * 以便冰冻期间仍能画出"冻结的进度"。
   */
  readonly periodCs: number | null
  readonly actionCount: number
  readonly destroyed: boolean
  /** 已合成光环与 buff 的实时数值（**按键名升序**；不含 `speed`，见下） */
  readonly stats: readonly FrameStat[]
  /** 有效速度倍率（含加速 / 减速 / 冰冻；冰冻 = 0） */
  readonly speed: number
  /** 加速 / 减速 / 冰冻（独立计时、可并存；按状态名升序） */
  readonly statuses: readonly FrameStatus[]
  /**
   * **本帧当前生效的附魔 id**（无附魔时省略）。
   *
   * 附魔只有运行期才出现（卡面不写，由 `do: enchant` 施加），故前端**不能**从静态卡数据推断，
   * 必须读这里（悬浮窗"附魔：绿宝石"、卡面角标都靠它）。**不进确定性 hash**。
   */
  readonly enchant?: string
}

/** 一项实时数值 */
export interface FrameStat {
  readonly stat: string
  readonly value: number
}

/** 一个卡牌状态及其剩余时长 */
export interface FrameStatus {
  readonly kind: CardStatusKind
  /** 剩余时长（cs） */
  readonly remainingCs: number
}

/**
 * 一帧里发生过的**一个事件实例**（"谁、对谁、发生了什么"）。
 *
 * 与 `FrameCard` / `FrameDot` 同一套纪律：**只读 · 可 JSON 序列化**（只放 id / 数字 / 字符串，
 * **不放引擎对象引用**）· **不进确定性哈希**。
 *
 * 用途 = 回放 / 动画的"这一帧发生了什么"：`FrameSnapshot` 只有状态，"为什么变了"由它回答；
 * 它也是"事件实例"的对外视图 —— 引擎内部的结算去重键 = **（事件 × 来源 × 目标）**，
 * 与这里的 `sourceKey` / `targetKey` 同一套口径。
 *
 * ⚠️ **不要假设它落在本帧的 0.2s 窗口内**：落在非边界 cs 的事件（持续效果跳变、
 * **行动条满 / 效果结算**的主动行动）会被带到下一个边界帧才采集，其 `cs` 因此可能早于
 * 本帧窗口 —— 消费方请**按 `cs` 排序**。
 *
 * 主动行动会产生**两条**事件：`active_action`（条满那一 cs "记账"时，`cs` = **归零时刻**）
 * 与 `after_action`（效果结算完，`cs` = **释放那一 cs**）。表现层的"条归零"锚点取前者。
 */
export interface FrameEvent {
  /**
   * 发生时刻（全局帧 = cs，0.01s 粒度）。
   * **主动行动**会出两条：`active_action`（条满那一 cs = **归零时刻**，表现层锚点）与
   * `after_action`（效果结算完 = **释放那一 cs**）。
   */
  readonly cs: number
  /** 时机词 */
  readonly event: string
  /**
   * 事件来源键 —— 产生它的那个"触发器条目"：
   * `active:<卡实例id>`（一次主动行动）· `passive:<卡实例id>#<能力id>` · `skill:<技能id>` ·
   * `dot:<持续效果>@<承受方>` · `engine:<事件词>`（引擎内置，如 `battle_start`）。
   */
  readonly sourceKey: string
  /** 事件目标键：`player:<1|2>` · `card:<卡实例id>` · `-`（无目标，如 `battle_start`） */
  readonly targetKey: string
  /** 涉及玩家时（受伤 / 治疗 / 护盾 / 持续效果跳变） */
  readonly playerId?: PlayerId
  /** 涉及卡牌时 */
  readonly instanceId?: string
  /** 卡牌所在格（1–10，涉及卡牌时给） */
  readonly slot?: number
  /** 伤害 / 治疗 / 护盾 / 层数 / 推进秒数…（按事件词给，缺省 = 该事件不带这个量） */
  readonly amount?: number
}

/**
 * 一个触发帧**结束时**的只读状态快照（回放的唯一画面数据源）。
 *
 * 采集时点：开局初始化结束（`triggerFrame = 0`）+ **每个触发帧结算完毕之后**。
 * 末项 = 分出胜负的那一帧（`finished = true`）；**超时判平局**发生在主循环之外，
 * 其收官信息走 `BattleResult.victory` 与 `BattleState.draw`，不额外占一帧。
 */
export interface FrameSnapshot {
  /** 触发帧序号 */
  readonly triggerFrame: number
  /** 该帧结束时的全局帧数（cs） */
  readonly timeCs: number
  readonly finished: boolean
  readonly winner: PlayerId | null
  /** 双方读数，顺序固定 `[A, B]` = `[1, 2]` */
  readonly players: readonly FramePlayer[]
  /** 场上全部卡（**含 `destroyed`**）：方 1 → 方 2，同方按 `slot` 升序 */
  readonly cards: readonly FrameCard[]
  /** 该帧的光环派生态台账（与 `BattleState.auras.entries` 同源，供悬浮窗展示） */
  readonly auras: readonly AuraEntry[]
  /**
   * 该帧**发生过的事件实例**（按发生顺序；**含同一实例多次发生**——每次发生各一条）。
   * 状态快照答"变成了什么"，它答"**为什么**变" ⇒ 飘字 / 护盾碎裂 / 状态角标 / 触发高亮的数据源。
   */
  readonly events: readonly FrameEvent[]
}
