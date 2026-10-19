// 棋盘**单位网格**口径（摆盘态与回放态共用）—— 纯逻辑，无 JSX。

// RW 定：**小卡 高4宽2 / 中卡 高4宽4 / 大卡 高4宽6** —— 一行 10 格 = **20 个单位列 × 4 个单位行**
// （1 格 = 2 列），三种尺寸**都占满 4 行**；行高由 `aspect-ratio: 20 / 4` 跟着宽度走，
// 于是单位格是正方形，卡面比例正好是 **2:4 / 4:4 / 6:4**（1:2 / 1:1 / 3:2）——
// 与《卡面表现设计.md》§2 的三尺寸（200×400 / 400×400 / 600×400）一致。
// 设计尺寸：1 格宽 = 200px（2 个单位列 × 100px）、卡面高 = 400px（4 个单位行 × 100px）。
//
// ⚠️ **占几格仍由引擎的 `slotsForCard()` 决定**（前端不复刻占格规则），
// 本文件只做"格 → 单位列"的换算，供 `BoardRow`（摆盘）与 `BattleView`（回放）共用，
// 免得两份坐标算错其中一个。
import { ROW_SLOTS } from '../../engine/board.ts'

/** 一格 = 几个单位列 */
export const UNITS_PER_SLOT = 2

/** 一行 = 几个单位行（= 卡面高度；三种尺寸一律占满） */
export const UNIT_ROWS = 4

/** 一行共几列（= `ROW_SLOTS × UNITS_PER_SLOT`，供 `aspect-ratio` 与 `styles.css` 对齐） */
export const UNIT_COLUMNS_TOTAL = ROW_SLOTS * UNITS_PER_SLOT

/**
 * 某个"格 + 占几格"在 CSS Grid 里的列声明。
 *
 * @param slot 左端格号（1 基）
 * @param slots 占几格（来自 `slotsForCard()`）
 * @returns 形如 `"3 / span 4"` 的 `grid-column` 值
 */
export function unitColumns(slot: number, slots: number): string {
  return `${String((slot - 1) * UNITS_PER_SLOT + 1)} / span ${String(slots * UNITS_PER_SLOT)}`
}
