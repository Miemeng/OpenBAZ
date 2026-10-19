// 内联多语言文本（《审阅.md》§AG：AG.1 = A）—— 纯逻辑、无宿主依赖。
//
// 形态：
//   · **裸字符串** = 默认语言（`DEFAULT_LOCALE`）的文案 —— 现有 52 处数据零迁移；
//   · **对象** = `{ 'zh-CN': '狼', en: 'Wolf' }`，读取时按目标语言取，缺该语言则回落默认语言。
//
// 纪律：语言只影响**显示文本**，不影响任何规则 / 判定 / 数值；读取层在映射阶段就把它解析成 `string`，
// 所以引擎与表现层看到的仍然是普通字符串（`Card.name` 等类型不变）。

/** 默认语言（缺省目标语言，也是"裸字符串"被视作的语言）。 */
export const DEFAULT_LOCALE = 'zh-CN'

/** 内联多语言文本：裸字符串（= 默认语言）或 `语言 → 文案` 映射。 */
export type LocalizedText = string | Readonly<Record<string, string>>

/** 一个值是不是"多语言对象"（不是裸字符串）。 */
export function isMultilingualText(value: LocalizedText): value is Readonly<Record<string, string>> {
  return typeof value !== 'string'
}

/**
 * 把内联多语言文本解析成**某一语言的字符串**。
 *
 * @param value 裸字符串或 `语言 → 文案` 映射
 * @param locale 目标语言（缺省 `DEFAULT_LOCALE`）
 * @returns 目标语言文案；没有该语言 ⇒ 回落默认语言；连默认语言都没有 ⇒ 空串（校验层已拦，正常数据到不了这里）
 */
export function resolveText(value: LocalizedText, locale: string = DEFAULT_LOCALE): string {
  if (typeof value === 'string') return value
  return value[locale] ?? value[DEFAULT_LOCALE] ?? ''
}

/**
 * 多语言对象是否带**默认语言**条目（校验用：没有默认语言就没法给"不翻这条"的场景兜底）。
 *
 * 裸字符串恒为 `true`（它本身就是默认语言）。
 */
export function hasDefaultLocale(value: LocalizedText): boolean {
  if (typeof value === 'string') return true
  const text = value[DEFAULT_LOCALE]
  return text !== undefined && text.length > 0
}
