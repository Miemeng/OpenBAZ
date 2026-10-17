/**
 * 纯逻辑・映射层：YAML 的**驼峰 DTO** → 引擎契约（**同名**）＋少量语义规则。
 *
 *  DTO 与引擎契约**字段同名同形**（ `` = B：规范字段一律改驼峰、
 * 消掉名字差），所以本文件**不再做任何改名**，只剩下面 4 条**真正的语义规则**：
 *
 *  1. `cooldown`：YAML 是**秒**（两位小数）→ 引擎 `Card.cooldown` 是 **cs 整数**；
 *     `-1`（纯被动物品）原样保留。`seconds` / `duration` 不在这里换算（引擎内部做，见
 *     `engine/primitives.ts` 的 `secondsToCs`），**原样透传**。
 *  2. `slots` 缺省：由 `size` 推导（`small / medium / large` = 1 / 2 / 3）。
 *  3. `owner` 补齐：卡牌自写优先；没写则用所属包 `pack.yml` 的 `owner`（ ``）。
 *  4. 缺省补空：`Skill.actions` / `Skill.stats` 在契约里必填，DTO 里可选；`HeroDef.initMaxHp`
 *     缺省 = `initHp`。
 *
 * 其余仍是**逐字段显式赋值**——这样"哪些 YAML 字段进了引擎、
 * 哪些被有意丢弃"依然一眼可查，可选字段一律条件赋值（`exactOptionalPropertyTypes`）。
 *
 * 有意丢弃的 YAML 字段（引擎契约里没有，属表现层 / 经济层 / 未落地特性）：
 *  - `inheritOverride`：品质继承合成，模拟模式不体现；
 *  - `enter` / `exit`：持续效果通道参数，引擎尚未落地（
 *    `cards/schema.ts` 已给它一条 `note`）。
 *
 * ⚠️ **已从 YAML 层删除**、不再出现在上面的字段（历史上都属"读了也不映射、静默丢弃"）：
 *  - **卡面 `frame`** ——  删除：卡框**只由品阶决定**
 *    （`RarityDef.frame` / `RarityDef.color` 进契约，素材路径与加载由前端做）；
 *  - **技能 `icon`** ——  删除（ ``）：图标走文件名约定 `images/skills/<id>.png`；
 *  - **卡面 `buyPrize` / `prize`** ——  废除：卡牌价值统一走 **`stats.value`**
 *    （缺省由品阶表的 `value` 初始化，见 `cards/economy.ts`）。
 */

import { secondsToCs } from '../engine/state.ts'
import type {
  Ability,
  ActionSpec,
  AuraDef,
  Card,
  Condition,
  EnchantDef,
  Expr,
  SelectorQuery,
  Skill,
} from '../engine/types.ts'
import type {
  AbilityDto,
  ActionDto,
  AuraDto,
  CardDto,
  ConditionDto,
  EnchantDefDto,
  ExprDto,
  HeroDto,
  RarityDto,
  SelectorDto,
  SkillDto,
} from './schema.ts'
import { DEFAULT_SLOTS } from './schema.ts'
import { resolveRarityEconomy } from './economy.ts'
import type { HeroDef, RarityDef } from './types.ts'

/** 去掉 `readonly` 的浅层映射（用于"逐字段条件赋值"的构造过程）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** 选择器：DTO 与引擎查询对象同名同义，只需递归映射 `filter`。 */
export function mapSelector(dto: SelectorDto): SelectorQuery {
  const query: Mutable<SelectorQuery> = {}
  if (dto.side !== undefined) query.side = dto.side
  if (dto.zone !== undefined) query.zone = dto.zone
  if (dto.from !== undefined) query.from = dto.from
  if (dto.relative !== undefined) query.relative = dto.relative
  if (dto.direction !== undefined) query.direction = dto.direction
  if (dto.tags !== undefined) query.tags = [...dto.tags]
  if (dto.tagMode !== undefined) query.tagMode = dto.tagMode
  if (dto.filter !== undefined) query.filter = mapCondition(dto.filter)
  if (dto.destroyed !== undefined) query.destroyed = dto.destroyed
  if (dto.sort !== undefined) query.sort = dto.sort
  if (dto.random !== undefined) query.random = dto.random
  if (dto.limit !== undefined) query.limit = dto.limit
  return query
}

/**
 * 表达式：字面量原样，容器递归，**裸引用简写补全**。
 *
 * ⚠️ **裸引用简写**： 的书写规则允许把 `{ ref: 'self.atk' }`
 * 简写成裸字符串 `self.atk`，但引擎契约里
 * `Expr` 的字符串成员是**字符串字面量**、只合法于 `eq` / `neq` 比较
 * （`engine/expr.ts` 的 `evaluateExpr`：数值位遇到 string 直接抛错）。
 * 因此映射层必须在这里**把裸引用补成 `{ ref }` 对象** —— 否则"校验通过、一上场就抛"。
 *
 * 补全规则：字符串以 `self.` / `this.` / `event.` 开头 ⇒ 视为引用；其余字符串**原样保留**
 * （它们是真正的字符串字面量，例如 `condition: { cmp: eq, right: 'cinder_wolf' }`）。
 */
export function mapExpr(dto: ExprDto): Expr {
  if (typeof dto === 'number') return dto
  if (typeof dto === 'string') return isBareRef(dto) ? { ref: dto } : dto
  if ('ref' in dto) return { ref: dto.ref }
  if ('var' in dto) return { var: dto.var }
  if ('count' in dto) {
    const count = dto.count
    return { count: typeof count === 'string' ? count : mapSelector(count) }
  }
  if ('add' in dto) return { add: dto.add.map((item) => mapExpr(item)) }
  if ('sub' in dto) return { sub: dto.sub.map((item) => mapExpr(item)) }
  if ('mul' in dto) return { mul: dto.mul.map((item) => mapExpr(item)) }
  return { div: dto.div.map((item) => mapExpr(item)) }
}

/** 裸引用简写的三个前缀（与 `cards/schema.ts` 的 `REF_HEADS` 同口径）。 */
const BARE_REF_PREFIXES: readonly string[] = ['self.', 'this.', 'event.']

/** 这个字符串是不是"裸引用简写"（如 `self.atk`）。 */
function isBareRef(text: string): boolean {
  return BARE_REF_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/** 条件：四态递归。 */
export function mapCondition(dto: ConditionDto): Condition {
  if ('cmp' in dto) return { cmp: dto.cmp, left: mapExpr(dto.left), right: mapExpr(dto.right) }
  if ('not' in dto) return { not: mapCondition(dto.not) }
  if ('any' in dto) return { any: dto.any.map((item) => mapCondition(item)) }
  return { all: dto.all.map((item) => mapCondition(item)) }
}

/** 一条动作（`enter` / `exit` 有意丢弃，见文件头）。 */
export function mapAction(dto: ActionDto): ActionSpec {
  const spec: Mutable<ActionSpec> = { do: dto.do }
  if (dto.target !== undefined) {
    spec.target = typeof dto.target === 'string' ? dto.target : mapSelector(dto.target)
  }
  if (dto.stat !== undefined) spec.stat = dto.stat
  if (dto.status !== undefined) spec.status = dto.status
  if (dto.amount !== undefined) spec.amount = mapExpr(dto.amount)
  if (dto.seconds !== undefined) spec.seconds = mapExpr(dto.seconds)
  if (dto.duration !== undefined) spec.duration = mapExpr(dto.duration)
  if (dto.stackLimit !== undefined) spec.stackLimit = dto.stackLimit
  // ⚠️ 每个字段都必须**显式映射**（本文件不写通用 snake→camel 转换器）：
  //    漏一行 ⇒ 该参数在引擎侧恒为 undefined，而引擎按"没给这个参数"静默处理 ⇒ **不报错、不打日志**
  if (dto.enchant !== undefined) spec.enchant = dto.enchant
  return spec
}

/** 光环定义（两个通道都为空时返回 `undefined`，交由校验层报错）。 */
export function mapAura(dto: AuraDto): AuraDef {
  const aura: Mutable<AuraDef> = {
    select: typeof dto.select === 'string' ? dto.select : mapSelector(dto.select),
  }
  if (dto.apply !== undefined) {
    aura.apply = dto.apply.map((entry) => ({ stat: entry.stat, amount: entry.amount }))
  }
  if (dto.mul !== undefined) {
    aura.mul = dto.mul.map((entry) => ({ stat: entry.stat, factor: entry.factor }))
  }
  if (dto.condition !== undefined) aura.condition = mapCondition(dto.condition)
  return aura
}

/** 一条能力。 */
export function mapAbility(dto: AbilityDto): Ability {
  const ability: Mutable<Ability> = {
    id: dto.id,
    kind: dto.kind,
    actions: dto.actions.map((action) => mapAction(action)),
  }
  if (dto.priority !== undefined) ability.priority = dto.priority
  if (dto.trigger !== undefined) ability.trigger = { event: dto.trigger.event }
  if (dto.condition !== undefined) ability.condition = mapCondition(dto.condition)
  if (dto.everyN !== undefined) ability.everyN = dto.everyN
  return ability
}

export interface MapCardOptions {
  /** 所属卡包 `pack.yml` 的 `owner`：卡牌没写时**补齐**。 */
  readonly packOwner?: string
}

/** 附魔：DTO → 引擎 `EnchantDef`（三块效果各自可选，未写的不出现在产物里）。 */
export function mapEnchant(dto: EnchantDefDto): EnchantDef {
  const enchant: Mutable<EnchantDef> = { id: dto.id }
  if (dto.name !== undefined) enchant.name = dto.name
  if (dto.color !== undefined) enchant.color = dto.color
  if (dto.aura !== undefined) enchant.aura = mapAura(dto.aura)
  if (dto.stats !== undefined) enchant.stats = { ...dto.stats }
  if (dto.actions !== undefined) enchant.actions = dto.actions.map((action) => mapAction(action))
  return enchant
}

/** 卡牌：DTO → 引擎 `Card`（语义规则 ①②③ 见文件头）。 */
export function mapCard(dto: CardDto, options: MapCardOptions = {}): Card {
  const card: Mutable<Card> = {
    id: dto.id,
    name: dto.name,
    version: dto.version,
    size: dto.size,
    cooldown: dto.cooldown === -1 ? -1 : secondsToCs(dto.cooldown),
    rarity: dto.rarity,
    stats: { ...dto.stats },
  }
  // slots 缺省由 size 推导
  card.slots = dto.slots ?? DEFAULT_SLOTS[dto.size]
  // owner：卡牌自写优先；没写则由所属包补齐
  const owner = dto.owner ?? options.packOwner
  if (owner !== undefined) card.owner = owner
  if (dto.description !== undefined) card.description = dto.description
  if (dto.multicast !== undefined) card.multicast = dto.multicast
  if (dto.tags !== undefined) card.tags = [...dto.tags]
  if (dto.hiddenTags !== undefined) card.hiddenTags = [...dto.hiddenTags]
  if (dto.abilities !== undefined) card.abilities = dto.abilities.map((ability) => mapAbility(ability))
  if (dto.aura !== undefined) card.aura = mapAura(dto.aura)
  if (dto.enchantments !== undefined) card.enchantments = dto.enchantments.map((enchant) => mapEnchant(enchant))
  return card
}

/** 技能：DTO → 引擎 `Skill`（语义规则 ④：`actions` / `stats` 缺省补空）。 */
export function mapSkill(dto: SkillDto): Skill {
  const skill: Mutable<Skill> = {
    id: dto.id,
    name: dto.name,
    version: dto.version,
    rarity: dto.rarity,
    stats: dto.stats === undefined ? {} : { ...dto.stats },
    actions: dto.actions === undefined ? [] : dto.actions.map((action) => mapAction(action)),
  }
  if (dto.priority !== undefined) skill.priority = dto.priority
  if (dto.description !== undefined) skill.description = dto.description
  if (dto.trigger !== undefined) skill.trigger = { event: dto.trigger.event }
  if (dto.condition !== undefined) skill.condition = mapCondition(dto.condition)
  if (dto.aura !== undefined) skill.aura = mapAura(dto.aura)
  return skill
}

/** 角色：DTO → `HeroDef`（语义规则 ④：`initMaxHp` 缺省 = `initHp`）。 */
export function mapHero(dto: HeroDto): HeroDef {
  const hero: Mutable<HeroDef> = {
    id: dto.id,
    name: dto.name,
    version: dto.version,
    initHp: dto.initHp,
    initMaxHp: dto.initMaxHp ?? dto.initHp,
  }
  if (dto.levelupMaxHp !== undefined) hero.levelupMaxHp = [...dto.levelupMaxHp]
  if (dto.description !== undefined) hero.description = dto.description
  // （ `` / ``）：角色 `tags` 字段已整体删除，此处不再映射。
  return hero
}

/** 一条品阶（`value` / `prize` 已套内置兜底，见 `cards/economy.ts`）。 */
export function mapRarity(dto: RarityDto): RarityDef {
  const economy = resolveRarityEconomy(dto.id, dto.value, dto.prize)
  const rarity: Mutable<RarityDef> = {
    id: dto.id,
    name: dto.name,
    color: dto.color,
    value: economy.value,
    prize: economy.prize,
  }
  if (dto.frame !== undefined) rarity.frame = dto.frame
  return rarity
}
