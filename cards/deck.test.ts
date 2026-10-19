// 阵容的 **`cards[].stats` 覆盖**（C5）：结构 → 语义 → 装配三段一起测。
//
// 口径（《规则说明书.md》§18.7 / 《YAML数据格式规范.md》的 decks 段）：
//   · 语义 = **覆盖**（不是增量）；
//   · **`speed` / `cdp` 禁写**（写 ⇒ error）；
//   · 叠加次序 = 卡面 → **本覆盖** → 附魔 `stats` → 局内 buff → 光环。
import { describe, expect, it } from 'vitest'
import { createBattleState, effectiveStat } from '../engine/state.ts'
import type { Card } from '../engine/types.ts'
import { parseDeckText, resolveDeck, validateDeck, type DeckDto } from './deck.ts'
import { CardRegistry } from './registry.ts'
import type { HeroDef, LoadedPack } from './types.ts'

const HERO: HeroDef = { id: 'myHero', name: '英雄', version: 1, initHp: 300, initMaxHp: 300 }

function cardOf(id: string, stats: Readonly<Record<string, number>>): Card {
  return { id, name: id, version: 1, size: 'small', cooldown: 300, rarity: 'common', stats }
}

function registryOf(cards: readonly Card[]): CardRegistry {
  const registry = new CardRegistry()
  const pack: LoadedPack = {
    packId: 'test',
    name: '测试包',
    version: 1,
    builtin: false,
    cards,
    skills: [],
    heroes: [HERO],
    source: 'packs/test',
  }
  registry.replaceAll([pack])
  return registry
}

/** 解析成功才算数（失败时把错误一并抛出，便于定位） */
function dtoOf(text: string): DeckDto {
  const parsed = parseDeckText(text, 'decks/x.yml')
  if (parsed.dto === undefined) {
    throw new Error(`阵容解析失败：${parsed.errors.map((issue) => issue.message).join(' / ')}`)
  }
  return parsed.dto
}

/** 非空断言（`noUncheckedIndexedAccess` 下的便利） */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('装配错误：期望存在，实际得到 undefined')
  return value
}

const CTX = { file: 'decks/x.yml', positions: new Map() }

describe('错误码细分（批 67-B）', () => {
  it('阵容六类问题各有可机读的码，不再统统落到 schema.invalid', () => {
    const registry = registryOf([cardOf('c1', { atk: 5 })])
    const codesOf = (text: string): readonly string[] =>
      validateDeck(dtoOf(text), registry, CTX).map((issue) => issue.code)

    expect(codesOf('hero: nobody\ncards:\n  - id: c1\n    slot: 1\n')).toContain('deck.hero.unknown')
    expect(codesOf('hero: myHero\ncards:\n  - id: nope\n    slot: 1\n')).toContain('deck.card.unknown')
    expect(codesOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    enchant: fire\n')).toContain(
      'deck.enchant.unknown',
    )
    expect(codesOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { speed: 2 }\n')).toContain(
      'deck.stats.forbidden_key',
    )
    expect(codesOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\nskills: [nope]\n')).toContain('deck.skill.unknown')
    // maxHp < hp 是 warn，但码同样细分
    expect(codesOf('hero: myHero\nhp: 500\nmaxHp: 300\ncards:\n  - id: c1\n    slot: 1\n')).toContain(
      'deck.hp.max_less_than_hp',
    )
  })
})

describe('cards[].stats（C5 覆盖）', () => {
  it('结构层接受数值映射；非数字 ⇒ 结构层拒绝', () => {
    const ok = dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { atk: 12, shield: 3 }\n')
    expect(ok.cards[0]?.stats).toEqual({ atk: 12, shield: 3 })

    const bad = parseDeckText(
      'hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { atk: 很高 }\n',
      'decks/y.yml',
    )
    expect(bad.dto).toBeUndefined()
    expect(bad.errors.length).toBeGreaterThan(0)
  })

  it('speed / cdp 禁写 ⇒ error；其余键放行', () => {
    const registry = registryOf([cardOf('c1', { atk: 5 })])

    const speed = validateDeck(dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { speed: 2 }\n'), registry, CTX)
    expect(speed.some((issue) => issue.message.includes('不得覆盖 speed'))).toBe(true)

    const cdp = validateDeck(dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { cdp: 50 }\n'), registry, CTX)
    expect(cdp.some((issue) => issue.message.includes('不得覆盖 cdp'))).toBe(true)

    const fine = validateDeck(dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { atk: 9 }\n'), registry, CTX)
    expect(fine).toHaveLength(0)
  })

  it('装配：覆盖 → Placement.stats → BoardCard.statOverrides → effectiveStat 以**覆盖值**为基础', () => {
    const registry = registryOf([cardOf('c1', { atk: 5, heal: 1, shield: 2 })])
    const resolved = must(
      resolveDeck(dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n    stats: { atk: 12, heal: 7 }\n'), registry, 'A'),
    )
    expect(resolved.placements[0]?.stats).toEqual({ atk: 12, heal: 7 })

    const state = createBattleState({
      seed: 1,
      playerAName: 'A',
      playerBName: 'B',
      boardA: resolved.placements,
      boardB: [],
    })
    const boardCard = must(state.players[1].board[0])
    expect(boardCard.statOverrides).toEqual({ atk: 12, heal: 7 })
    // 覆盖 = 取代卡面值（不是加法：若是增量，这里会是 17）
    expect(effectiveStat(state, boardCard, 'atk')).toBe(12)
    expect(effectiveStat(state, boardCard, 'heal')).toBe(7)
    // 卡面有、覆盖表里**没有**的键 ⇒ 仍用卡面值
    expect(effectiveStat(state, boardCard, 'shield')).toBe(2)
  })

  it('不写 stats ⇒ 完全沿用卡面值、且不留空键（既有行为不变）', () => {
    const registry = registryOf([cardOf('c1', { atk: 5 })])
    const resolved = must(resolveDeck(dtoOf('hero: myHero\ncards:\n  - id: c1\n    slot: 1\n'), registry, 'A'))
    expect(resolved.placements[0]?.stats).toBeUndefined()

    const state = createBattleState({
      seed: 1,
      playerAName: 'A',
      playerBName: 'B',
      boardA: resolved.placements,
      boardB: [],
    })
    const boardCard = must(state.players[1].board[0])
    expect(boardCard.statOverrides).toBeUndefined()
    expect(effectiveStat(state, boardCard, 'atk')).toBe(5)
  })
})
