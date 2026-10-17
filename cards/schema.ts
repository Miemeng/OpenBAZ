/**
 * L2 校验层：卡包 YAML 的**驼峰 DTO** 契约 + zod 结构校验 + 语义校验。
 *
 * 纯逻辑：不读文件、不抛异常（`validate*` 一律返回 `ValidationError[]`），
 * 由宿主适配层（`cards/loader.ts`）负责读文件并把文本交给这里。
 *
 * 三层口径：
 *  1. 本文件用 zod 校验 **YAML 原样的驼峰字段名**（`initHp` / `everyN` / …），
 *     未知字段一律拒绝（`z.strictObject`）；
 *  2. `cards/map.ts` 逐字段显式映射成引擎的驼峰契约（`Card` / `Skill`）；
 *  3. 行号：结构错由 zod 给出 `issue.path`，再用 `cards/yaml-positions.ts` 的
 *     path→{line, column} 表回查；YAML 语法错走 `YAMLException.mark`
 *     （js-yaml 的 `mark.line` / `mark.column` **0 起算**，此处 +1 后对外 1 起算）。
 *
 * 口径依据：（ /  / – /  /  /
 *  /  /  /  / ）、。
 */

import { YAMLException, load } from 'js-yaml'
import { z } from 'zod'
import { BUILTIN_RARITY_IDS } from './economy.ts'
import { SELECTOR_SHORTHANDS, validateQuery } from '../engine/selectors.ts'
import { ALL_STAT_KEYS, DOT_STAT_KEYS, STAT_KEYS } from '../engine/stat-keys.ts'
import { ENGINE_VERSION } from '../engine/version.ts'
import type { CardStatusKind, PrimitiveName, SelectorQuery } from '../engine/types.ts'
import { LOAD_ERROR_CODES, type ValidationError } from './types.ts'
import { collectPositions, formatIssuePath, lookupPosition, type SourcePosition } from './yaml-positions.ts'

/* ------------------------------------------------------------------ *
 * 封闭词表与常量
 * ------------------------------------------------------------------ */

/** 动作原语封闭词表（9 个）。第 9 个 `enchant`（施加附魔）自第 48 组起**已实现**。 */
export const PRIMITIVE_NAMES = [
  'deal_damage',
  'heal_player',
  'gain_stat',
  'shield',
  'apply_status',
  'charge',
  'destroy',
  'repair',
  'enchant',
] as const satisfies readonly PrimitiveName[]

/** 卡牌状态词表（`apply_status` 的 `status`）。 */
export const CARD_STATUS_KINDS = ['haste', 'slow', 'freeze'] as const satisfies readonly CardStatusKind[]

// ⚠️ `STAT_KEYS` / `DOT_STAT_KEYS` / `ALL_STAT_KEYS` 的**唯一来源已改为 `engine/stat-keys.ts`**
//    （文件头 import 进来直接用）。技术债第 5 条收口（ ``）：
//    原先这里抄了一份、`engine/aura.ts` 又写了两套 `FORBIDDEN_*`，"引擎加属性、包侧写不了"要改三处。

/** 引擎当前**实际广播**的时机（`engine/tick.ts` 的 `EVENT_WORDS`，未导出）；表外只报 `warn`。 */
export const KNOWN_EVENTS = [
  'battle_start',
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

/** `condition.cmp` 封闭词表。 */
export const CMP_OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq'] as const

/** 体积词表。 */
export const CARD_SIZES = ['small', 'medium', 'large'] as const

/** 能力类型词表。 */
export const ABILITY_KINDS = ['active', 'passive'] as const

/** 按体积推导的槽位缺省（ `slots`）。 */
export const DEFAULT_SLOTS: Readonly<Record<(typeof CARD_SIZES)[number], number>> = {
  small: 1,
  medium: 2,
  large: 3,
}

// ⚠️ `BUILTIN_RARITY_IDS` / `BUILTIN_UPGRADE_CHAIN` 的**唯一来源已改为 `cards/economy.ts`**
//    （随 `` 的价值口径一起收口）；本文件直接从那里 import。同一份清单不再抄两遍。

/** 点名玩家的三条缩写（光环"玩家侧限制"据此判定）。 */
const PLAYER_SELECTORS: readonly string[] = ['own_player', 'enemy_player', 'all_players']

/** `apply` 通道禁区（与 `engine/aura.ts` 的 `FORBIDDEN_APPLY_STATS` 一致）。 */
const FORBIDDEN_APPLY_STATS: readonly string[] = ['speed', 'haste', 'slow', 'freeze']

/** `mul` 通道在 `apply` 禁区之上再禁 `cdp`。 */
const FORBIDDEN_MUL_STATS: readonly string[] = [...FORBIDDEN_APPLY_STATS, 'cdp']

/** 效果数额必须引用的原语（写字面量 ⇒ `warn`， / ）。 */
const EFFECT_AMOUNT_PRIMITIVES: readonly PrimitiveName[] = ['deal_damage', 'heal_player', 'shield', 'repair']

/** 只属于卡牌的字段。 */
const CARD_ONLY_FIELDS: readonly string[] = [
  'kind',
  'cooldown',
  'everyN',
  'slots',
  'multicast',
  'inheritOverride',
]

/** 已废除的字段名。 */
const ABOLISHED_FIELDS: readonly string[] = ['baseAction', 'activeAction', 'buyPrize', 'prize']

/**
 * 卡面上**不许书写**的字段名：写在 YAML 里由读取层直接拒绝（`error`）。
 *
 * `enchant`（"当前生效的是哪一件"）是**运行期状态**，只能由 `do: enchant` 施加 ——
 * 卡面写它会让人误以为"出厂自带附魔"，故显式拒绝。
 * 目录 `enchantments` **是合法卡面字段**（已不在本表内）。
 */
const PENDING_FIELDS: readonly string[] = ['enchant']

/* ------------------------------------------------------------------ *
 * 事件参数校验表（权威 = 《参数表设计.md》§4 / §5 / §7）
 *
 * 校验器的职责有两条：① `{ var: X }` 的 `X` 必须是**当前事件**的合法参数名；
 * ② `{ var: X.<字段> }` 只能取一层，字段必须在该类型的封闭字段表里。
 * ------------------------------------------------------------------ */

/** 通用参数（所有事件都携带）。 */
const UNIVERSAL_EVENT_PARAMS: readonly string[] = ['event_name', 'tick', 'source', 'source_side']

/** 每个时机词的**专属**参数（唯一权威 = 《参数表设计.md》§5）。 */
const EVENT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  battle_start: [],
  battle_end: ['winner', 'own_hp', 'enemy_hp'],
  before_action: ['card', 'slot_index'],
  after_action: ['card', 'slot_index', 'damage_dealt'],
  on_player_damaged: ['player', 'amount', 'shield_absorbed', 'damage_type'],
  on_player_healed: ['player', 'amount', 'cleansed_burn', 'cleansed_poison'],
  on_shield_gained: ['player', 'amount'],
  on_shield_broken: ['player', 'overflow'],
  on_card_destroyed: ['card', 'slot_index'],
  on_card_repaired: ['card', 'slot_index'],
  on_card_frozen: ['card', 'duration', 'amount'],
  on_card_hasted: ['card', 'duration', 'amount'],
  on_card_slowed: ['card', 'duration', 'amount'],
  on_card_charged: ['card', 'duration', 'amount'],
  on_burn_tick: ['player', 'stacks', 'damage'],
  on_poison_tick: ['player', 'stacks', 'damage'],
  on_regen_tick: ['player', 'stacks', 'heal'],
}

/**
 * 主动能力（`kind: active`）的求值上下文 = **那一次主动行动**的参数快照 =
 * `after_action` 的专属参数**去掉 `damage_dealt`**（那个值要等动作结算完才知道）。
 * 见《参数表设计.md》§4.1 第 7 条。
 */
const ACTIVE_ABILITY_PARAMS: readonly string[] = [...UNIVERSAL_EVENT_PARAMS, 'card', 'slot_index']

/** 引用型事件参数 → 它可读的字段表（点号取属性用）。 */
const VAR_REF_KINDS: Readonly<Record<string, 'card' | 'player'>> = {
  card: 'card',
  source: 'card',
  player: 'player',
}

/** 卡牌引用的**非 stats** 字段（其余合法字段一律取 `STAT_KEYS` 词表）。 */
const CARD_REF_EXTRA_FIELDS: readonly string[] = ['speed', 'cooldown', 'multicast', 'slot_index', 'hp']

/** 玩家引用的封闭字段表（唯一权威 = 《规则说明书.md》§8.3）。 */
const PLAYER_REF_FIELDS: readonly string[] = ['hp', 'max_hp', 'hp_pct', 'shield', 'burn', 'poison', 'regen']

/**
 * **保证带来源卡**的事件词 —— 只有这两类事件的 `source` 是"必有"的（来源就是那张行动的卡）。
 * 其余事件可能由**技能**或**持续效果**产生，那时引擎**整个省略** `source`（不是给 `null`）⇒
 * 引用它会抛错并中止整局，故校验期**不放行**（依据 [docs/待办.md](../docs/待办.md) §四 14 = B）。
 */
const SOURCE_GUARANTEED_EVENTS: readonly string[] = ['before_action', 'after_action']

/** 某时机词允许的**全部**参数名（通用 + 专属；不保证有来源卡的事件摘掉 `source`）。未知时机词返回 `undefined`。 */
function eventParamNames(event: string | undefined): readonly string[] | undefined {
  if (event === undefined) return undefined
  const own = EVENT_PARAMS[event]
  if (own === undefined) return undefined
  const universal = SOURCE_GUARANTEED_EVENTS.includes(event)
    ? UNIVERSAL_EVENT_PARAMS
    : UNIVERSAL_EVENT_PARAMS.filter((name) => name !== 'source')
  return [...universal, ...own]
}

/** 一个**能力**允许的事件参数名：主动能力 = `after_action` 去掉 `damage_dealt`；被动 = 它自己绑的时机词。 */
function abilityParamNames(ability: {
  readonly kind: string
  readonly trigger?: { readonly event: string } | undefined
}): readonly string[] | undefined {
  if (ability.kind === 'active') return ACTIVE_ABILITY_PARAMS
  return eventParamNames(ability.trigger?.event)
}

const STAT_KEY_SET = new Set<string>(ALL_STAT_KEYS)
/** 卡牌 / 技能的 `stats:` 只认 13 个属性键（`burn` / `poison` / `regen` 写在卡面上是层数，与玩家侧同名）。 */
const CARD_STAT_SET = new Set<string>(STAT_KEYS)
/**
 * 引擎在 `stats` 未声明时按文档给出**非 0 缺省值**的属性键（`speed` 缺省 1、`cdp` 缺省 100）
 * ⇒ 引用它们不算"未定义"（其余键缺省 0，引用未声明的键几乎必然是漏写）。
 */
const IMPLICIT_STAT_DEFAULTS = new Set<string>(['speed', 'cdp'])
const DOT_STAT_SET = new Set<string>(DOT_STAT_KEYS)
const PLAYER_SELECTOR_SET = new Set<string>(PLAYER_SELECTORS)
const KNOWN_EVENT_SET = new Set<string>(KNOWN_EVENTS)
/** 需要按属性词表校验的引用根（`event.<字段>` 是开放字段，不在此列）。 */
const REF_HEADS = new Set<string>(['self', 'this'])

/* ------------------------------------------------------------------ *
 * DTO 类型（字段名 = YAML 驼峰）
 *
 * 可选字段一律写成 `?: T | undefined`：zod 的 `.optional()` 推断出的属性类型
 * 就是 `T | undefined`（见 zod `$ZodOptionalInternals`），而 tsconfig 开了
 * `exactOptionalPropertyTypes` —— 目标侧只写 `?: T` 会被 TS 判为不可赋值
 * （「Consider adding 'undefined' to the types of the target's properties」）。
 * 两侧同形，`const schema: z.ZodType<CardDto>` 的注解才有约束力。
 * ------------------------------------------------------------------ */

export interface SelectorDto {
  readonly side?: 'own' | 'enemy' | 'both' | undefined
  readonly zone?: 'cards' | 'player' | undefined
  readonly from?: 'self' | 'event' | undefined
  readonly relative?: 'adjacent' | undefined
  readonly direction?: 'both' | 'left' | 'right' | undefined
  readonly tags?: readonly string[] | undefined
  readonly tagMode?: 'any' | 'all' | undefined
  readonly filter?: ConditionDto | undefined
  readonly destroyed?: 'exclude' | 'include' | 'only' | undefined
  readonly sort?: string | undefined
  readonly random?: boolean | undefined
  readonly limit?: number | undefined
}

export type ExprDto =
  | number
  | string
  | { readonly ref: string }
  | { readonly var: string }
  | { readonly count: string | SelectorDto }
  | { readonly add: readonly ExprDto[] }
  | { readonly sub: readonly ExprDto[] }
  | { readonly mul: readonly ExprDto[] }
  | { readonly div: readonly ExprDto[] }

export type ConditionDto =
  | { readonly cmp: (typeof CMP_OPS)[number]; readonly left: ExprDto; readonly right: ExprDto }
  | { readonly not: ConditionDto }
  | { readonly any: readonly ConditionDto[] }
  | { readonly all: readonly ConditionDto[] }

export interface ActionDto {
  readonly do: PrimitiveName
  readonly target?: string | SelectorDto | undefined
  readonly stat?: string | undefined
  readonly status?: CardStatusKind | undefined
  readonly amount?: ExprDto | undefined
  readonly seconds?: ExprDto | undefined
  readonly duration?: ExprDto | undefined
  /** 持续效果通道参数——引擎尚未落地，加载时忽略。 */
  readonly enter?: ExprDto | undefined
  /** 持续效果通道参数——引擎尚未落地，加载时忽略。 */
  readonly exit?: ExprDto | undefined
  readonly stackLimit?: number | undefined
  /** 仅 `do: enchant` 使用：要施加的附魔 id（目标卡 `enchantments` 目录里那一件）。 */
  readonly enchant?: string | undefined
}

export interface AuraApplyDto {
  readonly stat: string
  readonly amount: number
}

export interface AuraMulDto {
  readonly stat: string
  readonly factor: number
}

export interface AuraDto {
  readonly select: string | SelectorDto
  readonly apply?: readonly AuraApplyDto[] | undefined
  readonly mul?: readonly AuraMulDto[] | undefined
  readonly condition?: ConditionDto | undefined
}

export interface AbilityDto {
  readonly id: number
  readonly kind: (typeof ABILITY_KINDS)[number]
  readonly actions: readonly ActionDto[]
  readonly trigger?: { readonly event: string } | undefined
  readonly condition?: ConditionDto | undefined
  readonly priority?: number | undefined
  readonly everyN?: number | undefined
}

export interface EnchantDefDto {
  readonly id: string
  /** 显示名（选填；缺省回落 id；只用于表现层） */
  readonly name?: string | undefined
  /** 玩家自定义的附魔颜色（`#rrggbb`；缺省回落内置色，见 §AE） */
  readonly color?: string | undefined
  readonly aura?: AuraDto | undefined
  readonly stats?: Readonly<Record<string, number>> | undefined
  readonly actions?: readonly ActionDto[] | undefined
}

export interface InheritOverrideDto {
  readonly rarity: string
  readonly stats?: Readonly<Record<string, number>> | undefined
  readonly abilities?:
    | readonly {
        readonly id: number
        readonly condition?: ConditionDto | undefined
        readonly actions: readonly ActionDto[]
      }[]
    | undefined
}

export interface CardDto {
  readonly id: string
  readonly name: string
  readonly version: number
  /** 单位 = 秒（可两位小数）；`-1` = 纯被动物品。映射期用 `secondsToCs()` 换算。 */
  readonly cooldown: number
  readonly size: (typeof CARD_SIZES)[number]
  readonly rarity: string
  readonly stats: Readonly<Record<string, number>>
  readonly description?: string | undefined
  readonly slots?: number | undefined
  readonly owner?: string | undefined
  readonly multicast?: number | undefined
  readonly tags?: readonly string[] | undefined
  readonly hiddenTags?: readonly string[] | undefined
  readonly aura?: AuraDto | undefined
  /** 附魔**目录**（能有哪些附魔）。⚠️ "当前生效哪一件"**不在这里**（运行期由 `do: enchant` 施加）。 */
  readonly enchantments?: readonly EnchantDefDto[] | undefined
  readonly inheritOverride?: readonly InheritOverrideDto[] | undefined
  readonly abilities?: readonly AbilityDto[] | undefined
}

export interface SkillDto {
  readonly id: string
  readonly name: string
  readonly version: number
  /**
   * **品阶 id**（**必填**，: 与卡牌 `CardDto.rarity` 同口径 = 本包 `rarities.yml` 的 `rarities[].id`）。
   * 必须是**已登记**的品阶（见 `validateSkill`）；只是声明，不参与战斗计算。
   */
  readonly rarity: string
  readonly heroes: readonly string[]
  readonly stats?: Readonly<Record<string, number>> | undefined
  readonly priority?: number | undefined
  readonly trigger?: { readonly event: string } | undefined
  readonly condition?: ConditionDto | undefined
  readonly actions?: readonly ActionDto[] | undefined
  readonly aura?: AuraDto | undefined
  readonly description?: string | undefined
}

export interface HeroDto {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly initHp: number
  readonly initMaxHp?: number | undefined
  readonly levelupMaxHp?: readonly number[] | undefined
  readonly description?: string | undefined
}

export interface RarityDto {
  readonly id: string
  readonly name: string
  readonly color: string
  readonly frame?: string | undefined
  /**
   * **该品阶的卡牌基础价值**（ 新增； ``：价值定义并入品阶文件）。
   * 卡面 `stats.value` 缺省时按它初始化；不写则回落到引擎内置兜底表（bronze 1 / silver 3 / gold 8 / diamond 20）。
   */
  readonly value?: number | undefined
  /**
   * **该品阶的当前售价**：不写 ⇒ 等于本品阶的 `value`；写了 ⇒ 覆盖。
   */
  readonly prize?: number | undefined
}

export interface RaritiesFileDto {
  readonly rarities: readonly RarityDto[]
  readonly upgrade?: readonly string[] | undefined
}

/**
 * `engineRange` 的一项 = **半开区间**（ ``：结构化对象）。
 * 缺省 **左闭右开** —— `from` 含、`to` 不含；要改就显式写 `fromInclusive: false` / `toInclusive: true`。
 * `from` / `to` 省略 = 该侧无界；两者是**三段版本串** `major.minor.patch`（YAML 里形如 `'0.10.0'`）。
 */
export interface EngineRangeDto {
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly fromInclusive?: boolean | undefined
  readonly toInclusive?: boolean | undefined
}

export interface PackManifestDto {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly description?: string | undefined
  readonly builtin?: boolean | undefined
  readonly owner?: string | undefined
  readonly engineRange: readonly EngineRangeDto[]
  readonly author?: string | undefined
  readonly license?: string | undefined
  readonly homepage?: string | undefined
  readonly checksum?: string | undefined
  readonly createdAt?: string | undefined
  readonly updatedAt?: string | undefined
  readonly rarities?: { readonly source?: 'builtin' | 'file' | undefined } | undefined
  readonly cards?: readonly string[] | undefined
  readonly skills?: readonly string[] | undefined
  readonly assets?: readonly string[] | undefined
  readonly dependencies?:
    | readonly (string | { readonly id: string; readonly minVersion?: number | undefined })[]
    | undefined
}

/* ------------------------------------------------------------------ *
 * zod 结构校验
 * ------------------------------------------------------------------ */

const selectorDtoSchema: z.ZodType<SelectorDto> = z.lazy(() =>
  z.strictObject({
    side: z.enum(['own', 'enemy', 'both']).optional(),
    zone: z.enum(['cards', 'player']).optional(),
    from: z.enum(['self', 'event']).optional(),
    relative: z.enum(['adjacent']).optional(),
    direction: z.enum(['both', 'left', 'right']).optional(),
    tags: z.array(z.string()).optional(),
    tagMode: z.enum(['any', 'all']).optional(),
    filter: conditionDtoSchema.optional(),
    destroyed: z.enum(['exclude', 'include', 'only']).optional(),
    sort: z.string().optional(),
    random: z.boolean().optional(),
    limit: z.int().min(1).optional(),
  }),
)

const exprDtoSchema: z.ZodType<ExprDto> = z.lazy(() =>
  z.union([
    z.number(),
    z.string(),
    z.strictObject({ ref: z.string() }),
    z.strictObject({ var: z.string() }),
    z.strictObject({ count: z.union([z.string(), selectorDtoSchema]) }),
    z.strictObject({ add: z.array(exprDtoSchema) }),
    z.strictObject({ sub: z.array(exprDtoSchema) }),
    z.strictObject({ mul: z.array(exprDtoSchema) }),
    z.strictObject({ div: z.array(exprDtoSchema) }),
  ]),
)

const conditionDtoSchema: z.ZodType<ConditionDto> = z.lazy(() =>
  z.union([
    z.strictObject({ cmp: z.enum(CMP_OPS), left: exprDtoSchema, right: exprDtoSchema }),
    z.strictObject({ not: conditionDtoSchema }),
    z.strictObject({ any: z.array(conditionDtoSchema) }),
    z.strictObject({ all: z.array(conditionDtoSchema) }),
  ]),
)

const triggerDtoSchema = z.strictObject({ event: z.string().min(1) })

const actionDtoSchema = z.strictObject({
  do: z.enum(PRIMITIVE_NAMES),
  target: z.union([z.string(), selectorDtoSchema]).optional(),
  stat: z.string().optional(),
  status: z.enum(CARD_STATUS_KINDS).optional(),
  amount: exprDtoSchema.optional(),
  seconds: exprDtoSchema.optional(),
  duration: exprDtoSchema.optional(),
  enter: exprDtoSchema.optional(),
  exit: exprDtoSchema.optional(),
  stackLimit: z.int().min(1).optional(),
  enchant: z.string().min(1).optional(),
})

const auraApplyDtoSchema = z.strictObject({ stat: z.string().min(1), amount: z.number() })
const auraMulDtoSchema = z.strictObject({ stat: z.string().min(1), factor: z.number() })

const auraDtoSchema: z.ZodType<AuraDto> = z.strictObject({
  select: z.union([z.string().min(1), selectorDtoSchema]),
  apply: z.array(auraApplyDtoSchema).optional(),
  mul: z.array(auraMulDtoSchema).optional(),
  condition: conditionDtoSchema.optional(),
})

const abilityDtoSchema = z.strictObject({
  id: z.int().min(1),
  kind: z.enum(ABILITY_KINDS),
  actions: z.array(actionDtoSchema).min(1, 'abilities[].actions 至少 1 条'),
  trigger: triggerDtoSchema.optional(),
  condition: conditionDtoSchema.optional(),
  priority: z.int().min(1, 'priority 范围 1–10').max(10, 'priority 范围 1–10').optional(),
  everyN: z.int().min(2, 'everyN 必须 ≥ 2').optional(),
})

const inheritOverrideDtoSchema = z.strictObject({
  rarity: z.string().min(1),
  stats: z.record(z.string(), z.number()).optional(),
  abilities: z
    .array(
      z.strictObject({
        id: z.int().min(1),
        condition: conditionDtoSchema.optional(),
        actions: z.array(actionDtoSchema).min(1, 'inheritOverride 的 actions 至少 1 条'),
      }),
    )
    .optional(),
})

/** 卡牌 id / 卡包 id 的字面规则：小写下划线且以字母开头。 */
/**
 * id 形状：**允许驼峰与蛇形混用** —— 首字符必须是字母，其余为字母 / 数字 / 下划线。
 *
 * 为什么要放宽：模板统一用**驼峰 id**（`myPack` / `myCard` / `myHero` / `mySkill`）。
 * 原判据 `^[a-z][a-z0-9_]*$` 会把驼峰 id 在**结构层**直接拒掉。
 * 仍然禁止：数字开头、连字符、点、空格、中文（这些会让"文件名 = id = 目录名"的对应关系变脆）。
 */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * 一件附魔：`id` + **至少一块**效果（`aura` / `stats` / `actions`）。
 *
 * 三块全空的附魔没有任何作用，属写法错误（`error`）。
 */
const enchantDefDtoSchema: z.ZodType<EnchantDefDto> = z
  .strictObject({
    id: z.string().regex(ID_PATTERN, 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰）'),
    name: z.string().min(1).optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'color 写 #rrggbb（六位十六进制，如 #b197fc）')
      .optional(),
    aura: auraDtoSchema.optional(),
    stats: z.record(z.string(), z.number()).optional(),
    actions: z.array(actionDtoSchema).optional(),
  })
  .refine(
    (value) => value.aura !== undefined || value.stats !== undefined || value.actions !== undefined,
    '附魔至少要写出 aura / stats / actions 之一（三块全空 = 这件附魔没有任何作用）',
  )

export const cardDtoSchema: z.ZodType<CardDto> = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰）'),
  name: z.string().min(1),
  version: z.int().min(1, 'version 必须 ≥ 1'),
  cooldown: z.number().refine((value) => value === -1 || value > 0, 'cooldown 必须是 -1（纯被动物品）或 > 0 的秒数'),
  size: z.enum(CARD_SIZES),
  rarity: z.string().min(1),
  stats: z.record(z.string(), z.number()),
  description: z.string().optional(),
  slots: z.int().min(1).max(3).optional(),
  owner: z.string().optional(),
  multicast: z.int().min(1).optional(),
  tags: z.array(z.string()).optional(),
  hiddenTags: z.array(z.string()).optional(),
  aura: auraDtoSchema.optional(),
  enchantments: z.array(enchantDefDtoSchema).optional(),
  inheritOverride: z.array(inheritOverrideDtoSchema).optional(),
  abilities: z.array(abilityDtoSchema).optional(),
})

export const skillDtoSchema: z.ZodType<SkillDto> = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰）'),
  name: z.string().min(1),
  version: z.int().min(1, 'version 必须 ≥ 1'),
  heroes: z.array(z.string().min(1)).min(1, 'heroes 必填且非空（可写 common / sp）'),
  rarity: z.string().min(1, 'rarity 必填（与卡牌同口径：技能的品阶 id）'),
  stats: z.record(z.string(), z.number()).optional(),
  priority: z.int().min(1, 'priority 范围 1–10').max(10, 'priority 范围 1–10').optional(),
  trigger: triggerDtoSchema.optional(),
  condition: conditionDtoSchema.optional(),
  actions: z.array(actionDtoSchema).optional(),
  aura: auraDtoSchema.optional(),
  description: z.string().optional(),
})

export const heroDtoSchema: z.ZodType<HeroDto> = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰）'),
  name: z.string().min(1),
  version: z.int().min(1, 'version 必须 ≥ 1'),
  initHp: z.number(),
  initMaxHp: z.number().optional(),
  levelupMaxHp: z.array(z.number()).optional(),
  description: z.string().optional(),
})

export const raritiesFileDtoSchema: z.ZodType<RaritiesFileDto> = z.strictObject({
  rarities: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      color: z.string().min(1),
      frame: z.string().optional(),
      value: z.number().min(0, 'value 不能为负').optional(),
      prize: z.number().min(0, 'prize 不能为负').optional(),
    }),
  ).min(1, 'rarities 至少 1 项'),
  upgrade: z.array(z.string()).optional(),
})

const engineRangeDtoSchema = z
  .strictObject({
    from: z.string().optional(),
    to: z.string().optional(),
    fromInclusive: z.boolean().optional(),
    toInclusive: z.boolean().optional(),
  })
  .refine((value) => value.from !== undefined || value.to !== undefined, {
    message: 'engineRange 的每一项至少要写 from 或 to 之一（两侧都省 = 无意义的空区间）',
  })

export const packManifestDtoSchema: z.ZodType<PackManifestDto> = z.strictObject({
  id: z.string().regex(ID_PATTERN, 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰）'),
  name: z.string().min(1),
  version: z.int().min(1, 'version 必须 ≥ 1'),
  description: z.string().optional(),
  builtin: z.boolean().optional(),
  owner: z.string().optional(),
  engineRange: z
    .array(engineRangeDtoSchema)
    .min(1, "engineRange 必填且至少 1 项（每项形如 { from: '0.0.0', to: '1.0.0' }，缺省左闭右开）"),
  author: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().optional(),
  checksum: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  rarities: z.strictObject({ source: z.enum(['builtin', 'file']).optional() }).optional(),
  cards: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  assets: z.array(z.string()).optional(),
  dependencies: z
    .array(z.union([z.string(), z.strictObject({ id: z.string(), minVersion: z.int().min(1).optional() })]))
    .optional(),
})

/* ------------------------------------------------------------------ *
 * 上下文、错误构造与 zod issue 转换
 * ------------------------------------------------------------------ */

/** 问题分级：`error` 阻断注册，`warn` / `note` 只记录。 */
export type IssueSeverity = 'error' | 'warn' | 'note'

/** 一份文件的校验上下文：文件路径 + 该文件的 path→位置表。 */
export interface ValidationContext {
  readonly file: string
  readonly positions: ReadonlyMap<string, SourcePosition>
}

interface ProblemOptions {
  readonly severity?: IssueSeverity
  readonly suggestion?: string
  readonly side?: 'A' | 'B'
  /** 显式行号（1 起算）；只在位置表不可用时用（YAML 语法错）。 */
  readonly line?: number
  /** 显式列号（1 起算）；与 `line` 配对使用。 */
  readonly column?: number
}

/** 构造期的可变视图（`ValidationError` 的字段对外是只读的）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** 唯一的错误构造入口（保证 `file` / `line` / `column` / `severity` 口径一致）。 */
export function problem(
  code: string,
  message: string,
  ctx: ValidationContext,
  path: readonly (string | number)[] = [],
  options: ProblemOptions = {},
): ValidationError {
  const formatted = formatIssuePath(path)
  const position = lookupPosition(ctx.positions, formatted)
  const line = options.line ?? position?.line
  const column = options.column ?? position?.column
  const error: Mutable<ValidationError> = {
    code,
    message,
    file: ctx.file,
    severity: options.severity ?? 'error',
  }
  if (formatted.length > 0) error.path = formatted
  if (line !== undefined) error.line = line
  if (column !== undefined) error.column = column
  if (options.suggestion !== undefined) error.suggestion = options.suggestion
  if (options.side !== undefined) error.side = options.side
  return error
}

/** 由路径给出人读建议（只覆盖高频踩坑点，取不到就返回 `undefined`）。 */
function suggestForPath(path: string): string | undefined {
  // ⚠️ 精确匹配（顶层字段名，如 `icon` / `tags`）必须排在所有 `endsWith` 之前
  //    `endsWith` 是宽匹配，会把这些短名先吞掉。
  // （ ``）：技能 `icon` 字段已删除，图标改走文件名约定
  if (path === 'icon') {
    return 'icon 字段已废除：技能图标走文件名约定 images/skills/<skill_id>.png'
  }
  // **卡面 `frame` 已删除** —— 卡框**只由品阶决定**，加载在前端做
  if (path === 'frame') {
    return 'frame 字段已废除：卡框由**品阶**决定（rarities.yml 的 frame / color），素材走 images/frames/<frame>/card_frame.png'
  }
  // （ `` / ``）：角色 `tags` 已删除（卡牌的 `tags` / `hiddenTags` 不受影响）
  if (path === 'tags') {
    return '角色没有 tags 字段；卡牌与选择器的 tags 不受影响'
  }
  // engineRange 已改为**结构化区间列表**（ ``）：版本号是字符串、必须写全 major.minor.patch
  if (path.startsWith('engineRange')) {
    return "engineRange 是区间列表，每项写 { from: '0.10.0', to: '0.20.0' }（缺省左闭右开）；版本号写全三段并加引号"
  }
  if (path === 'enchant') {
    return 'enchant 不是卡面字段：它是**运行期状态**（当前生效哪一件附魔），只能由 `do: enchant` 在局内施加；'
      + '卡面只写目录 `enchantments`（"出厂自带附魔"将来走购买阶段 trigger）'
  }
  if (path === 'enchantments' || path.startsWith('enchantments')) {
    return 'enchantments 是**附魔目录**：每项写 { id, aura?, stats?, actions? }，至少写一块；id 卡内唯一'
  }
  if (path.endsWith('.do') || path === 'do') {
    return '动作原语取封闭词表；`enchant` 已登记但实现搁置，本轮直接拒绝'
  }
  if (path.endsWith('.target') || path === 'target') {
    return '选择器取 13 条封闭缩写或查询对象；作用于自身写 target: self'
  }
  if (path.endsWith('.event') || path === 'event') {
    return `当前引擎只广播 ${KNOWN_EVENTS.join(' / ')}；其余时机已规划但未落地`
  }
  if (path.endsWith('.cmp')) return '比较符取 lt / lte / gt / gte / eq / neq'
  if (path.endsWith('.ref')) return '引用形如 self.<stat> / this.<stat> / event.<字段>'
  if (path.endsWith('.cooldown')) return 'cooldown 单位是秒（两位小数）；-1 = 纯被动物品'
  if (path.endsWith('.icon')) {
    return 'icon 字段已废除：技能图标走文件名约定 images/skills/<skill_id>.png'
  }
  if (path.endsWith('.stat')) return `属性键取：${ALL_STAT_KEYS.join(' / ')}`
  if (path.endsWith('.id')) return 'id 首字符必须是字母，其余为字母 / 数字 / 下划线（可驼峰），且与文件名一致'
  return undefined
}

/** zod 的 issue 类型（避免直接依赖 zod 内部类型名）。 */
export type ZodIssueLike = z.ZodError['issues'][number]

/**
 * 把 zod 的 issue 列表翻译成统一的 `ValidationError[]`。
 *
 * 行号：`issuesToErrors` 只做结构错；语法错在 `parseYamlDocument` 里单独成条。
 */
export function issuesToErrors(
  issues: readonly ZodIssueLike[],
  ctx: ValidationContext,
): readonly ValidationError[] {
  const errors: ValidationError[] = []
  for (const issue of issues) {
    const path = issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment)))
    const formatted = formatIssuePath(path)
    let message = issue.message
    let suggestion = suggestForPath(formatted)
    if (issue.code === 'unrecognized_keys') {
      message = `未知字段：${issue.keys.join('、')}`
      const cardOnly = issue.keys.filter((key) => CARD_ONLY_FIELDS.includes(key))
      const pending = issue.keys.filter((key) => PENDING_FIELDS.includes(key))
      const abolished = issue.keys.filter((key) => ABOLISHED_FIELDS.includes(key))
      // ⚠️ `unrecognized_keys` 的 `issue.path` 是**空数组**（指向对象本身），字段名只在 `issue.keys` 里
      //    ⇒ 建议必须**按 keys 逐个取**，不能沿用上面那行基于 `path` 的 `suggestForPath(formatted)`
      //    （ 的 `icon` / `tags` 两条废除建议一度因此永不命中）。
      //    优先级：**实现搁置 > 已废除 > 卡牌专属 > 逐键专项建议 > 通用文案** —— 前两类是"这个字段为什么在这儿"的
      //    真正答案，不该被某个恰好同名/同后缀的专项建议顶掉。
      const perKey = [...new Set(issue.keys.map((key) => suggestForPath(key)).filter((text) => text !== undefined))]
      suggestion =
        pending.length > 0
          ? '`enchant` 不是卡面字段：它是**运行期状态**（当前生效哪一件附魔），只能由 `do: enchant` 在局内施加；'
            + '卡面只写目录 `enchantments`（"出厂自带附魔"将来走购买阶段 trigger）'
          : abolished.length > 0
          ? '主动 / 被动行为已统一写在 abilities 里；`buyPrize` / `prize` 已废除：'
            + '卡牌价值改写在 `stats.value`，缺省取当前品阶的 `value`'
          : cardOnly.length > 0
            ? `${cardOnly.join(' / ')} 是卡牌专属字段，不得出现在技能文件里`
            : perKey.length > 0
              ? perKey.join('；')
              : '未知字段一律拒绝；请对照的字段表'
    }
    errors.push(problem(LOAD_ERROR_CODES.schemaInvalid, message, ctx, path, suggestion === undefined ? {} : { suggestion }))
  }
  return errors
}

/** 按结构 schema 校验一份文档，返回结构错误（空数组 = 结构通过）。 */
export function checkDto<T>(
  schema: z.ZodType<T>,
  value: unknown,
  ctx: ValidationContext,
): readonly ValidationError[] {
  const result = schema.safeParse(value)
  if (result.success) return []
  return issuesToErrors(result.error.issues, ctx)
}

/* ------------------------------------------------------------------ *
 * YAML 解析（语法错 → yaml.syntax）
 * ------------------------------------------------------------------ */

export interface ParsedDocument {
  readonly value: unknown
  readonly positions: ReadonlyMap<string, SourcePosition>
  readonly syntaxError?: ValidationError
}

/**
 * 解析 YAML 文本：语法错**不抛**，转为一条 `yaml.syntax`（带 1 起算的 line / column）。
 */
export function parseYamlDocument(text: string, file: string): ParsedDocument {
  const positions = collectPositions(text)
  try {
    const value = load(text, { filename: file })
    return { value, positions }
  } catch (error) {
    if (error instanceof YAMLException) {
      const ctx: ValidationContext = { file, positions }
      const mark = error.mark
      // 语法错时位置表不可用，行列号直接来自 js-yaml（`mark.line` / `mark.column` 是 0 起算）
      const at = mark === undefined ? {} : { line: mark.line + 1, column: mark.column + 1 }
      return {
        value: undefined,
        positions,
        syntaxError: problem(LOAD_ERROR_CODES.yamlSyntax, error.reason, ctx, [], at),
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    const ctx: ValidationContext = { file, positions }
    return { value: undefined, positions, syntaxError: problem(LOAD_ERROR_CODES.yamlSyntax, message, ctx) }
  }
}

/* ------------------------------------------------------------------ *
 * 语义校验：选择器 / 表达式 / 动作 / 光环
 * ------------------------------------------------------------------ */

function checkSelector(
  select: string | SelectorDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
  params?: readonly string[],
): void {
  if (typeof select === 'string') {
    if (!SELECTOR_SHORTHANDS.includes(select)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `未知选择器：${select}`, ctx, path, {
          suggestion: `封闭词表（13 条）：${SELECTOR_SHORTHANDS.join(' / ')}`,
        }),
      )
    }
    return
  }
  if (select.filter !== undefined) checkCondition(select.filter, ctx, [...path, 'filter'], issues, definedStats, params)
  try {
    // DTO 与引擎类型在嵌套 `filter` 上不同形（驼峰 DTO ↔ 引擎 `Condition`），运行时形状一致
    validateQuery(select as unknown as SelectorQuery)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `选择器写法不合法：${message}`, ctx, path, {
        suggestion: '对照 的封闭词表与查询对象规则',
      }),
    )
  }
}

/** 该选择器是否**只**点名玩家（用于光环玩家侧限制判定）。 */
function targetsPlayers(select: string | SelectorDto): boolean {
  if (typeof select === 'string') return PLAYER_SELECTOR_SET.has(select)
  return select.zone === 'player'
}

/** 引用文本（裸 `self.atk` 或 `{ ref: self.atk }`）里的 `self` / `this` 属性必须落在封闭词表内、且已在本文件 `stats` 中声明。 */
function checkRefText(
  ref: string,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
): void {
  const dot = ref.indexOf('.')
  if (dot === -1) {
    if (REF_HEADS.has(ref)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `引用缺少属性名：${ref}`, ctx, path, {
          suggestion: '形如 self.atk / this.atk（属性名可省略时请直接写字面量）',
        }),
      )
    }
    return
  }
  const head = ref.slice(0, dot)
  const tail = ref.slice(dot + 1)
  if (REF_HEADS.has(head) && !STAT_KEY_SET.has(tail)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `引用未知属性：${ref}`, ctx, path, {
        suggestion: `属性键取：${ALL_STAT_KEYS.join(' / ')}`,
      }),
    )
    return
  }
  // self.<stat> 引用的字段必须在 stats 中定义（speed / cdp 有非 0 缺省值，不算未定义）
  if (
    REF_HEADS.has(head) &&
    definedStats !== undefined &&
    !definedStats.has(tail) &&
    !IMPLICIT_STAT_DEFAULTS.has(tail)
  ) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `引用未定义的属性：${ref}`, ctx, path, {
        suggestion: `：self.<stat> 引用的字段必须在 stats 中声明（本文件已声明：${[...definedStats].join(' / ') || '（空）'}）；未声明的键运行时读作 0`,
      }),
    )
  }
}

/**
 * `{ var: ... }` 校验：参数名必须在当前事件的参数表里；点号只能取一层、字段必须在封闭字段表内。
 *
 * **与运行期同口径**：参数名不存在时 `engine/expr.ts` 的 `resolveVarValue` 会抛错并**中止整局**，
 * 所以这里必须拦住 —— 否则就是"校验绿、上场炸"。
 */
function checkVarRef(
  varName: string,
  params: readonly string[] | undefined,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
): void {
  const dot = varName.indexOf('.')
  const base = dot > 0 ? varName.slice(0, dot) : varName
  const field = dot > 0 ? varName.slice(dot + 1) : undefined

  if (params !== undefined && !params.includes(base)) {
    const hint =
      base === 'source'
        ? '；⚠️ `source` 只在**必有来源卡**的事件里存在（`before_action` / `after_action` / 主动能力）—— 技能与持续效果产生的事件里它**整个不存在**'
        : ''
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `事件参数 ${base} 不存在`, ctx, path, {
        severity: 'error',
        suggestion: `本事件可用的参数：${params.join(' / ')}（见《参数表设计.md》§4 / §5）${hint}`,
      }),
    )
    return
  }

  if (field === undefined) return

  const kind = VAR_REF_KINDS[base]
  if (kind === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `事件参数 ${base} 不是引用型，不能取属性`, ctx, path, {
        severity: 'error',
        suggestion: '只有 card_ref / player_ref 型参数能取属性（如 { var: card.atk }）',
      }),
    )
    return
  }

  const valid = kind === 'card' ? [...CARD_REF_EXTRA_FIELDS, ...STAT_KEYS] : PLAYER_REF_FIELDS
  if (!valid.includes(field)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `事件参数取属性 ${varName} 的字段不合法`, ctx, path, {
        severity: 'error',
        suggestion: `合法字段：${valid.join(' / ')}；写法是**平铺一层**，card.stats.atk 不是合法写法`,
      }),
    )
  }
}

/**
 * 引用类表达式校验：`self.<stat>` / `this.<stat>` 必须在封闭属性词表内、且已声明；
 * `{ var: ... }` 的参数名必须在当前事件的参数表里、点号取属性只能一层。
 *
 * `params` = 当前事件允许的**全部**参数名（通用 + 专属）。`undefined` = **事件上下文未知**
 * （`inheritOverride` 段 / 光环的 `select` / 未知时机词）⇒ 只查点号合法性、**不查参数名**，
 * 免得在拿不准上下文的地方误报。
 */
function checkExprRefs(
  expr: ExprDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
  params?: readonly string[],
): void {
  if (typeof expr === 'number') return
  if (typeof expr === 'string') {
    // 裸 `self.<stat>` 是 允许的写法（与 `{ ref: self.<stat> }` 等价），同样要查词表
    checkRefText(expr, ctx, path, issues, definedStats)
    return
  }
  if ('var' in expr) {
    checkVarRef(expr.var, params, ctx, [...path, 'var'], issues)
    return
  }
  if ('ref' in expr) {
    checkRefText(expr.ref, ctx, [...path, 'ref'], issues, definedStats)
    return
  }
  if ('count' in expr) {
    const count = expr.count
    if (typeof count !== 'string') checkSelector(count, ctx, [...path, 'count'], issues, definedStats, params)
    return
  }
  if ('add' in expr) {
    checkExprList(expr.add, 'add', ctx, path, issues, definedStats, params)
    return
  }
  if ('sub' in expr) {
    checkExprList(expr.sub, 'sub', ctx, path, issues, definedStats, params)
    return
  }
  if ('mul' in expr) {
    checkExprList(expr.mul, 'mul', ctx, path, issues, definedStats, params)
    return
  }
  if ('div' in expr) {
    checkExprList(expr.div, 'div', ctx, path, issues, definedStats, params)
    return
  }
}

/**
 * `add` / `sub` / `mul` / `div` 的共同子项遍历。
 * **四个键分开写**、不拿 `key` 去索引联合类型 —— 键是联合字面量时 TS 不做收窄，`expr[key]` 会报 TS7053。
 */
function checkExprList(
  list: readonly ExprDto[],
  key: string,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
  params?: readonly string[],
): void {
  for (const [index, item] of list.entries()) {
    checkExprRefs(item, ctx, [...path, key, index], issues, definedStats, params)
  }
}

function checkCondition(
  condition: ConditionDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
  params?: readonly string[],
): void {
  if ('cmp' in condition) {
    checkExprRefs(condition.left, ctx, [...path, 'cmp', 'left'], issues, definedStats, params)
    checkExprRefs(condition.right, ctx, [...path, 'cmp', 'right'], issues, definedStats, params)
    return
  }
  if ('not' in condition) {
    checkCondition(condition.not, ctx, [...path, 'not'], issues, definedStats, params)
    return
  }
  const list = 'any' in condition ? condition.any : condition.all
  const key = 'any' in condition ? 'any' : 'all'
  for (const [index, item] of list.entries()) {
    checkCondition(item, ctx, [...path, key, index], issues, definedStats, params)
  }
}

/** 只能作用于**玩家**的原语。 */
const PLAYER_ONLY_PRIMITIVES: readonly PrimitiveName[] = ['deal_damage', 'heal_player', 'shield']

/** 只能作用于**卡牌**的原语（同上；选到玩家 ⇒ ❌）。 */
const CARD_ONLY_PRIMITIVES: readonly PrimitiveName[] = ['apply_status', 'charge', 'destroy', 'repair', 'enchant']

/**
 * 静态判定一条动作的目标类型（`'player'` / `'cards'`；判不出来返回 `undefined`）。
 *
 * 口径 = 引擎实况：`applyAction` 里 `spec.target ?? 'self'` ⇒ 省略 target = **来源卡**；
 * 查询对象的 `from` 分支只可能给出卡（[engine/selectors.ts](../engine/selectors.ts) 的 `selectFrom`）；
 * 其余按 `zone ?? 'cards'`（同文件的 `candidatesOf`）。未知缩写不在这里判（由 `checkSelector` 报，避免双报）。
 */
function targetKindOf(target: string | SelectorDto | undefined): 'player' | 'cards' | undefined {
  if (target === undefined) return 'cards'
  if (typeof target === 'string') {
    if (!SELECTOR_SHORTHANDS.includes(target)) return undefined
    return PLAYER_SELECTOR_SET.has(target) ? 'player' : 'cards'
  }
  if (target.from !== undefined) return 'cards'
  return target.zone === 'player' ? 'player' : 'cards'
}

/**
 * **原语 × 目标类型**兼容性。
 *
 *  第 3 条把"校验器必须在校验期拦下同类问题"写成**硬性配套要求** —— 否则卡包能过校验、
 * 却在对局里抛 `selector.type_mismatch` 中止（正是 `deal_damage` 打卡牌那种写法）。
 */
function checkActionTargetKind(
  action: ActionDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
): void {
  const kind = targetKindOf(action.target)
  if (kind === undefined) return
  const at = [...path, 'target']

  if (kind === 'cards' && PLAYER_ONLY_PRIMITIVES.includes(action.do)) {
    //  = A：打卡牌 = **写错** —— 卡牌没有血量，
    // 且 `on_card_damaged` 时机词已按 "无损失 + 广播"那条旧口径）
    issues.push(
      problem(
        LOAD_ERROR_CODES.schemaInvalid,
        action.do === 'deal_damage'
          ? 'deal_damage 不能作用于卡牌（卡牌没有血量；运行期会先记 error 级 selector.type_mismatch 再中止对局）'
          : `${action.do} 不能作用于卡牌（该原语只处理玩家）`,
        ctx,
        at,
        {
          suggestion:
            '作用于玩家写 own_player / enemy_player；要作用卡牌就换 apply_status / charge / destroy / repair',
        },
      ),
    )
    return
  }

  if (kind === 'player' && CARD_ONLY_PRIMITIVES.includes(action.do)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `${action.do} 不能作用于玩家（该原语只处理卡牌）`, ctx, at, {
        suggestion: '作用于卡牌写 self / all_own_cards / random_enemy_card 等；作用于玩家就换 deal_damage / heal_player / shield',
      }),
    )
    return
  }

  if (action.do === 'gain_stat' && action.stat !== undefined) {
    const isDot = DOT_STAT_SET.has(action.stat)
    if (kind === 'player' && !isDot) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `gain_stat 施加给玩家的 stat「${action.stat}」不是持续效果（玩家侧只认 burn / poison / regen）`,
          ctx,
          at,
          { suggestion: `玩家侧只认 ${[...DOT_STAT_SET].join(' / ')}；给卡牌加属性请把 target 写成卡牌选择器` },
        ),
      )
    } else if (kind === 'cards' && isDot) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `gain_stat 不能把持续效果「${action.stat}」施加给卡牌（卡牌没有持续效果通道）`,
          ctx,
          at,
          { suggestion: '持续效果只施加给玩家：target 写 own_player / enemy_player' },
        ),
      )
    }
  }
}

function checkAction(
  action: ActionDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
  params?: readonly string[],
): void {
  if (action.target === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, '未写 target', ctx, path, {
        severity: 'warn',
        suggestion: ' 要求 target 必填；引擎缺省按 self 处理，本轮按 self 执行',
      }),
    )
  } else {
    checkSelector(action.target, ctx, [...path, 'target'], issues, definedStats, params)
  }
  // `enchant` 参数的专用性：只有 `do: enchant` 接受它
  if (action.do === 'enchant') {
    if (action.enchant === undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'do: enchant 缺少 enchant 参数（附魔 id）', ctx, path, {
          suggestion: '：写 { do: enchant, target: <卡牌选择器>, enchant: <本卡 enchantments 里的 id> }',
        }),
      )
    } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(action.enchant)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `附魔 id 形状不合法：${action.enchant}`, ctx, [...path, 'enchant'], {
          suggestion: '：首字符字母，其余字母 / 数字 / 下划线（与其它 id 同规则）',
        }),
      )
    }
  } else if (action.enchant !== undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'enchant 参数只用于 do: enchant', ctx, [...path, 'enchant'], {
        suggestion: `：${action.do} 不接受 enchant 参数`,
      }),
    )
  }
  checkActionTargetKind(action, ctx, path, issues)

  if (action.do === 'gain_stat' && action.stat === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'gain_stat 必须写 stat', ctx, path, {
        suggestion: `属性键取：${ALL_STAT_KEYS.join(' / ')}`,
      }),
    )
  }
  if (action.stat !== undefined && (!STAT_KEY_SET.has(action.stat) || action.do !== 'gain_stat')) {
    if (!STAT_KEY_SET.has(action.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `未知属性键：${action.stat}`, ctx, [...path, 'stat'], {
          suggestion: `属性键取：${ALL_STAT_KEYS.join(' / ')}`,
        }),
      )
    } else if (action.do !== 'gain_stat') {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `stat 仅在 gain_stat 下有效（当前 do: ${action.do}）`, ctx, [
          ...path,
          'stat',
        ], { severity: 'warn' }),
      )
    }
  }
  if (action.do === 'apply_status' && action.status === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'apply_status 必须写 status', ctx, path, {
        suggestion: `status 取：${CARD_STATUS_KINDS.join(' / ')}`,
      }),
    )
  }
  if (action.status !== undefined && action.do !== 'apply_status') {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `status 仅在 apply_status 下有效（当前 do: ${action.do}）`, ctx, [
        ...path,
        'status',
      ], { severity: 'warn' }),
    )
  }

  // 效果数额字面量政策
  if (typeof action.amount === 'number') {
    const isDotLayers = action.do === 'gain_stat' && action.stat !== undefined && DOT_STAT_SET.has(action.stat)
    if (EFFECT_AMOUNT_PRIMITIVES.includes(action.do) || isDotLayers) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `效果数额写成字面量 ${action.amount}`,
          ctx,
          [...path, 'amount'],
          {
            severity: 'warn',
            suggestion: ' 要求引用 { ref: self.<stat> }；本轮按字面量执行',
          },
        ),
      )
    }
  } else if (action.amount !== undefined) {
    checkExprRefs(action.amount, ctx, [...path, 'amount'], issues, definedStats, params)
  }
  if (action.seconds !== undefined) checkExprRefs(action.seconds, ctx, [...path, 'seconds'], issues, definedStats, params)

  // 持续效果通道
  const dotChannel =
    action.do === 'gain_stat' &&
    action.stat !== undefined &&
    DOT_STAT_SET.has(action.stat) &&
    action.target !== undefined &&
    targetsPlayers(action.target)
  if (action.duration !== undefined) {
    checkExprRefs(action.duration, ctx, [...path, 'duration'], issues, definedStats, params)
    if (!dotChannel) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'duration 仅在 gain_stat + 玩家 + burn/poison/regen 通道允许', ctx, [
          ...path,
          'duration',
        ], { suggestion: '' }),
      )
    }
  }
  for (const key of ['enter', 'exit'] as const) {
    if (action[key] === undefined) continue
    checkExprRefs(action[key], ctx, [...path, key], issues, definedStats, params)
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `${key} 通道参数引擎尚未落地`, ctx, [...path, key], {
        severity: 'note',
        suggestion: ' 已登记；本轮加载时忽略该参数',
      }),
    )
  }
}

function checkAura(
  aura: AuraDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
): void {
  checkSelector(aura.select, ctx, [...path, 'select'], issues, definedStats)
  if (aura.condition !== undefined) {
    checkCondition(aura.condition, ctx, [...path, 'condition'], issues, definedStats)
  }

  const apply = aura.apply ?? []
  const mul = aura.mul ?? []
  if (apply.length === 0 && mul.length === 0) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'apply / mul 至少一条非空', ctx, path, {
        suggestion: '光环必须至少有一个贡献通道',
      }),
    )
  }

  const playersOnly = targetsPlayers(aura.select)
  const seenApply = new Set<string>()
  const seenMul = new Set<string>()

  for (const [index, entry] of apply.entries()) {
    const entryPath = [...path, 'apply', index]
    if (!STAT_KEY_SET.has(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `未知属性键：${entry.stat}`, ctx, [...entryPath, 'stat'], {
          suggestion: `属性键取：${ALL_STAT_KEYS.join(' / ')}`,
        }),
      )
    }
    if (seenApply.has(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `apply 通道内 stat 重复：${entry.stat}`, ctx, entryPath, {
          suggestion: '同一通道内同一 stat 只能写一次',
        }),
      )
    }
    seenApply.add(entry.stat)
    if (FORBIDDEN_APPLY_STATS.includes(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `apply 通道禁用 stat：${entry.stat}`, ctx, [...entryPath, 'stat'], {
          suggestion: `apply 禁区：${FORBIDDEN_APPLY_STATS.join(' / ')}`,
        }),
      )
    }
    if (playersOnly && !DOT_STAT_SET.has(entry.stat)) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `select 命中玩家时只能用 burn / poison / regen 的固定数值 apply（当前 ${entry.stat}）`,
          ctx,
          [...entryPath, 'stat'],
          { suggestion: ' 规则 4；玩家侧的 shield / hp / maxHp 一律不支持' },
        ),
      )
    }
  }

  for (const [index, entry] of mul.entries()) {
    const entryPath = [...path, 'mul', index]
    if (!STAT_KEY_SET.has(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `未知属性键：${entry.stat}`, ctx, [...entryPath, 'stat'], {
          suggestion: `属性键取：${ALL_STAT_KEYS.join(' / ')}`,
        }),
      )
    }
    if (seenMul.has(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `mul 通道内 stat 重复：${entry.stat}`, ctx, entryPath, {
          suggestion: '同一通道内同一 stat 只能写一次',
        }),
      )
    }
    seenMul.add(entry.stat)
    if (FORBIDDEN_MUL_STATS.includes(entry.stat)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `mul 通道禁用 stat：${entry.stat}`, ctx, [...entryPath, 'stat'], {
          suggestion: `mul 禁区：${FORBIDDEN_MUL_STATS.join(' / ')}`,
        }),
      )
    }
    if (playersOnly) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'select 命中玩家时一律禁止 mul 通道', ctx, entryPath, {
          suggestion: ' 规则 4',
        }),
      )
    }
    // 容差比较：IEEE754 下 1.1 * 100 === 110.00000000000001，直接比不等会误报合法的一位 / 两位小数
    if (Math.abs(entry.factor * 100 - Math.round(entry.factor * 100)) > 1e-9) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `factor 超过两位小数：${entry.factor}`, ctx, [...entryPath, 'factor'], {
          severity: 'warn',
          suggestion: '：factor 保留两位小数',
        }),
      )
    }
  }
}

/**
 * 附魔目录的语义校验（卡面 `enchantments`）。
 *
 * 四条口径：
 * 1. `id` **卡内唯一**（`do: enchant` 按它定位，重复会让"换附魔"指向不明）；
 * 2. 三块效果**至少一块**（结构层已用 refine 拦，这里补一条带字段路径的 error，便于定位到第几件）；
 * 3. 附魔自带的 `stats` 按**开放表**处理（未登记键只 `warn`，复用 `checkStats`，不要求 `atk`）；
 * 4. `actions` / `aura` 里的 `{ ref: self.<stat> }` **允许引用本件附魔自带的 stats 键**
 *    —— 例：绿宝石写 `stats: { heal: 0 }` + `amount: self.atk + self.heal`，
 *    其中 `heal` 只在本件附魔里存在 ⇒ 校验用的集合 = **卡面 stats ∪ 本件 stats**。
 */
function checkEnchantments(
  enchantments: readonly EnchantDefDto[],
  ctx: ValidationContext,
  issues: ValidationError[],
  cardStats: ReadonlySet<string>,
): void {
  const seen = new Set<string>()
  for (const [index, enchant] of enchantments.entries()) {
    const path: (string | number)[] = ['enchantments', index]
    if (seen.has(enchant.id)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `附魔 id 卡内重复：${enchant.id}`, ctx, [...path, 'id'], {
          suggestion: '：enchantments[].id 必填且卡内唯一（`do: enchant` 按它定位）',
        }),
      )
    }
    seen.add(enchant.id)

    // 显示名：**必填**（缺了只 warn、不拦注册 —— 悬停会回落显示英文 id，属"能跑但观感差"）
    if (enchant.name === undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `附魔「${enchant.id}」没写 name（显示名）`, ctx, [...path, 'name'], {
          severity: 'warn',
          suggestion: '：写一个中文显示名（悬浮窗"卡名上方"会用它；缺省回落英文 id）',
        }),
      )
    }

    const merged = new Set<string>(cardStats)
    for (const key of Object.keys(enchant.stats ?? {})) merged.add(key)

    if (enchant.aura === undefined && enchant.stats === undefined && enchant.actions === undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `附魔「${enchant.id}」三块效果全空`, ctx, path, {
          suggestion: '：aura / stats / actions 至少写一块，否则这件附魔没有任何作用',
        }),
      )
    }
    if (enchant.stats !== undefined) {
      checkStats(enchant.stats, ctx, [...path, 'stats'], issues, { requireAtk: false })
    }
    if (enchant.aura !== undefined) checkAura(enchant.aura, ctx, [...path, 'aura'], issues, merged)
    for (const [actionIndex, action] of (enchant.actions ?? []).entries()) {
      checkAction(action, ctx, [...path, 'actions', actionIndex], issues, merged)
    }
  }
}

function checkStats(
  stats: Readonly<Record<string, number>>,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  options: { readonly requireAtk: boolean },
): void {
  for (const key of Object.keys(stats)) {
    if (CARD_STAT_SET.has(key)) continue
    // 宽松处理：引擎按名读取属性，未登记的键不生效 ⇒ 只提示，不拦注册（防拼错属性名）
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `未知属性键：${key}`, ctx, [...path, key], {
        severity: 'warn',
        suggestion: `属性键取：${STAT_KEYS.join(' / ')}`,
      }),
    )
  }
  if (options.requireAtk && stats.atk === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'stats.atk 必填', ctx, [...path, 'atk'], {
        suggestion: '：atk 是卡牌唯一必填属性（不内置普攻）',
      }),
    )
  }
  const atk = stats.atk
  if (atk !== undefined && atk < 0) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `stats.atk 不能为负：${atk}`, ctx, [...path, 'atk'], {
        suggestion: '：atk ≥ 0',
      }),
    )
  }
  const speed = stats.speed
  if (speed !== undefined && !(speed > 0)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `stats.speed 必须 > 0（当前 ${speed}）`, ctx, [...path, 'speed'], {
        suggestion: '：speed 缺省 1',
      }),
    )
  }
  const cdp = stats.cdp
  if (cdp !== undefined && !(cdp > 0)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `stats.cdp 必须 > 0（当前 ${cdp}）`, ctx, [...path, 'cdp'], {
        suggestion: '：cdp 缺省 100（百分比系数）',
      }),
    )
  }
}

function checkTrigger(
  trigger: { readonly event: string },
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
): void {
  if (!KNOWN_EVENT_SET.has(trigger.event)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `引擎当前未广播时机：${trigger.event}`, ctx, [...path, 'event'], {
        severity: 'warn',
        suggestion: `已落地的时机：${KNOWN_EVENTS.join(' / ')}；其余时机该被动不会触发`,
      }),
    )
  }
}

function checkAbility(
  ability: AbilityDto,
  ctx: ValidationContext,
  path: readonly (string | number)[],
  issues: ValidationError[],
  definedStats?: ReadonlySet<string>,
): void {
  if (ability.kind === 'passive') {
    if (ability.trigger === undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'passive 能力必须写 trigger', ctx, path, {
          suggestion: '：被动必须有触发时机',
        }),
      )
    } else {
      checkTrigger(ability.trigger, ctx, [...path, 'trigger'], issues)
    }
    if (ability.everyN !== undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'everyN 仅 active 能力可用', ctx, [...path, 'everyN'], {
          severity: 'warn',
        }),
      )
    }
  } else {
    if (ability.trigger !== undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'active 能力不得写 trigger', ctx, [...path, 'trigger'], {
          suggestion: '：主动效果不得写 trigger（用 everyN 控制第 N 次行动）',
        }),
      )
    }
    if (ability.priority !== undefined) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, 'priority 仅 passive 能力可用', ctx, [...path, 'priority'], {
          severity: 'warn',
        }),
      )
    }
  }
  if (ability.condition !== undefined) {
    checkCondition(ability.condition, ctx, [...path, 'condition'], issues, definedStats, abilityParamNames(ability))
  }
  for (const [index, action] of ability.actions.entries()) {
    checkAction(action, ctx, [...path, 'actions', index], issues, definedStats, abilityParamNames(ability))
  }
}

/* ------------------------------------------------------------------ *
 * 各文件类型的语义校验入口
 * ------------------------------------------------------------------ */

export interface CardValidationOptions {
  /** 卡牌文件名（不含 `.yml`）；给出时校验 `id` 是否等于文件名。 */
  readonly fileName?: string
  /** 所属卡包 id，仅用于错误文案。 */
  readonly packId?: string
  /**
   * 该卡包**已登记的品阶 id**（本包 `rarities.yml` 的 `rarities[].id`；用内置表时 = 内置四档）；
   * 给出时校验"本卡 `rarity` 是否已注册"。
   *
   * ⚠️ ：**这一项与 `rarityChain` 是两件事，不可混用**
   * **已登记但不在合成链上**的自定义品阶**可以**被卡牌引用；
   * 而 `inheritOverride` 的分段仍必须沿**链**递增（见 `rarityChain`）。
   */
  readonly registeredRarities?: Iterable<string>
  /**
   * 该卡包可用的品阶**合成链**（从最低品阶到最高品阶，见 `BUILTIN_UPGRADE_CHAIN`）；给出时校验
   * `inheritOverride` 的分段是否沿链齐全。
   *
   * **不要再拿它当"品阶是否已注册"的判据**。
   */
  readonly rarityChain?: Iterable<string>
  /**
   * 所属卡包 `pack.yml` 声明的默认归属；给出时校验"卡牌自写 owner 与包不一致"并报一条 `note`
   * 。
   * 写成 `| undefined` 是因为调用方持有的是 `string | undefined`（`exactOptionalPropertyTypes`）。
   */
  readonly packOwner?: string | undefined
}

/** 卡牌文件的语义校验（结构校验请先跑 `cardDtoSchema`）。 */
export function validateCard(
  dto: CardDto,
  ctx: ValidationContext,
  options: CardValidationOptions = {},
): readonly ValidationError[] {
  const issues: ValidationError[] = []

  if (options.fileName !== undefined && dto.id !== options.fileName) {
    issues.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `卡牌 id「${dto.id}」与文件名「${options.fileName}」不一致`,
        ctx,
        ['id'],
        { suggestion: '：cards/ 下文件内 id 必须等于文件名' },
      ),
    )
  }

  checkStats(dto.stats, ctx, ['stats'], issues, { requireAtk: true })
  // self.<stat> / this.<stat> 引用的字段必须是本卡 stats 里声明过的键
  const definedStats = new Set<string>(Object.keys(dto.stats))

  // 品阶链（从最低到最高）；**只用于 `inheritOverride` 的分段校验**（见下方）
  const rarityChain = options.rarityChain === undefined ? undefined : [...options.rarityChain]
  // 已登记品阶（含自定义品阶）；**"是否已注册"只认它** —— 与链解耦
  const registeredRarities =
    options.registeredRarities === undefined ? undefined : new Set(options.registeredRarities)

  if (registeredRarities !== undefined && !registeredRarities.has(dto.rarity)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `未注册的品阶：${dto.rarity}`, ctx, ['rarity'], {
        suggestion: `引擎内置品阶：${BUILTIN_RARITY_IDS.join(' / ')}；自定义品阶请在包内 rarities.yml 登记`,
      }),
    )
  }

  // 归属：卡牌自写者优先；与所属包默认归属不一致时只提示一条 note，不改写
  if (dto.owner !== undefined && options.packOwner !== undefined && dto.owner !== options.packOwner) {
    issues.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `卡牌 owner「${dto.owner}」与所属包 pack.yml 的 owner「${options.packOwner}」不一致，以卡牌声明为准`,
        ctx,
        ['owner'],
        {
          severity: 'note',
          suggestion: '：卡牌自写 owner 优先；如需统一请改 pack.yml 或卡牌',
        },
      ),
    )
  }

  const abilities = dto.abilities ?? []
  const seenAbilityIds = new Set<number>()
  for (const [index, ability] of abilities.entries()) {
    if (seenAbilityIds.has(ability.id)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `ability id 卡内重复：${ability.id}`, ctx, ['abilities', index, 'id'], {
          suggestion: '：abilities[].id 必填且卡内唯一',
        }),
      )
    }
    seenAbilityIds.add(ability.id)
    checkAbility(ability, ctx, ['abilities', index], issues, definedStats)
  }

  const hasActiveAbility = abilities.some((ability) => ability.kind === 'active')
  if (dto.cooldown === -1 && hasActiveAbility) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, 'cooldown = -1（纯被动物品）却定义了 active 能力', ctx, ['cooldown'], {
        severity: 'warn',
        suggestion: '纯被动物品的主动能力不会进入行动条',
      }),
    )
  }
  if (dto.cooldown !== -1 && !hasActiveAbility) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, '未定义 active 能力，但 cooldown 不是 -1', ctx, ['cooldown'], {
        severity: 'warn',
        suggestion: '没有主动能力的卡牌建议写 cooldown: -1',
      }),
    )
  }

  if (dto.aura !== undefined) checkAura(dto.aura, ctx, ['aura'], issues, definedStats)

  checkEnchantments(dto.enchantments ?? [], ctx, issues, definedStats)

  // `do: enchant` 的 id 是否在**本卡目录**里 —— 只 `warn`：目标可能是别的卡（那种情况下本卡看不到对方的目录），
  // 运行期"目录里没有 ⇒ 静默跳过"，故这里只提示不拦。
  const enchantIds = new Set((dto.enchantments ?? []).map((enchant) => enchant.id))
  for (const [abilityIndex, ability] of abilities.entries()) {
    for (const [actionIndex, action] of ability.actions.entries()) {
      if (action.do !== 'enchant' || action.enchant === undefined) continue
      if (enchantIds.has(action.enchant)) continue
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `enchant 参数「${action.enchant}」不在本卡 enchantments 目录里`,
          ctx,
          ['abilities', abilityIndex, 'actions', actionIndex, 'enchant'],
          {
            severity: 'warn',
            suggestion: '：本卡自施加时请先在本卡目录登记；若目标是别的卡（对方目录里才有）可忽略',
          },
        ),
      )
    }
  }

  const overrides = dto.inheritOverride ?? []
  const seenOverrideRarities = new Set<string>()
  for (const [index, override] of overrides.entries()) {
    if (seenOverrideRarities.has(override.rarity)) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `inheritOverride 的品阶段重复：${override.rarity}`,
          ctx,
          ['inheritOverride', index, 'rarity'],
          { suggestion: '：每一阶一段、沿合成链严格递增' },
        ),
      )
    }
    seenOverrideRarities.add(override.rarity)
  }

  // 分段口径（ 收紧， ``）：
  //  - **漏写的阶** ⇒ 该阶取本卡最低品阶（`rarity`）的写法，只报 `warn`
  //  - 本卡已是链上最高品阶却仍给了段 ⇒ 这些段都是"多写"，只报 `warn`（合成时被忽略）
  //  - **写了本卡品阶之前的段 / 链外品阶** ⇒ `error`（层次写反了，不是"冗余"）←  由 warn 升为 error
  //  - **重复同一阶** ⇒ `error`（见上面的重复检查）
  if (rarityChain !== undefined && overrides.length > 0) {
    const from = rarityChain.indexOf(dto.rarity)
    if (from >= 0) {
      const expected = rarityChain.slice(from + 1)
      const actual = overrides.map((override) => override.rarity)
      const missing = expected.filter((tier) => !actual.includes(tier))
      const extra = actual.filter((tier) => !expected.includes(tier))
      // 本卡已是链上最高阶（`expected` 为空）却仍给了段 ⇒ 全部是"多写"，只提示
      if (expected.length === 0 && actual.length > 0) {
        issues.push(
          problem(
            LOAD_ERROR_CODES.schemaInvalid,
            `inheritOverride 写了 ${actual.length} 个品阶段，但本卡品阶「${dto.rarity}」已是链上最高阶，无需分段`,
            ctx,
            ['inheritOverride'],
            {
              severity: 'warn',
              suggestion: `：最高品阶没有可继承的下一阶；这些段在合成时被忽略（冗余、无害）`,
            },
          ),
        )
      } else if (missing.length > 0) {
        issues.push(
          problem(
            LOAD_ERROR_CODES.schemaInvalid,
            `inheritOverride 漏写 ${missing.length} 个品阶段：${missing.join(' / ')}`,
            ctx,
            ['inheritOverride'],
            {
              severity: 'warn',
              suggestion: `：**漏写的阶取最低品阶「${dto.rarity}」的写法**（该阶与最低阶一致）；只提示、不拒绝`,
            },
          ),
        )
      }
      if (extra.length > 0 && expected.length > 0) {
        const beforeOwn = extra.filter((tier) => {
          const index = rarityChain.indexOf(tier)
          return index >= 0 && index <= from
        })
        const offChain = extra.filter((tier) => !rarityChain.includes(tier))
        const detail = [
          beforeOwn.length > 0 ? `写在本卡品阶「${dto.rarity}」之前：${beforeOwn.join(' / ')}` : '',
          offChain.length > 0 ? `不在合成链上：${offChain.join(' / ')}` : '',
        ]
          .filter((text) => text !== '')
          .join('；')
        issues.push(
          problem(
            LOAD_ERROR_CODES.schemaInvalid,
            `inheritOverride 多写了 ${extra.length} 个品阶段（${detail}）`,
            ctx,
            ['inheritOverride'],
            {
              suggestion: `：分段只能从「${dto.rarity}」的下一阶起、沿合成链递增 —— 写了本卡品阶之前或链外的段属**层次写反**，直接拒绝`,
            },
          ),
        )
      }
    }
  }

  for (const [index, override] of overrides.entries()) {
    const overridePath = ['inheritOverride', index]
    for (const [abilityIndex, ability] of (override.abilities ?? []).entries()) {
      if (!seenAbilityIds.has(ability.id)) {
        issues.push(
          problem(
            LOAD_ERROR_CODES.schemaInvalid,
            `inheritOverride 引用了不存在的 ability id：${ability.id}`,
            ctx,
            [...overridePath, 'abilities', abilityIndex, 'id'],
            { suggestion: '：override 的 abilities[].id 必须引用本卡已存在的能力' },
          ),
        )
      }
      if (ability.condition !== undefined) {
        checkCondition(
          ability.condition,
          ctx,
          [...overridePath, 'abilities', abilityIndex, 'condition'],
          issues,
          definedStats,
        )
      }
      for (const [actionIndex, action] of ability.actions.entries()) {
        checkAction(
          action,
          ctx,
          [...overridePath, 'abilities', abilityIndex, 'actions', actionIndex],
          issues,
          definedStats,
        )
      }
    }
  }

  return issues
}

export interface SkillValidationOptions {
  /** 已注册英雄 id（传集合或数组都行）；给出时校验 `heroes`（`common` / `sp` 保留字除外）。 */
  readonly knownHeroIds?: Iterable<string>
  /** 技能文件名（不含 `.yml`）；给出时校验 `id` 是否等于文件名。 */
  readonly fileName?: string
  /**
   * 该卡包**已登记的品阶 id**（本包 `rarities.yml` 的 `rarities[].id`；用内置表时 = 内置四档）；
   * 给出时校验"技能 `rarity` 是否已注册"（与卡牌同口径，见 `CardValidationOptions.registeredRarities`）。
   *
   * ⚠️ **技能的品阶与合成链无关**：合成只作用于卡牌（§V.2 = A），故这里**没有** `rarityChain`。
   */
  readonly registeredRarities?: Iterable<string>
}

/** 技能文件的语义校验。 */
export function validateSkill(
  dto: SkillDto,
  ctx: ValidationContext,
  options: SkillValidationOptions = {},
): readonly ValidationError[] {
  const issues: ValidationError[] = []

  if (options.fileName !== undefined && dto.id !== options.fileName) {
    issues.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `技能 id「${dto.id}」与文件名「${options.fileName}」不一致`,
        ctx,
        ['id'],
        { suggestion: '：skills/ 下文件内 id 必须等于文件名' },
      ),
    )
  }

  if (dto.stats !== undefined) checkStats(dto.stats, ctx, ['stats'], issues, { requireAtk: false })
  // （：self.<stat> 引用的字段必须在本技能 stats 中声明）
  const definedStats = new Set<string>(Object.keys(dto.stats ?? {}))

  // 品阶（**必填**）：必须是**已登记**的品阶 —— 与卡牌同口径（"已登记" ≠ "在合成链上"；
  // 技能**不参与**合成，故这里没有 `rarityChain`）
  if (options.registeredRarities !== undefined) {
    const registered = new Set(options.registeredRarities)
    if (!registered.has(dto.rarity)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `未注册的品阶：${dto.rarity}`, ctx, ['rarity'], {
          suggestion: `引擎内置品阶：${BUILTIN_RARITY_IDS.join(' / ')}；自定义品阶请在包内 rarities.yml 登记`,
        }),
      )
    }
  }

  const actions = dto.actions ?? []
  if (actions.length === 0 && dto.aura === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, '既无 actions 又无 aura', ctx, [], {
        suggestion: '：纯光环技能可省略 actions，但两者不能同时为空',
      }),
    )
  }
  if (dto.trigger === undefined && dto.aura === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, '既未写 trigger 也未写 aura', ctx, [], {
        severity: 'note',
        suggestion: '该技能不进触发栈、整局不结算',
      }),
    )
  }
  if (dto.trigger !== undefined) checkTrigger(dto.trigger, ctx, ['trigger'], issues)
  if (dto.condition !== undefined) {
    checkCondition(dto.condition, ctx, ['condition'], issues, definedStats, eventParamNames(dto.trigger?.event))
  }
  if (dto.aura !== undefined) checkAura(dto.aura, ctx, ['aura'], issues, definedStats)

  for (const [index, action] of actions.entries()) {
    checkAction(action, ctx, ['actions', index], issues, definedStats, eventParamNames(dto.trigger?.event))
  }

  const knownHeroes = options.knownHeroIds
  if (knownHeroes !== undefined) {
    const known = new Set(knownHeroes)
    for (const [index, hero] of dto.heroes.entries()) {
      if (hero === 'common' || hero === 'sp') continue
      if (!known.has(hero)) {
        issues.push(
          problem(LOAD_ERROR_CODES.schemaInvalid, `heroes 引用了未注册的英雄 id：${hero}`, ctx, ['heroes', index], {
            severity: 'warn',
            suggestion: '英雄可能来自未加载的卡包；common / sp 是保留字',
          }),
        )
      }
    }
  }

  return issues
}

/** 角色文件的语义校验。 */
export function validateHero(dto: HeroDto, ctx: ValidationContext): readonly ValidationError[] {
  const issues: ValidationError[] = []
  if (!(dto.initHp > 0)) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `initHp 必须 > 0（当前 ${dto.initHp}）`, ctx, ['initHp'], {
        suggestion: '',
      }),
    )
  }
  const maxHp = dto.initMaxHp
  if (maxHp !== undefined && maxHp < dto.initHp) {
    issues.push(
      problem(LOAD_ERROR_CODES.schemaInvalid, `initMaxHp（${maxHp}）小于 initHp（${dto.initHp}）`, ctx, ['initMaxHp'], {
        severity: 'warn',
        suggestion: 'initMaxHp 缺省 = initHp',
      }),
    )
  }
  let previous = 0
  for (const [index, value] of (dto.levelupMaxHp ?? []).entries()) {
    if (value < previous) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `levelupMaxHp 应单调不减（第 ${index} 项 ${value} < 前一项 ${previous}）`, ctx, [
          'levelupMaxHp',
          index,
        ], { severity: 'warn' }),
      )
    }
    previous = value
  }
  return issues
}

/** 品阶文件（`rarities.yml`）的语义校验。 */
export function validateRaritiesFile(
  dto: RaritiesFileDto,
  ctx: ValidationContext,
): readonly ValidationError[] {
  const issues: ValidationError[] = []
  const ids = new Set<string>()
  for (const [index, rarity] of dto.rarities.entries()) {
    if (ids.has(rarity.id)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `品阶 id 重复：${rarity.id}`, ctx, ['rarities', index, 'id']),
      )
    }
    ids.add(rarity.id)
  }
  for (const [index, id] of (dto.upgrade ?? []).entries()) {
    if (!ids.has(id)) {
      issues.push(
        problem(LOAD_ERROR_CODES.schemaInvalid, `upgrade 引用了未定义的品阶 id：${id}`, ctx, ['upgrade', index], {
          suggestion: '：upgrade 元素须是已定义的品阶 id',
        }),
      )
      continue
    }
    // （ ``）：**合成链暂时只允许内置四档**。
    // 自定义品阶仍可在本文件登记（供卡牌 `rarity` 引用），但**不得进入 `upgrade` 链**
    // 合成机制落地前先把链路维持稳定；将来放开时删掉这条判据即可。
    // 注：`BUILTIN_RARITY_IDS` 是 `as const` 元组，`.includes(string)` 会因参数窄化而报 TS2345，
    //     故用 `some()` 显式比较（运行时等价、类型安全）。
    if (!BUILTIN_RARITY_IDS.some((builtin) => builtin === id)) {
      issues.push(
        problem(
          LOAD_ERROR_CODES.schemaInvalid,
          `upgrade 链上不允许自定义品阶：${id}`,
          ctx,
          ['upgrade', index],
          { suggestion: `：合成链暂时只允许内置四档 ${BUILTIN_RARITY_IDS.join(' / ')}；自定义品阶可登记但不得进链` },
        ),
      )
    }
  }
  return issues
}

/** `pack.yml` 语义校验的可选项。 */
export interface PackValidationOptions {
  /**
   * 引擎版本（三段 `major.minor.patch`）；缺省 = [engine/version.ts](../engine/version.ts) 的 `ENGINE_VERSION`。
   * 给出时按 `engineRange` 区间判定"本包是否接受当前引擎"，不满足 ⇒ `error`。
   */
  readonly engineVersion?: string
}

/** `major.minor.patch` 三段版本串（`0.10.0` 这类；两段的 `0.10` 不合法 —— 见 ``）。 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

/** 把版本串拆成可比的三元组；格式不合法返回 `undefined`。 */
function versionParts(version: string): readonly [number, number, number] | undefined {
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return undefined
  const major = match[1]
  const minor = match[2]
  const patch = match[3]
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return [Number(major), Number(minor), Number(patch)]
}

/** 逐段比较两个三段版本：左小 ⇒ 负数，相等 ⇒ 0，左大 ⇒ 正数。 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  if (a === undefined || b === undefined) return Number.NaN
  for (let index = 0; index < 3; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 引擎版本是否落在 `engineRange` 的**任一**区间内（ ``：缺省左闭右开）。
 * 版本串写坏时不在这里判（格式错由 `validatePackManifest` 单独报 `error`），一律返回 `true` 避免双报。
 */
export function engineRangeSatisfied(ranges: readonly EngineRangeDto[], version: string): boolean {
  if (versionParts(version) === undefined) return true
  for (const range of ranges) {
    // 边界串写坏（如两段的 `0.10`）时不在这里判"是否命中"—— 交给 validatePackManifest 的格式校验报错，避免双报
    const fromBad = range.from !== undefined && versionParts(range.from) === undefined
    const toBad = range.to !== undefined && versionParts(range.to) === undefined
    if (fromBad || toBad) continue
    if (range.from !== undefined) {
      const lower = compareVersions(version, range.from)
      if (lower < 0 || (lower === 0 && range.fromInclusive === false)) continue
    }
    if (range.to !== undefined) {
      const upper = compareVersions(version, range.to)
      if (upper > 0 || (upper === 0 && range.toInclusive !== true)) continue
    }
    return true
  }
  return false
}

/** 区间自身是否合法（`from` / `to` 格式、非空、`from ≤ to`）。 */
function checkEngineRangeItem(
  range: EngineRangeDto,
  index: number,
  ctx: ValidationContext,
  issues: ValidationError[],
): void {
  const path: readonly (string | number)[] = ['engineRange', index]
  const fromParts = range.from === undefined ? undefined : versionParts(range.from)
  const toParts = range.to === undefined ? undefined : versionParts(range.to)

  if (range.from !== undefined && fromParts === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `engineRange 的 from 必须是三段版本 major.minor.patch（当前 ${range.from}）`, ctx, [...path, 'from'], {
        suggestion: "写全三段并加引号，例如 from: '0.10.0'",
      }),
    )
  }
  if (range.to !== undefined && toParts === undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `engineRange 的 to 必须是三段版本 major.minor.patch（当前 ${range.to}）`, ctx, [...path, 'to'], {
        suggestion: "写全三段并加引号，例如 to: '1.0.0'",
      }),
    )
  }
  if (fromParts === undefined || toParts === undefined) return

  const order = compareVersions(range.from ?? '0.0.0', range.to ?? '0.0.0')
  if (order > 0) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `engineRange 的 from 不能大于 to（${String(range.from)} > ${String(range.to)}）`, ctx, path, {
        suggestion: '区间要写成"下界 ≤ 上界"；省略某一侧 = 该侧无界',
      }),
    )
    return
  }
  // 缺省左闭右开：from == to 时只有两端都含（fromInclusive ≠ false 且 toInclusive === true）才是非空区间
  const lowerClosed = range.fromInclusive !== false
  const upperClosed = range.toInclusive === true
  if (order === 0 && !(lowerClosed && upperClosed)) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `engineRange 的区间为空（from 与 to 都是 ${String(range.from)}，缺省左闭右开）`, ctx, path, {
        suggestion: '要么把上界写大一点，要么两端都含（toInclusive: true）；只判一个版本请用 { from: X, toInclusive: true }',
      }),
    )
  }
}

/** `pack.yml` 的语义校验（卡包 / 技能包共用一份 schema）。 */
export function validatePackManifest(
  dto: PackManifestDto,
  ctx: ValidationContext,
  options: PackValidationOptions = {},
): readonly ValidationError[] {
  const issues: ValidationError[] = []
  const cards = dto.cards ?? []
  const skills = dto.skills ?? []

  for (const [index, name] of cards.entries()) checkManifestEntry('cards', name, index, ctx, issues)
  for (const [index, name] of skills.entries()) checkManifestEntry('skills', name, index, ctx, issues)

  // （ ``）：**纯规则包**（只有品阶与价值表、没有卡牌 / 技能）合法
  // 判据 = 显式声明 `rarities: { source: file }`。`packs/base` 就是这种包。
  const isRarityOnlyPack = dto.rarities?.source === 'file'
  if (cards.length === 0 && skills.length === 0 && !isRarityOnlyPack) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, 'pack.yml 必须至少声明 cards 或 skills 之一的清单', ctx, [], {
        suggestion: '：卡包写 cards；技能写 skills**两者可写在同一个 pack.yml 里**；'
          + '**纯规则包**（只放品阶与价值表，如 packs/base）请显式写 `rarities: { source: file }`',
      }),
    )
  }
  // 技能**并入卡包自己的 pack.yml**，"卡包里的 skills 段作废"这条 note 随之取消。
  if (cards.length === 0 && skills.length > 0 && dto.owner !== undefined) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, '技能包不写 owner（归属由技能自身的 heroes 声明）', ctx, ['owner'], {
        severity: 'warn',
        suggestion: '：技能包不声明归属',
      }),
    )
  }

  // engineRange：先逐项验区间本身，再整体判"当前引擎是否在范围内"
  const rangeIssuesBefore = issues.length
  for (const [index, range] of dto.engineRange.entries()) checkEngineRangeItem(range, index, ctx, issues)
  const rangesWellFormed = issues.length === rangeIssuesBefore

  const engineVersion = options.engineVersion ?? ENGINE_VERSION
  if (rangesWellFormed && !engineRangeSatisfied(dto.engineRange, engineVersion)) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `本包声明的 engineRange 不含当前引擎版本（引擎 ${engineVersion}）`, ctx, ['engineRange'], {
        suggestion: "：低版本拒绝导入 —— 改 engineRange（如 { from: '0.0.0' }）或升级引擎",
      }),
    )
  }

  if (dto.owner !== undefined && dto.owner !== 'common' && !ID_PATTERN.test(dto.owner)) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `owner 取值须是 hero_id 或 common（当前 ${dto.owner}）`, ctx, ['owner'], {
        severity: 'warn',
      }),
    )
  }

  return issues
}

function checkManifestEntry(
  field: 'cards' | 'skills',
  name: string,
  index: number,
  ctx: ValidationContext,
  issues: ValidationError[],
): void {
  if (name.endsWith('.yml') || name.endsWith('.yaml') || name.includes('/')) {
    issues.push(
      problem(
        LOAD_ERROR_CODES.packManifest,
        `${field} 清单只写裸文件名（不带 .yml）：${name}`,
        ctx,
        [field, index],
        { suggestion: `改写成 ${name.replace(/\.ya?ml$/, '').replace(/^.*\//, '')}` },
      ),
    )
    return
  }
  if (!ID_PATTERN.test(name)) {
    issues.push(
      problem(LOAD_ERROR_CODES.packManifest, `${field} 清单元素须是文件名（id）：${name}`, ctx, [field, index], {
        suggestion: '文件名即注册 id，须与文件内 id 一致；首字符字母，其余字母 / 数字 / 下划线（可驼峰）',
      }),
    )
  }
}
