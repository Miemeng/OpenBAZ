// 阵容导出的单元测试：文件名分配 + 导出的 YAML 能被 `parseDeckText` 原样读回。
//
// 这条往返（DTO → YAML → DTO）是"导出的文件丢回 decks/ 就能用"的唯一保证。

import { describe, expect, it } from 'vitest'

import { parseDeckText, type DeckDto } from '../../cards/deck.ts'
import { deckToYaml, nextDeckFileName } from './deckYaml.ts'

const DTO: DeckDto = {
  hero: 'testHeroA',
  hp: 320,
  maxHp: 340,
  cards: [
    { id: 'ironWall', slot: 1, enchant: 'aegis', stats: { atk: 12, shield: 3 } },
    { id: 'emberWolf', slot: 4 },
  ],
  skills: ['emberOath', 'warDrums'],
}

describe('nextDeckFileName', () => {
  it('从 01 起、跳过已占用的号，只看同侧文件', () => {
    expect(nextDeckFileName('A', [])).toBe('A_01.yml')
    expect(nextDeckFileName('A', ['decks/A_01.yml', 'decks/A_03.yml'])).toBe('A_02.yml')
    // B 侧的文件不影响 A 侧编号
    expect(nextDeckFileName('B', ['decks/A_01.yml', 'decks/B_01.yml'])).toBe('B_02.yml')
  })
})

describe('deckToYaml', () => {
  it('往返：导出的 YAML 能被 parseDeckText 读回同一份数据', () => {
    const parsed = parseDeckText(deckToYaml(DTO, 'A_01'), 'decks/A_01.yml')
    expect(parsed.errors).toEqual([])
    expect(parsed.dto?.hero).toBe(DTO.hero)
    expect(parsed.dto?.hp).toBe(DTO.hp)
    expect(parsed.dto?.maxHp).toBe(DTO.maxHp)
    expect(parsed.dto?.cards).toEqual(DTO.cards)
    expect(parsed.dto?.skills).toEqual(DTO.skills)
    expect(parsed.dto?.name).toBe('A_01')
  })

  it('中文名 / 特殊字符会被安全引用，读回不丢字', () => {
    const parsed = parseDeckText(deckToYaml(DTO, '我的阵容：测试'), 'decks/x.yml')
    expect(parsed.errors).toEqual([])
    expect(parsed.dto?.name).toBe('我的阵容：测试')
  })

  it('没有 stats / enchant / skills 的阵容也能往返', () => {
    const plain: DeckDto = { hero: 'testHeroB', cards: [{ id: 'emberWolf', slot: 2 }] }
    const parsed = parseDeckText(deckToYaml(plain, 'B_01'), 'decks/B_01.yml')
    expect(parsed.errors).toEqual([])
    expect(parsed.dto?.cards).toEqual([{ id: 'emberWolf', slot: 2 }])
    expect(parsed.dto?.skills).toBeUndefined()
  })
})
