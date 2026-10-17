/**
 * **`stats` / `stat` 字段封闭词表的唯一来源**（技术债第 5 条的收口，见下）。
 *
 * 为什么单独成文件、且放在 `engine/`：
 *  - `stats` 是**开放数值表**，但"哪些键是引擎认识的"必须有一份**权威清单** —— 校验层
 *    （`cards/schema.ts`）要用它报"未知属性键"，光环层（`engine/aura.ts`）要用它判"哪些 stat 禁止"，
 *    将来引擎新增属性 / DOT 数值位时也只应该改**这一处**；
 *  - 放在 `engine/` 而不是 `cards/`：词表描述的是**引擎怎么读属性**，属引擎契约；
 *    `cards/` 作为下游引用它（依赖方向仍是 `cards → engine`，不反向）。
 *
 * 技术债第 5 条的收口（ `` = A"词表改由引擎侧导出"）：
 * 原状是 `cards/schema.ts` 抄了一份、`engine/aura.ts` 又写了两个 `FORBIDDEN_*` 集合，
 * "引擎加了新属性、包侧却写不了"要同时改三处。现在**词表唯一来源 = 本文件**；
 * `FORBIDDEN_*`（政策：光环不许改哪些）仍留在 `engine/aura.ts`，不属本文件职责。
 */

/**
 * 卡牌 / 技能 `stats` 开放表的**已知键**。
 *
 * 命名：**全词优先**，只保留既有的几个缩写（`atk` / `hp` / `maxHp` / `cdp` —— `cdp` 是冷却百分比系数的既有约定）；
 * 缩写必须能**唯一还原**（`sol` 这类一律不准），且**同一概念全链路同名** —— 卡面 `stats`、玩家侧持续效果、
 * 日志、帧快照用同一个词，所以 `burn` / `poison` / `regen` **同时**是卡面键与玩家侧数值位。
 */
export const STAT_KEYS = [
  'atk',
  'speed',
  'shield',
  'heal',
  'burn',
  'poison',
  'regen',
  'haste',
  'slow',
  'freeze',
  'charge',
  'cdp',
  /**
   * **卡牌价值**（ 新增， ``）：该卡在商店 / 合成里的价值读数。
   * 缺省由**当前品阶**的 `value`（品阶表项）初始化，卡面写了则以卡面为准。
   * 取代此前的 `buyPrize` / `prize` 两个卡面字段。
   */
  'value',
] as const

/** 持续效果的三个数值位（已是 `STAT_KEYS` 的子集：卡面写层数、玩家侧写状态，同一个词）。 */
export const DOT_STAT_KEYS = ['burn', 'poison', 'regen'] as const

/** `stat` 字段的**完整封闭词表** = 属性表 + 三个持续效果数值位（去重后即属性表）。 */
export const ALL_STAT_KEYS: readonly string[] = [...new Set<string>([...STAT_KEYS, ...DOT_STAT_KEYS])]
