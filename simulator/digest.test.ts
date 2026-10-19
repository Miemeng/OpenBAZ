// 结构化摘要（AG.5 = B）的单元测试：钉住"规范化"与"与语言无关"两个性质。
//
// 为什么这两条最重要：
//   · **规范化** ⇒ 同一结构必然得到同一字符串（不依赖对象键写入顺序）；
//   · **与语言无关** ⇒ 换 `locale`（或改一句译文）不该让回归基准变红。

import { describe, expect, it } from 'vitest'

import { runBattle } from '../engine/tick.ts'
import type { BattleOptions, Card, LocaleTable } from '../engine/types.ts'
import { battleDigest, canonicalJson } from './digest.ts'

/** 一张纯被动卡（无动作）⇒ 对局只会走到超时，跑得快且没有随机分支 */
const PASSIVE_CARD: Card = {
  id: 'c1',
  name: '试验卡',
  version: 1,
  size: 'small',
  cooldown: -1,
  rarity: 'bronze',
  stats: { atk: 1 },
}

function optionsOf(seed: number, locale?: LocaleTable): BattleOptions {
  return {
    seed,
    playerAName: '玩家A',
    playerBName: '玩家B',
    boardA: [{ card: PASSIVE_CARD, slot: 1 }],
    boardB: [],
    hpA: 100,
    maxHpA: 100,
    hpB: 100,
    maxHpB: 100,
    ...(locale === undefined ? {} : { locale }),
  }
}

describe('canonicalJson（规范化序列化）', () => {
  it('对象键排序 ⇒ 同样的结构必然是同样的字符串', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('跳过 undefined 键；数组保序；非有限数写 null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson([2, 1])).toBe('[2,1]')
    expect(canonicalJson(Number.NaN)).toBe('null')
  })
})

describe('battleDigest（与语言无关）', () => {
  it('同一局：换语言表 ⇒ 摘要逐字节相同', () => {
    const plain = battleDigest(runBattle(optionsOf(7)))
    const withLocale = battleDigest(
      runBattle(optionsOf(7, { 'stack_limit.truncated': '{stat} capped at {limit}' })),
    )
    expect(withLocale).toBe(plain)
  })

  it('不同 seed ⇒ 摘要不同（seed 进摘要）', () => {
    expect(battleDigest(runBattle(optionsOf(8)))).not.toBe(battleDigest(runBattle(optionsOf(7))))
  })

  it('摘要里没有渲染文本：只含结构化字段', () => {
    const digest = battleDigest(runBattle(optionsOf(7)))
    expect(digest).toContain('"victory"')
    expect(digest).toContain('"log"')
    // 文本日志字段不进摘要
    expect(digest).not.toContain('"lines"')
  })
})
