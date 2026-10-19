// 行动条口径测试

// 钉住三条口径（：
//   ① 充满周期 = `max(1s, round(cooldown_cs × cdp ÷ 100 ÷ 速度倍率))`；速度倍率 = 基础 1 × 加速 2 / 减速 0.5 / 冰冻 0；
//   ② **周期变化时保比例** —— 加速 / 减速的生效与到期按 `新周期 ÷ 旧周期` 缩放 `gaugeCs`
//      （`gauge ÷ period` 不变 ⇒ 只有斜率变化、没有跳变）；**冰冻的两端都不缩放**（进度原样保留）；
//   ③ **消费 = 满即归零 + 余量结转** —— 只减一个充满周期，多出的部分留作下一轮的起点。
import { describe, expect, it } from 'vitest'
import { applyCardStatus } from './primitives.ts'
import { actionPeriodCs, consumeActionBar, createBattleState, pruneCardStatuses } from './state.ts'
import type { BoardCard, Card, PlayerState } from './types.ts'

/** 造一张卡（`cooldown` 单位是 cs —— 与 YAML 读入层换算后的口径一致） */
function cardOf(cooldown: number): Card {
  return { id: 'testCard', name: 'testCard', version: 1, size: 'small', cooldown, rarity: 'common', stats: { atk: 1 } }
}

/** 建一个只放这一张卡的状态，返回玩家与那张 `BoardCard` */
function setup(cooldown: number): { readonly player: PlayerState; readonly boardCard: BoardCard } {
  const state = createBattleState({
    seed: 1,
    playerAName: 'A',
    playerBName: 'B',
    boardA: [{ card: cardOf(cooldown), slot: 1 }],
    boardB: [],
  })
  const player = state.players[1]
  const boardCard = player.board[0]
  if (boardCard === undefined) throw new Error('测试装配错误：boardA 的卡没建出来')
  return { player, boardCard }
}

/** 让某个状态立即到期（先递减到 0，再走移除） */
function expireStatuses(player: PlayerState, boardCard: BoardCard): void {
  for (const status of boardCard.statuses) status.remainingCs = 0
  pruneCardStatuses(player)
}

describe('充满周期（cs）', () => {
  it('基础周期 = cooldown（cdp 缺省 100、速度缺省 1），且**钳到 ≥ 1s**', () => {
    expect(actionPeriodCs(setup(200).boardCard)).toBe(200)
    expect(actionPeriodCs(setup(50).boardCard)).toBe(100)
  })
})

describe('周期变化时保比例（加速 / 减速）', () => {
  it('加速生效：按 新周期 ÷ 旧周期 缩放，比例不变', () => {
    const { boardCard } = setup(200)
    boardCard.gaugeCs = 60 // 60 / 200 = 0.30
    applyCardStatus(boardCard, 'haste', 200)
    expect(actionPeriodCs(boardCard)).toBe(100)
    expect(boardCard.gaugeCs).toBe(30) // 30 / 100 = 0.30
  })

  it('加速到期：反向缩放，比例不变', () => {
    const { player, boardCard } = setup(200)
    boardCard.gaugeCs = 60
    applyCardStatus(boardCard, 'haste', 100)
    expect(boardCard.gaugeCs).toBe(30)
    expireStatuses(player, boardCard)
    expect(actionPeriodCs(boardCard)).toBe(200)
    expect(boardCard.gaugeCs).toBe(60)
  })

  it('减速生效：周期 ×2、gauge ×2（比例不变）', () => {
    const { boardCard } = setup(200)
    boardCard.gaugeCs = 60
    applyCardStatus(boardCard, 'slow', 200)
    expect(actionPeriodCs(boardCard)).toBe(400)
    expect(boardCard.gaugeCs).toBe(120)
  })

  it('同类状态再施加 ⇒ **时长叠加**（不取 max、不覆盖）；周期与 gauge 不动', () => {
    const { boardCard } = setup(200)
    applyCardStatus(boardCard, 'haste', 200)
    boardCard.gaugeCs = 30
    applyCardStatus(boardCard, 'haste', 400)
    expect(actionPeriodCs(boardCard)).toBe(100)
    expect(boardCard.gaugeCs).toBe(30)
    // 只剩一条同类状态，剩余时长 = 200 + 400
    expect(boardCard.statuses).toHaveLength(1)
    expect(boardCard.statuses[0]?.remainingCs).toBe(600)
  })

  it('1s 下限吃掉加速：周期没变 ⇒ 不缩放', () => {
    const { boardCard } = setup(100) // round(100 ÷ 2) = 50 → 钳到 100
    boardCard.gaugeCs = 40
    applyCardStatus(boardCard, 'haste', 200)
    expect(actionPeriodCs(boardCard)).toBe(100)
    expect(boardCard.gaugeCs).toBe(40)
  })
})

describe('消费 = 满即归零 + 余量结转', () => {
  it('只减一个充满周期：余量保留，作为下一轮的起点（不丢帧）', () => {
    const { boardCard } = setup(200)
    boardCard.gaugeCs = 250 // 满条（200）之后又走了 50cs
    consumeActionBar(boardCard)
    expect(boardCard.gaugeCs).toBe(50)
  })

  it('恰好满条 ⇒ 归零', () => {
    const { boardCard } = setup(200)
    boardCard.gaugeCs = 200
    consumeActionBar(boardCard)
    expect(boardCard.gaugeCs).toBe(0)
  })

  it('周期为 Infinity（纯被动 / 冰冻）⇒ 直接归零，不产生负值', () => {
    const { boardCard } = setup(-1)
    boardCard.gaugeCs = 7
    consumeActionBar(boardCard)
    expect(boardCard.gaugeCs).toBe(0)
  })
})

describe('冰冻不缩放（进度原样保留）', () => {
  it('进入冰冻：周期 → Infinity，gauge 不动', () => {
    const { boardCard } = setup(200)
    boardCard.gaugeCs = 60
    applyCardStatus(boardCard, 'freeze', 200)
    expect(actionPeriodCs(boardCard)).toBe(Number.POSITIVE_INFINITY)
    expect(boardCard.gaugeCs).toBe(60)
  })

  it('解冻：周期回到有限值，gauge 仍不动（从原处继续）', () => {
    const { player, boardCard } = setup(200)
    boardCard.gaugeCs = 60
    applyCardStatus(boardCard, 'freeze', 100)
    expireStatuses(player, boardCard)
    expect(actionPeriodCs(boardCard)).toBe(200)
    expect(boardCard.gaugeCs).toBe(60)
  })

  it('没有状态到期时 prune 是空操作', () => {
    const { player, boardCard } = setup(200)
    applyCardStatus(boardCard, 'haste', 500)
    const before = boardCard.gaugeCs
    pruneCardStatuses(player)
    expect(boardCard.gaugeCs).toBe(before)
  })
})
