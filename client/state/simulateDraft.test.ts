// 草稿的附魔字段（C4c-1）：只测**纯逻辑**（不碰 registry / 文件系统）
import { describe, expect, it } from 'vitest'
import {
  addPlacement,
  isSideModified,
  movePlacementTo,
  sideSignature,
  withPlacementEnchant,
  withPlacementStat,
  type SideDraft,
} from './simulateDraft.ts'

function sideOf(): SideDraft {
  return {
    heroId: null,
    hpText: '',
    maxHpText: '',
    placements: [
      { uid: 'ironWall-1', cardId: 'ironWall', slot: 1 },
      { uid: 'emberWolf-2', cardId: 'emberWolf', slot: 2 },
    ],
    skills: [],
  }
}

describe('withPlacementEnchant（附魔 = 局外养成的草稿字段）', () => {
  it('设置：只改目标那一处，其余原样；再设置另一处互不影响', () => {
    const once = withPlacementEnchant(sideOf(), 0, 'aegis')
    expect(once.placements[0]?.enchant).toBe('aegis')
    expect(once.placements[1]?.enchant).toBeUndefined()

    const twice = withPlacementEnchant(once, 1, 'emerald')
    expect(twice.placements[0]?.enchant).toBe('aegis')
    expect(twice.placements[1]?.enchant).toBe('emerald')
    // 不可变：原对象没被改
    expect(sideOf().placements[0]?.enchant).toBeUndefined()
  })

  it('清除：传入 undefined ⇒ 该处**不再有** enchant 键（不是空串）', () => {
    const withOne = withPlacementEnchant(sideOf(), 0, 'aegis')
    const cleared = withPlacementEnchant(withOne, 0, undefined)
    expect(cleared.placements[0]).toBeDefined()
    expect(cleared.placements[0] !== undefined && 'enchant' in cleared.placements[0]).toBe(false)
    // 其它字段保持不变
    expect(cleared.placements[0]?.cardId).toBe('ironWall')
    expect(cleared.placements[0]?.slot).toBe(1)
  })
})

describe('挪位不丢附魔（回归）', () => {
  it('同方挪位（movePlacementTo）保住 enchant', () => {
    const enchanted = withPlacementEnchant(sideOf(), 0, 'aegis')
    const moved = movePlacementTo(enchanted, 0, 3)
    expect(moved.placements[0]?.slot).toBe(3)
    expect(moved.placements[0]?.enchant).toBe('aegis')
  })

  it('"先删后加"的落子路径（addPlacement 第 4 参）也能把 enchant 带过去', () => {
    const added = addPlacement(sideOf(), 'emberWolf', 4, 'emerald')
    const last = added.placements[added.placements.length - 1]
    expect(last?.enchant).toBe('emerald')
    // 不带时不留空键
    const plain = addPlacement(sideOf(), 'emberWolf', 4)
    const plainLast = plain.placements[plain.placements.length - 1]
    expect(plainLast !== undefined && 'enchant' in plainLast).toBe(false)
  })
})

describe('覆盖数值（C5）', () => {
  it('设置 / 逐项撤掉：只改目标那处；全撤掉后不留 stats 键', () => {
    const one = withPlacementStat(sideOf(), 0, 'atk', 12)
    expect(one.placements[0]?.stats).toEqual({ atk: 12 })
    expect(one.placements[1]?.stats).toBeUndefined()

    const two = withPlacementStat(one, 0, 'shield', 3)
    expect(two.placements[0]?.stats).toEqual({ atk: 12, shield: 3 })

    const dropped = withPlacementStat(two, 0, 'atk', undefined)
    expect(dropped.placements[0]?.stats).toEqual({ shield: 3 })

    const cleared = withPlacementStat(dropped, 0, 'shield', undefined)
    expect(cleared.placements[0] !== undefined && 'stats' in cleared.placements[0]).toBe(false)
  })

  it('挪位不丢覆盖；清附魔**不会**顺手清掉覆盖（老实现重建对象时会丢）', () => {
    const set = withPlacementEnchant(withPlacementStat(sideOf(), 0, 'atk', 12), 0, 'aegis')
    const moved = movePlacementTo(set, 0, 5)
    expect(moved.placements[0]?.slot).toBe(5)
    expect(moved.placements[0]?.stats).toEqual({ atk: 12 })
    expect(moved.placements[0]?.enchant).toBe('aegis')

    const noEnchant = withPlacementEnchant(moved, 0, undefined)
    expect(noEnchant.placements[0]?.stats).toEqual({ atk: 12 })
    expect(noEnchant.placements[0] !== undefined && 'enchant' in noEnchant.placements[0]).toBe(false)
  })

  it('覆盖数值参与"已修改"指纹（改回原值即复原）', () => {
    const base: SideDraft = { ...sideOf(), sourcePath: 'decks/testA.yml' }
    const imported: SideDraft = { ...base, sourceSignature: sideSignature(base) }
    expect(isSideModified(imported)).toBe(false)

    const changed = withPlacementStat(imported, 0, 'atk', 12)
    expect(isSideModified(changed)).toBe(true)
    expect(isSideModified(withPlacementStat(changed, 0, 'atk', undefined))).toBe(false)
  })
})

describe('导入 = 拷贝（来源 / 已修改标记）', () => {
  it('没有导入来源 ⇒ 不标"已修改"', () => {
    expect(isSideModified(sideOf())).toBe(false)
  })

  it('导入后未改 ⇒ false；改了附魔 / 摆位 / 技能 ⇒ true；改回来 ⇒ 又变 false', () => {
    const base: SideDraft = { ...sideOf(), sourcePath: 'decks/testA.yml' }
    const imported: SideDraft = { ...base, sourceSignature: sideSignature(base) }
    expect(isSideModified(imported)).toBe(false)

    const enchanted = withPlacementEnchant(imported, 0, 'aegis')
    expect(isSideModified(enchanted)).toBe(true)

    // 改回去（清除附魔）⇒ 指纹复原 ⇒ 不再算"已修改"
    expect(isSideModified(withPlacementEnchant(enchanted, 0, undefined))).toBe(false)
  })
})
