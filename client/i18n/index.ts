// 界面文案入口（AG.10 = A）：目前固定 `zh-CN`，**不加语言切换器**。
//
// 为什么先不做切换：切语言要牵出"回放里已生成的文本 / 已在内存里的数据文案要不要热切换"，
// 留到 1.0 之后；当前先把**结构**（键 + 取值函数）落下来，后续加语言只改这一层。

import { ZH_CN, type UiKey } from './zh-CN.ts'

/** 当前语言表（目前只有中文） */
const TABLE: Readonly<Record<UiKey, string>> = ZH_CN

/**
 * 取一条界面文案。
 *
 * @param key 文案键（见 `zh-CN.ts`）
 * @param vars 模板占位符（`{name}` 形式）；缺参保留原样 `{name}`，便于一眼看出漏传
 * @returns 文案
 */
export function t(key: UiKey, vars?: Readonly<Record<string, string | number>>): string {
  const template: string = TABLE[key]
  if (vars === undefined) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (all: string, name: string) => {
    const value = vars[name]
    return value === undefined ? all : String(value)
  })
}
