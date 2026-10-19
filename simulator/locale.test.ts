// CLI 侧语言表读取的单元测试（`--locale` 的落点）。
//
// 口径（《审阅.md》§AG：AG.2 / AG.3 / AG.4 = A）：
//   · 语言名 ⇒ `locales/<name>.yml`；给路径则原样用；
//   · 文件结构 = `{ lang, messages }`，读出来只留 `messages` 扁平表；
//   · **缺键由引擎回落内置中文**，本文件不测回退，只测"读得对 / 坏输入报得清"。

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadLocaleTable, localeNameOf, resolveLocalePath } from './locale.ts'

const REPO_ROOT = process.cwd()

describe('resolveLocalePath', () => {
  it('语言名 ⇒ <root>/locales/<name>.yml', () => {
    expect(resolveLocalePath('zh-CN', 'R')).toBe(join('R', 'locales', 'zh-CN.yml'))
  })

  it('已经是路径形式（带扩展名或分隔符）⇒ 原样返回', () => {
    expect(resolveLocalePath('locales/zh-CN.yml', 'R')).toBe('locales/zh-CN.yml')
    expect(resolveLocalePath('sub/dir/lang.yml', 'R')).toBe('sub/dir/lang.yml')
  })
})

describe('localeNameOf（从 `--locale` 取值里取语言名）', () => {
  it('语言名原样返回；路径取文件名主干', () => {
    expect(localeNameOf('zh-CN')).toBe('zh-CN')
    expect(localeNameOf('locales/en.yml')).toBe('en')
    expect(localeNameOf('sub\\dir\\ja.yaml')).toBe('ja')
  })
})

describe('loadLocaleTable（读真实的 locales/zh-CN.yml）', () => {
  const file = join(REPO_ROOT, 'locales', 'zh-CN.yml')

  it('读出 7 条消息码，模板文本与内置中文一致', () => {
    const table = loadLocaleTable(file)
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(7)
    expect(table['stack_limit.truncated']).toBe('{stat} 已达层数上限 {limit}，本次叠加被截断')
    expect(table['selector.type_mismatch']).toContain('{selector}')
    expect(table['aura.entered']).toContain('{value}')
  })

  it('表里没有的键就是 undefined（回落由引擎负责）', () => {
    const table = loadLocaleTable(file)
    expect(table['no.such.code']).toBeUndefined()
  })

  it('文件不存在 ⇒ 报错带路径', () => {
    expect(() => loadLocaleTable(join(REPO_ROOT, 'locales', 'nope.yml'))).toThrow(/语言表读不到/)
  })
})
