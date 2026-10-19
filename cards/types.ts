/**
 * cards/ 的领域类型：YAML 读取层对外产出的形状（纯数据、可 JSON 序列化）。
 *
 * 契约关系（务必分清）：
 * - **卡牌 / 技能的战斗期契约**（`Card` / `Skill`）唯一定义在 `engine/types.ts`，本文件只
 *   用别名 `CardDef` / `SkillDef` 承接里的叫法，**不重复定义字段**；
 * - 本文件定义的是**读取层自己的**产物类型：`ValidationError` / `LoadResult` /
 *   `LoadedPack` / `HeroDef` / `RarityDef` —— 它们只属于宿主与加载流程，不进引擎。
 *
 * 字段命名为**驼峰**（映射层 `cards/map.ts` 的产出）；YAML 侧一律蛇形
 * （`cards/schema.ts` 的 zod DTO），两侧由 `map.ts` 逐字段显式映射。
 */
import type { Card, Skill, LogLevel } from '../engine/types.ts'

export type { Card as CardDef, Skill as SkillDef }

/**
 * 一条校验 / 加载问题。字段与 逐条对应。
 *
 * - `code`：机器可判的分类型号，见下文 `LOAD_ERROR_CODES` 与  表格；
 * - `path`：出错字段路径（蛇形键，例 `abilities[0].actions[1].amount`）；
 * - `file`：仓库相对路径（POSIX 分隔符），行号 / 列号 1 起算；
 * - `severity`：缺省 `error`（`warn` / `note` 不阻断加载）。
 */
export interface ValidationError {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly file?: string
  readonly line?: number
  readonly column?: number
  readonly suggestion?: string
  readonly side?: 'A' | 'B'
  readonly severity?: LogLevel
}

/** 四类阻断性错误 + 三类提示。 */
export const LOAD_ERROR_CODES = {
  /** YAML 语法错：该文件不注册。 */
  yamlSyntax: 'yaml.syntax',
  /** schema 校验错（zod）：该文件不注册。 */
  schemaInvalid: 'schema.invalid',
  /** 包清单问题（pack.yml 缺失/坏、清单点名文件不存在、卡内 id ≠ 文件名）：整包不注册。 */
  packManifest: 'pack.manifest',
  /** 同 pack_id 冲突：保留先到者（目录名字典序），后来者整包丢弃。 */
  packDuplicateId: 'pack.duplicate_id',

  // ——— 细分码（批 67-B 起）：命名 = `<域>.<对象>.<问题>`，全小写 + 下划线 ———
  // 约定：**码只增不改**（一旦发布就是契约）；新增一类问题时再拆细分码，
  // 未拆分的仍用上面的粗码 `schemaInvalid`（剩余清单见 `docs/待办.md`）。

  /** 阵容：`hero` 引用了未注册的角色 id。 */
  deckHeroUnknown: 'deck.hero.unknown',
  /** 阵容：`maxHp` 小于 `hp`（warn）。 */
  deckHpMaxLessThanHp: 'deck.hp.max_less_than_hp',
  /** 阵容：`cards[].id` 引用了未注册的卡牌 id。 */
  deckCardUnknown: 'deck.card.unknown',
  /** 阵容：`cards[].enchant` 不在这张卡的 `enchantments` 目录里。 */
  deckEnchantUnknown: 'deck.enchant.unknown',
  /** 阵容：`cards[].stats` 写了禁止覆盖的键（`speed` / `cdp`）。 */
  deckStatsForbiddenKey: 'deck.stats.forbidden_key',
  /** 阵容：`skills[]` 引用了未注册的技能 id。 */
  deckSkillUnknown: 'deck.skill.unknown',

  /** 卡牌：动作没写 `target`。 */
  cardActionNoTarget: 'card.action.no_target',
  /** 卡牌：`stats.atk` 为负。 */
  cardStatsAtkNegative: 'card.stats.atk_negative',
  /** 卡牌 / 技能：`rarity` 引用了未登记的品阶。 */
  cardRarityUnknown: 'card.rarity.unknown',
  /** 卡牌 / 技能：光环的 `apply` 与 `mul` 都为空。 */
  cardAuraEmpty: 'card.aura.empty',
  /** 卡牌：`kind: passive` 的能力没写 `trigger`。 */
  cardAbilityPassiveNoTrigger: 'card.ability.passive_no_trigger',
  /** 卡牌：`kind: active` 的能力写了 `trigger`。 */
  cardAbilityActiveHasTrigger: 'card.ability.active_has_trigger',
  /** 卡牌 / 技能：写了一个**引擎还没广播**的时机词（契约已定、实现未接）。 */
  cardAbilityEventNotBroadcast: 'card.ability.event_not_broadcast',
  /** 卡牌：同一张卡里附魔 id 重复。 */
  cardEnchantDuplicate: 'card.enchant.duplicate',
  /** 内容包：`owner` 取值既不是 hero_id 也不是 `common` / `sp`。 */
  packOwnerInvalid: 'pack.owner.invalid',

  // ——— 引用 / 选择器（批 67-C）———
  /** 选择器：写了词典里没有的选择器名。 */
  cardSelectorUnknown: 'card.selector.unknown',
  /** 选择器：语法合法但写法不成立（未知字段 / 互斥组合等）。 */
  cardSelectorInvalid: 'card.selector.invalid',
  /** 引用：`self.` / `this.` 后面没写属性名。 */
  cardRefMissingField: 'card.ref.missing_field',
  /** 引用：属性不在封闭词表里。 */
  cardRefUnknownStat: 'card.ref.unknown_stat',
  /** 引用：属性合法但本卡 `stats` 没声明过。 */
  cardRefUndefinedStat: 'card.ref.undefined_stat',
  /** 引用：`{ var: <参数名> }` 里的参数名在该时机下不存在。 */
  cardEventParamUnknown: 'card.event_param.unknown',
  /** 引用：对非引用型事件参数做点号取属性。 */
  cardEventParamNotReference: 'card.event_param.not_reference',
  /** 引用：事件参数取属性的字段名不合法。 */
  cardEventParamBadField: 'card.event_param.bad_field',

  // ——— 动作参数（批 67-C）———
  /** `do: enchant` 没写 `enchant` 参数。 */
  cardActionEnchantMissingId: 'card.action.enchant_missing_id',
  /** `do: enchant` 的附魔 id 形状不合法。 */
  cardActionEnchantIdInvalid: 'card.action.enchant_id_invalid',
  /** 非 `do: enchant` 的动作写了 `enchant` 参数。 */
  cardActionEnchantUnexpectedParam: 'card.action.enchant_unexpected_param',
  /** `gain_stat` 没写 `stat`。 */
  cardActionGainStatMissingStat: 'card.action.gain_stat_missing_stat',
  /** `stat` 参数出现在不支持它的动作上。 */
  cardActionStatMisplaced: 'card.action.stat_misplaced',
  /** `apply_status` 没写 `status`。 */
  cardActionApplyStatusMissingStatus: 'card.action.apply_status_missing_status',
  /** `status` 参数出现在不支持它的动作上。 */
  cardActionStatusMisplaced: 'card.action.status_misplaced',
  /** `duration` 只在 `gain_stat` + 玩家 + DOT 通道下允许。 */
  cardActionDurationNotAllowed: 'card.action.duration_not_allowed',
  /** 写了引擎尚未落地的通道参数（`enter` / `exit` 一类）。 */
  cardActionChannelUnimplemented: 'card.action.channel_unimplemented',

  // ——— 动作 / 光环 / 附魔 / 数值 / 能力 / 角色 / 包（批 67-D：把语义错误扫完）———
  /** 动作的目标选择器选中玩家，但该原语只处理卡牌。 */
  cardActionPlayerTargetForbidden: 'card.action.player_target_forbidden',
  /** `gain_stat` 的 `stat` 不在封闭词表。 */
  cardActionUnknownStatKey: 'card.action.unknown_stat_key',
  /** 光环条目（`apply` / `mul`）的 `stat` 不在封闭词表。 */
  cardAuraUnknownStatKey: 'card.aura.unknown_stat_key',
  /** 同一光环通道里同一个 `stat` 写了两次。 */
  cardAuraDuplicateStat: 'card.aura.duplicate_stat',
  /** 光环用了禁止的 `stat`（`speed` / `cdp` / status 等）。 */
  cardAuraForbiddenStat: 'card.aura.forbidden_stat',
  /** 光环 `select` 命中玩家时禁止 `mul` 通道。 */
  cardAuraPlayerMulForbidden: 'card.aura.player_mul_forbidden',
  /** 光环 `mul.factor` 超过两位小数。 */
  cardAuraFactorPrecision: 'card.aura.factor_precision',
  /** 附魔目录项没写 `name`（显示名）。 */
  cardEnchantNameMissing: 'card.enchant.name_missing',
  /** 附魔的三块效果（`stats` / `aura` / `actions`）全空。 */
  cardEnchantEffectsEmpty: 'card.enchant.effects_empty',
  /** `stats` 里写了未登记的词表键（只 `warn`）。 */
  cardStatsUnknownKey: 'card.stats.unknown_key',
  /** `stats.speed` 必须 > 0。 */
  cardStatsSpeedNonPositive: 'card.stats.speed_non_positive',
  /** `stats.cdp` 必须 > 0。 */
  cardStatsCdpNonPositive: 'card.stats.cdp_non_positive',
  /** `everyN` 只能写在 `kind: active` 上。 */
  cardAbilityEveryNNotActive: 'card.ability.every_n_not_active',
  /** `priority` 只能写在 `kind: passive` 上。 */
  cardAbilityPriorityNotPassive: 'card.ability.priority_not_passive',
  /** 同一张卡里 `ability.id` 重复。 */
  cardAbilityDuplicateId: 'card.ability.duplicate_id',
  /** `cooldown: -1`（纯被动）却定义了 active 能力。 */
  cardCooldownPassiveWithActive: 'card.cooldown.passive_with_active',
  /** 没定义 active 能力，但 `cooldown` 不是 -1。 */
  cardCooldownActiveMissing: 'card.cooldown.active_missing',
  /** 技能既没 `actions` 也没 `aura`。 */
  cardSkillNoEffect: 'card.skill.no_effect',
  /** 技能既没写 `trigger` 也没写 `aura`（引擎整局不会结算）。 */
  cardSkillInert: 'card.skill.inert',
  /** 技能的 `heroes` 引用了未注册的英雄 id。 */
  cardSkillHeroUnknown: 'card.skill.hero_unknown',
  /** 角色 `initHp` 必须 > 0。 */
  heroInitHpNonPositive: 'hero.init_hp_non_positive',
  /** 角色 `initMaxHp` 小于 `initHp`。 */
  heroMaxHpLessThanHp: 'hero.max_hp_less_than_hp',
  /** 角色 `levelupMaxHp` 应单调不减。 */
  heroLevelupNotMonotonic: 'hero.levelup_not_monotonic',
  /** 品阶表里 id 重复。 */
  packRarityDuplicate: 'pack.rarity.duplicate',
  /** `upgrade` 链引用了未定义的品阶 id。 */
  packRarityUpgradeUnknown: 'pack.rarity.upgrade_unknown',
} as const

/** 品阶定义（`rarities.yml` 列表项，映射层产出）。 */
export interface RarityDef {
  readonly id: string
  readonly name: string
  /** 十六进制颜色。 */
  readonly color: string
  /** 卡框资源 id，缺省用纯色卡框。 */
  readonly frame?: string
  /**
   * **该品阶的卡牌基础价值**（ 新增，``：价值定义并入品阶文件）。
   * 解析后的**生效值**（已套过内置兜底）；`stats.value` 缺省时按它初始化。
   */
  readonly value: number
  /** **该品阶的当前售价**；不写 ⇒ 等于 `value`。解析后始终有值。 */
  readonly prize: number
}

/** 包内品阶来源：内置基准表，或本包 `rarities.yml`。 */
export type LoadedRarities =
  | { readonly source: 'builtin' }
  | { readonly source: 'file'; readonly items: readonly RarityDef[] }

/**
 * 角色定义（`heroes/<hero_id>/<hero_id>.yml`，映射层产出）。
 *
 * 本轮**只落数据**：`initHp` / `initMaxHp` 不参与战斗初始化
 * （`engine/state.ts` 的 `INITIAL_HP = 300` 不动，英雄血量的接线单独一轮）。
 */
export interface HeroDef {
  readonly id: string
  readonly name: string
  readonly version: number
  /** 初始血量（一场冒险开始时）。 */
  readonly initHp: number
  /** 血量上限，缺省 = `initHp`。 */
  readonly initMaxHp: number
  readonly levelupMaxHp?: readonly number[]
  readonly description?: string
}

/** 一个加载成功的卡包（= `packs.manifest.json` 的元素形状）。 */
export interface LoadedPack {
  readonly packId: string
  /**
   * 卡包**显示名**（`pack.yml` 的 `name`， 新增）。
   *
   * 为什么进契约：它是**表现层**要用的（客户端"来源卡包"筛选、卡包选择界面），
   * 而浏览器侧拿不到 `pack.yml` 原文 —— 经"预生成清单 / dev 中间件"过来的只有本结构。
   */
  readonly name: string
  readonly version: number
  readonly builtin: boolean
  /** 归属三态：`<hero_id>` / `common` / 省略（无归属）。 */
  readonly owner?: string
  readonly rarities?: LoadedRarities
  readonly cards: readonly Card[]
  readonly skills: readonly Skill[]
  readonly heroes: readonly HeroDef[]
  /** 包根目录（仓库相对路径，POSIX 分隔符）。 */
  readonly source: string
}

/**
 * 一次加载的全部结果。读取层**从不抛异常、从不中止**：好文件照常注册、
 * 坏文件只进 `errors`，死活由调用方决定（`sim:validate` 打印全部并 exit 1，
 * `sim:run` 见 `error` 级即中止）—— 。
 */
export interface LoadResult {
  readonly packs: readonly LoadedPack[]
  readonly errors: readonly ValidationError[]
}
