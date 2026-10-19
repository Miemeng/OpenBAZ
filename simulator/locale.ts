// 语言表的**宿主侧读取**（CLI 专用）—— 引擎不读文件（黄金法则 2），
// 由这里把 YAML 读成纯对象，再经 `BattleOptions.locale` 注入。
//
// 口径（《审阅.md》§AG：AG.2 = A / AG.3 = A / AG.4 = A）：
//   · 全局一份 `locales/<lang>.yml`；
//   · 结构 = `{ lang: string, messages: { <键>: <模板> } }`，占位符 `{参数名}`；
//   · **缺键回落引擎内置中文**，所以这里只负责"读 + 形状校验"，不做回退逻辑。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocaleTable } from '../engine/types.ts'
import { parseYamlDocument } from '../cards/schema.ts'

/** 判断一个未知值是不是普通对象（非数组 / 非 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 `--locale` 的取值里取**语言名**（给"数据文案按哪种语言解析"用）。
 *
 * - 语言名形式（`zh-CN`）⇒ 原样返回；
 * - 文件路径形式（`locales/en.yml`、`C:\…\zh-CN.yml`）⇒ 取**文件名主干**。
 */
export function localeNameOf(input: string): string {
  const cut = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  const base = cut >= 0 ? input.slice(cut + 1) : input
  return base.replace(/\.ya?ml$/iu, '')
}

/**
 * 把 `--locale` 的取值解析成**语言表文件路径**。
 *
 * @param input 语言名（`zh-CN`）或文件路径（`locales/zh-CN.yml` / 任意相对或绝对路径）
 * @param root 解析相对路径的根（缺省 = 当前工作目录；测试里显式传）
 * @returns 语言表文件路径；**语言名形式** ⇒ `<root>/locales/<name>.yml`
 */
export function resolveLocalePath(input: string, root: string = process.cwd()): string {
  const looksLikePath =
    input.endsWith('.yml') || input.endsWith('.yaml') || input.includes('/') || input.includes('\\')
  return looksLikePath ? input : join(root, 'locales', `${input}.yml`)
}

/**
 * 读取并校验一份语言表。
 *
 * @param filePath 语言表文件（UTF-8 YAML）
 * @returns 只含 `messages` 段的扁平表（键 → 模板）
 * @throws 读不到文件 / YAML 语法错 / 顶层不是映射 / 缺 `messages` 段 / 某条不是非空字符串
 */
export function loadLocaleTable(filePath: string): LocaleTable {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    throw new Error(`语言表读不到：${filePath}`)
  }

  const doc = parseYamlDocument(text, filePath)
  if (doc.syntaxError !== undefined) {
    const where =
      doc.syntaxError.line === undefined
        ? ''
        : `（第 ${String(doc.syntaxError.line)} 行${doc.syntaxError.column === undefined ? '' : `:${String(doc.syntaxError.column)}`}）`
    throw new Error(`语言表语法错：${filePath}${where} ${doc.syntaxError.message}`)
  }
  if (!isRecord(doc.value)) {
    throw new Error(`语言表顶层必须是映射（{ lang, messages }）：${filePath}`)
  }

  const messages = doc.value['messages']
  if (!isRecord(messages)) {
    throw new Error(`语言表缺少 messages 段：${filePath}`)
  }

  const table: Record<string, string> = {}
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`语言表条目「${key}」必须是非空字符串：${filePath}`)
    }
    table[key] = value
  }
  return table
}
