/**
 * **引擎 / 数据兼容版本号的唯一来源**。
 *
 * 口径：
 *  - **正式版（1.0.0）之前按"内测小版本"递增**：`0.1.0` → `0.2.0` …（RW 2026-10-19 定：内测期
 *    不再固定 `0.0.0`）。本常量必须与 `package.json` 的 `version` 一致，由 `tools/check-config.mjs`
 *    在 `npm run verify` 第一步（`check:config`）校验。
 *  - `pack.yml` 的 **`engineRange` 与"引擎 / 规则版本"比较时以本常量为准** —— 它与文档版本号
 *    是两条互不复用的线。
 *  - 区间比较**已实现**（见 `cards/schema.ts` 的 `engineRangeSatisfied()` 与
 *    `validatePackManifest` 的 `engineVersion` 选项）：`engineRange` = **结构化区间对象数组**
 *    `{ from?, to?, fromInclusive?, toInclusive? }`，**缺省左闭右开**、省略一侧 = 无界、
 *    两侧都省 ⇒ 结构层拒绝；边界写全三段 `major.minor.patch` 字符串**并加引号**
 *    （不加引号会被 YAML 读成数字，`0.10 ≠ 0.1`）；任一区间命中本常量 ⇒ 可加载，都不命中 ⇒
 *    `error`「低版本拒绝导入」、整包不注册。
 *  - ⚠️ 字段名 `engineRange` 是 **（批次 D）起的口径**；更早文档 / 历史行里的 `engine_range`
 *    是旧名（按  `` 历史行不回改）。
 */

/** 引擎版本（`major.minor.patch`）：内测期从 `0.1.0` 起递增，与 `package.json.version` 同步。 */
export const ENGINE_VERSION = '0.1.0'
