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
