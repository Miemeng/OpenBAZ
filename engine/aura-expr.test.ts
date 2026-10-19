// 光环平铺数额吃表达式（`aura.apply.amount` = 字面量或表达式）
//
// 覆盖：
//   1. `{ ref: self.<stat> }` —— 卡牌来源；
//   2. `{ add: [...] }` 组合；
//   3. **不自指放大**：数额 = 自身攻击时逐帧重建结果稳定（表达式不读光环层）；
//   4. 玩家侧 DOT 数额同样可写表达式；
//   5. 技能来源（无来源卡）从技能自带 `stats` 取值；
//   6. 台账记的是**求值后**的数，且两次重建逐值一致；
//   7. 光环里引用事件参数 ⇒ 运行期抛错（静态校验另有拦截）。

// 约束：**不依赖 Vitest 快照序列化**，断言一律写具体数值 / 具体文案。
import { describe, expect, it } from 'vitest'
import { refreshAuras } from './aura.ts'
import { createBattleState, effectiveDotStacks, effectiveStat } from './state.ts'
import type { AuraDef, BattleState, BoardCard, Card, LogMessage, Skill } from './types.ts'

/** 非空断言（`noUncheckedIndexedAccess` 下的测试装配便利） */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('测试装配错误：期望存在，实际得到 undefined')
  return value
}

/** 造一张卡：只写测试关心的字段 */
function cardOf(id: string, stats: Readonly<Record<string, number>>, aura?: AuraDef): Card {
  return {
    id,
    name: id,
    version: 1,
    size: 'small',
    cooldown: 300,
    rarity: 'common',
    stats,
    ...(aura === undefined ? {} : { aura }),
  }
}

function setup(
  cardsA: readonly Card[],
  cardsB: readonly Card[] = [],
  skillsA: readonly Skill[] = [],
): { readonly state: BattleState; readonly emit: (message: LogMessage) => void } {
  const state = createBattleState({
    seed: 42,
    playerAName: 'A',
    playerBName: 'B',
    boardA: cardsA.map((card, index) => ({ card, slot: index + 1 })),
    boardB: cardsB.map((card, index) => ({ card, slot: index + 1 })),
    ...(skillsA.length === 0 ? {} : { skillsA }),
  })
  return { state, emit: (): void => {} }
}

function boardCardOf(state: BattleState, side: 1 | 2, index: number): BoardCard {
  return need(state.players[side].board[index])
}

function skillOf(aura: AuraDef, stats: Readonly<Record<string, number>> = {}): Skill {
  return { id: 'gem', name: '宝石', version: 1, rarity: 'bronze', stats, actions: [], aura }
}

describe('光环数额写表达式', () => {
  it('{ ref: self.atk } ⇒ 数额 = 来源卡攻击；选中目标各自吃一份', () => {
    const { state, emit } = setup(
      [cardOf('buffer', { atk: 4 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: { ref: 'self.atk' } }],
      })],
      [cardOf('foe', { atk: 10 })],
    )
    refreshAuras(state, emit)

    // 己方（含来源自己）：4 + 4 = 8；敌方不受 own 视角影响
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(8)
    expect(effectiveStat(state, boardCardOf(state, 2, 0), 'atk')).toBe(10)
  })

  it('{ add: [...] } ⇒ 逐项求和（引用 + 字面量可以混写）', () => {
    const { state, emit } = setup([
      cardOf('buffer', { atk: 3, heal: 2 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'shield', amount: { add: [{ ref: 'self.atk' }, { ref: 'self.heal' }, 1] } }],
      }),
    ])
    refreshAuras(state, emit)

    // 3 + 2 + 1 = 6（来源自己没有 shield 基础值）
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'shield')).toBe(6)
  })

  it('数额 = 自身攻击时**逐帧重建结果稳定**（表达式不读光环层，否则会 20 → 30 → 40 涨上去）', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: { ref: 'self.atk' } }],
      }),
    ])

    refreshAuras(state, emit)
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(20)

    refreshAuras(state, emit)
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(20)

    refreshAuras(state, emit)
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(20)
  })

  it('玩家侧 DOT 的数额也可以写表达式', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 3 }, {
        select: 'own_player',
        apply: [{ stat: 'regen', amount: { ref: 'self.atk' } }],
      }),
    ])
    refreshAuras(state, emit)

    expect(effectiveDotStacks(state, state.players[1], 'regen')).toBe(3)
  })

  it('技能光环（无来源卡）从技能自带 stats 取 self.<stat>', () => {
    const { state, emit } = setup(
      [cardOf('x', { atk: 1 })],
      [],
      [skillOf({ select: 'own_player', apply: [{ stat: 'regen', amount: { ref: 'self.atk' } }] }, { atk: 5 })],
    )
    refreshAuras(state, emit)

    expect(effectiveDotStacks(state, state.players[1], 'regen')).toBe(5)
  })

  it('台账记的是**求值后**的数；两次重建逐条一致（确定性）', () => {
    const { state, emit } = setup([
      cardOf('buffer', { atk: 6 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: { ref: 'self.atk' } }],
      }),
    ])

    refreshAuras(state, emit)
    const first = state.auras.entries.map((entry) => `${entry.stat}=${String(entry.amount)}`)
    refreshAuras(state, emit)
    const second = state.auras.entries.map((entry) => `${entry.stat}=${String(entry.amount)}`)

    expect(first).toEqual(['atk=6'])
    expect(second).toEqual(first)
  })

  it('光环里引用事件参数 ⇒ 运行期抛"事件参数不存在"（静态校验另有拦截）', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 1 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: { var: 'amount' } }],
      }),
    ])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/事件参数 amount 不存在/)
  })
})
