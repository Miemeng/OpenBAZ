// 语言表（i18n）在引擎侧的单元测试：钉住"缺省 = 内置中文 / 有表 = 模板渲染 / 缺键回落"三条口径。
//
// 为什么放在 engine/：被测的是 `messageText` / `formatMessage` 这两个渲染函数，
// 它们属于引擎契约（`LogMessage` 的文案唯一权威），且**不读文件**便于单测。

import { describe, expect, it } from 'vitest'

import { formatMessage, messageText } from './log.ts'
import { createBattleState } from './state.ts'
import type { LocaleTable, LogMessage } from './types.ts'

const STACK_LIMIT: LogMessage = {
  level: 'note',
  code: 'stack_limit.truncated',
  tick: 3,
  data: { stat: 'atk', limit: '5' },
}

const AURA_ENTERED: LogMessage = {
  level: 'info',
  code: 'aura.entered',
  tick: 2,
  data: { target_name: '铁壁(第3格)', stat: 'atk', amount: 3, channel: 'flat' },
}

describe('messageText：缺省 = 内置中文', () => {
  it('不传语言表时输出与引入语言表之前逐字节一致', () => {
    expect(messageText(STACK_LIMIT)).toBe('atk 已达层数上限 5，本次叠加被截断')
  })

  it('传空表也回落到内置中文', () => {
    expect(messageText(STACK_LIMIT, {})).toBe('atk 已达层数上限 5，本次叠加被截断')
  })
})

describe('messageText：有表 = 模板渲染', () => {
  it('命中键 ⇒ 用模板 + data 参数', () => {
    const table: LocaleTable = { 'stack_limit.truncated': '{stat} hit the cap of {limit} layers' }
    expect(messageText(STACK_LIMIT, table)).toBe('atk hit the cap of 5 layers')
  })

  it('派生参数 {value}：平铺带符号、倍率带 ×', () => {
    const table: LocaleTable = { 'aura.entered': '{target_name}: {stat} {value}' }
    expect(messageText(AURA_ENTERED, table)).toBe('铁壁(第3格): atk +3')
    const mul: LogMessage = {
      level: 'info',
      code: 'aura.entered',
      tick: 2,
      data: { target_name: '铁壁', stat: 'atk', amount: 0.5, channel: 'mul' },
    }
    expect(messageText(mul, table)).toBe('铁壁: atk ×1.5')
  })

  it('模板引用了不存在的参数 ⇒ 写 ?（与 dataText 同一降级口径）', () => {
    const table: LocaleTable = { 'stack_limit.truncated': '{stat} / {nope}' }
    expect(messageText(STACK_LIMIT, table)).toBe('atk / ?')
  })

  it('只有部分键有译文 ⇒ 逐条回落，而不是整表失效', () => {
    const table: LocaleTable = { 'selector.sort_key_ignored': 'ignored: {text}' }
    expect(messageText(STACK_LIMIT, table)).toBe('atk 已达层数上限 5，本次叠加被截断')
    expect(messageText({ level: 'note', code: 'selector.sort_key_ignored', tick: 1, data: { text: 'speed_asc' } }, table)).toBe(
      'ignored: speed_asc',
    )
  })
})

describe('formatMessage：语言表可以挂在 state 上', () => {
  it('BattleOptions.locale → BattleState.locale → 文本行用译文', () => {
    const locale: LocaleTable = { 'stack_limit.truncated': '[{stat}] capped at {limit}' }
    const state = createBattleState({
      seed: 1,
      playerAName: '玩家A',
      playerBName: '玩家B',
      boardA: [],
      boardB: [],
      locale,
    })
    expect(state.locale).toBe(locale)
    // 文本行格式：`[t=  3|  0.6s] [note] stack_limit.truncated：…`
    expect(formatMessage(state, STACK_LIMIT)).toContain('stack_limit.truncated：[atk] capped at 5')
  })

  it('显式传入的 locale 优先于 state.locale', () => {
    const state = createBattleState({
      seed: 1,
      playerAName: '玩家A',
      playerBName: '玩家B',
      boardA: [],
      boardB: [],
      locale: { 'stack_limit.truncated': 'state' },
    })
    expect(formatMessage(state, STACK_LIMIT, { 'stack_limit.truncated': 'arg' })).toContain('stack_limit.truncated：arg')
  })
})
