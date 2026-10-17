/**
 * **品阶（rarity）与卡牌价值（value）的经济口径** —— 内置兜底 + 生效值解析。
 *
 * 口径来源（ ``）：
 *  1. **价值挂在品阶上**：卡牌价值不再是独立的 `card_values.yml`，而是**品阶表的一项**
 *     包内 `rarities.yml` 的每个品阶可写 `value`（基础价值）与 `prize`（当前售价）。
 *     基础规则表放 **`packs/base/rarities.yml`**（`core` 包仍只用来临时调数值）。
 *  2. **引擎内置兜底**（`BUILTIN_RARITY_VALUES`）：防止 `packs/base` 被改动 / 缺失时整个经济崩掉
 *     品阶未写 `value` / `prize` 时一律回落到内置值。
 *  3. **`prize` 缺省 = `value`**（写了则覆盖）—— 模拟模式战斗内不变价。
 *  4. 本模块还持有**内置品阶 id 与合成链**（唯一来源）：`cards/schema.ts` 与 `cards/loader.ts`
 *     都从这里取，避免又多一处需要同步的清单。
 *
 * 注：`stats.value`（卡面数值表里的 `value`）是**运行时取值**，其初始化 = 该卡当前品阶的
 * `value`（本模块解析出来的生效值）。★ 旧的 `buyPrize` / `prize` 两个卡面字段**已于  整体废除**
 * （写它们 ⇒ 校验期 `error`，提示改写成 `stats.value`）。
 */

/** 引擎内置的四个品阶 id（顺序 = 从最低到最高）。 */
export const BUILTIN_RARITY_IDS = ['bronze', 'silver', 'gold', 'diamond'] as const

/**
 * 内置品阶的合成链：**从最低品阶到最高品阶**（ 的默认链 `bronze → silver → gold → diamond`）。
 * 包内 `rarities.yml` 的 `upgrade` 与它同义；⚠️ **链上不允许出现自定义品阶**（见 `cards/loader.ts`）。
 */
export const BUILTIN_UPGRADE_CHAIN: readonly string[] = BUILTIN_RARITY_IDS

/**
 * **内置兜底价值表**：品阶 id → 基础价值。
 * 品阶未写 `value` ⇒ 取这里的值；不在表内的自定义品阶 ⇒ 取 `DEFAULT_RARITY_VALUE`。
 */
export const BUILTIN_RARITY_VALUES: Readonly<Record<string, number>> = {
  bronze: 1,
  silver: 3,
  gold: 8,
  diamond: 20,
}

/** 表外的品阶（自定义 / 未登记）回落到这个基础价值。 */
export const DEFAULT_RARITY_VALUE = 1

/**
 * **内置品阶的兜底颜色表**。
 *
 * 为什么需要它：品阶色是**表现层**要用的，但 `rarities: { source: builtin }` 的包**没有品阶项**
 * （`LoadedRarities` 只有 `{ source: 'builtin' }`）—— 客户端届时拿不到任何 `color`。
 * 故把内置四档的颜色与 id / 价值放在同一处（本模块已是"内置品阶"的唯一来源），
 * 与 `packs/base/rarities.yml` 里那四行保持一致（改一处要同步另一处，已在此注明）。
 */
export const BUILTIN_RARITY_COLORS: Readonly<Record<string, string>> = {
  bronze: '#8d6e63',
  silver: '#b0bec5',
  gold: '#ffc107',
  diamond: '#00e5ff',
}

/**
 * 卡框缺失 / 未登记时的**纯色兜底**（`color` 也没有时用它）。
 * 十六进制灰：与"未定义品阶"的视觉语义一致（客户端另在状态栏提示一次，不阻塞）。
 */
export const FALLBACK_RARITY_COLOR = '#5c6470'

/** 解析后的**生效价值**：该品阶的 `value` 与 `prize`（`prize` 缺省 = `value`）。 */
export interface RarityEconomy {
  /** 基础价值：卡面 `stats.value` 缺省时按它初始化。 */
  readonly value: number
  /** 当前售价：不写 ⇒ 等于 `value`。 */
  readonly prize: number
}

/**
 * 由品阶表的一项解析出**生效价值**（套过内置兜底）。
 *
 * @param id 品阶 id（用于查内置兜底表）
 * @param value 包内声明的 `value`；`undefined` ⇒ 用内置兜底
 * @param prize 包内声明的 `prize`；`undefined` ⇒ 等于解析后的 `value`
 * @returns 生效的 `{ value, prize }`；均为非负数
 */
export function resolveRarityEconomy(
  id: string,
  value: number | undefined,
  prize: number | undefined,
): RarityEconomy {
  const resolved = value ?? BUILTIN_RARITY_VALUES[id] ?? DEFAULT_RARITY_VALUE
  return { value: resolved, prize: prize ?? resolved }
}
