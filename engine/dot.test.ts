// 持续效果结算口径测试

// 这一组测试钉住四条口径（改 advanceDots 之前先读它们）：
//   ① **相位 = 全局 cs 网格**：灼烧 50cs、剧毒 / 再生 100cs（= 每 5 个触发帧的末尾），与施加时刻无关；
//   ② **合并粒度 = 玩家 × 种类**：同种多个实例合成一次结算；
//   ③ **剧毒 + 再生合并为一次净值结算**：先毒后再生，净值为负扣血（无视护盾）、为正回血、为 0 仍算一次；
//   ④ **再生跳不净化**：回血不按 0.05 削减灼烧 / 剧毒层数（那是 heal_player 原语的口径）。
import { describe, expect, it } from 'vitest'
import { advanceDots, applyDot } from './primitives.ts'
import { createBattleState } from './state.ts'
import { runBattle } from './tick.ts'
import type { BattleState, Card, PlayerState } from './types.ts'

/** 空盘对局的最小状态（只用来直接调 advanceDots） */
function setup(): { state: BattleState; player: PlayerState } {
  const state = createBattleState({ seed: 1, playerAName: 'A', playerBName: 'B', boardA: [], boardB: [] })
  const player = state.players[1]
  player.hp = 200
  player.maxHp = 300
  return { state, player }
}

describe('持续效果结算相位（全局 cs 网格）', () => {
  it('灼烧只在 50cs 的整数倍结算，与施加时刻无关', () => {
    const { state, player } = setup()
    applyDot(player, 'burn', 5, 'src')

    state.timeCs = 40
    expect(advanceDots(state, player)).toHaveLength(0)

    state.timeCs = 50
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.dots).toEqual(['burn'])
    expect(effects[0]?.burnStacks).toBe(5) // 结算前读数
    expect(effects[0]?.amount).toBe(5)
    expect(player.dots[0]?.stacks).toBeCloseTo(4) // 跳变后逐实例 ×0.8

    state.timeCs = 99 // 99 不是 50 的整数倍 ⇒ 不结算
    expect(advanceDots(state, player)).toHaveLength(0)
  })

  it('剧毒 / 再生只在 100cs 的整数倍结算（= 每 5 个触发帧的末尾）', () => {
    const { state, player } = setup()
    applyDot(player, 'poison', 4, 'src')

    state.timeCs = 80
    expect(advanceDots(state, player)).toHaveLength(0)

    state.timeCs = 100
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.dots).toEqual(['poison'])
    expect(effects[0]?.poisonStacks).toBe(4)
    expect(effects[0]?.amount).toBe(4)
  })

  it('同一玩家同种类的多个实例合并成一次结算', () => {
    const { state, player } = setup()
    applyDot(player, 'poison', 2, 'a')
    applyDot(player, 'poison', 3, 'b')

    state.timeCs = 100
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.poisonStacks).toBe(5)
    expect(effects[0]?.amount).toBe(5)
  })
})

describe('剧毒 / 再生净值结算（先毒后再生）', () => {
  it('净值为负 ⇒ 一次扣血，且无视护盾', () => {
    const { state, player } = setup()
    player.shield = 100
    applyDot(player, 'poison', 5, 'a')
    applyDot(player, 'regen', 3, 'b')

    state.timeCs = 100
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.dots).toEqual(['poison', 'regen'])
    expect(effects[0]?.kind).toBe('damage')
    expect(effects[0]?.amount).toBe(2) // 5 - 3
    expect(effects[0]?.absorbed).toBe(0) // 剧毒无视护盾
    expect(player.shield).toBe(100)
    expect(player.hp).toBe(198)
  })

  it('净值为正 ⇒ 一次回血', () => {
    const { state, player } = setup()
    applyDot(player, 'poison', 3, 'a')
    applyDot(player, 'regen', 5, 'b')

    state.timeCs = 100
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.kind).toBe('heal')
    expect(effects[0]?.amount).toBe(2) // 5 - 3
    expect(player.hp).toBe(202)
  })

  it('净值为 0 ⇒ 血量不变，但仍算一次结算', () => {
    const { state, player } = setup()
    applyDot(player, 'poison', 4, 'a')
    applyDot(player, 'regen', 4, 'b')

    state.timeCs = 100
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(1)
    expect(effects[0]?.kind).toBe('heal')
    expect(effects[0]?.amount).toBe(0)
    expect(player.hp).toBe(200)
  })

  it('maxHp 截断按**净值**算（不是"先按再生回满、再按剧毒扣"）', () => {
    const { state, player } = setup()
    player.hp = 299 // 只差 1 点满血
    applyDot(player, 'poison', 5, 'a')
    applyDot(player, 'regen', 3, 'b')

    state.timeCs = 100
    const effects = advanceDots(state, player)
    // 净值 = 3 - 5 = -2 ⇒ 直接扣 2 点；若先回血（最多 1 点）再扣 5 点，结果会是 295
    expect(effects[0]?.kind).toBe('damage')
    expect(effects[0]?.amount).toBe(2)
    expect(player.hp).toBe(297)
  })

  it('再生跳不净化：回血不削减灼烧层数（只按自己的 ×0.8 衰减）', () => {
    const { state, player } = setup()
    applyDot(player, 'burn', 20, 'a')
    applyDot(player, 'regen', 10, 'b')

    state.timeCs = 100 // 灼烧（50 的倍数）与再生（100 的倍数）同时到点
    const effects = advanceDots(state, player)
    expect(effects).toHaveLength(2)
    expect(effects[0]?.dots).toEqual(['burn'])
    expect(effects[1]?.dots).toEqual(['regen'])
    expect(effects[1]?.amount).toBe(10)
    // 20 × 0.8 = 16；若走了净化（10 × 0.05 = 0.5）会是 15.5
    expect(player.dots[0]?.stacks).toBeCloseTo(16)
  })
})

describe('毒 / 再生同时跳（每 5 个触发帧的末尾）', () => {
  it('同一玩家身上的毒与再生落在同一个 cs，且该 cs 是整秒', () => {
    const selfDotter: Card = {
      id: 'selfDotter',
      name: 'selfDotter',
      version: 1,
      size: 'small',
      cooldown: 300,
      rarity: 'common',
      stats: { atk: 1, poison: 3, regen: 5 },
      abilities: [
        {
          id: 1,
          kind: 'active',
          actions: [
            { do: 'gain_stat', stat: 'poison', amount: { ref: 'self.poison' }, target: 'own_player' },
            { do: 'gain_stat', stat: 'regen', amount: { ref: 'self.regen' }, target: 'own_player' },
          ],
        },
      ],
    }

    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [{ card: selfDotter, slot: 1 }],
      boardB: [],
      captureFrames: true,
      hpB: 5000,
      maxHpB: 5000,
    })
    const events = result.frames.flatMap((frame) => frame.events)
    const poisonCs = events
      .filter((entry) => entry.event === 'on_poison_tick' && entry.playerId === 1)
      .map((entry) => entry.cs)
    const regenCs = events
      .filter((entry) => entry.event === 'on_regen_tick' && entry.playerId === 1)
      .map((entry) => entry.cs)

    expect(poisonCs.length).toBeGreaterThan(0)
    expect(regenCs).toEqual(poisonCs) // 同时跳
    for (const cs of poisonCs) expect(cs % 100).toBe(0) // 落在整秒（第 5 个触发帧的末尾）
  })
})
