// 主动行动的**三级节拍**测试（1cs 记账 / 5cs 结算 / 20cs 配额）

// 这一组用例钉住《待办》§七 的 12 条口径（改主循环时序之前先读它们）：
//   ① **条满只记账**：那一 cs 归零 + `actionCount+1` + 广播内部事件 `active_action`，
//      **效果不在这一 cs 结算**（`after_action` 出现在**释放那一 cs**）；
//   ② **5cs 处理点**：效果只在 `timeCs % EFFECT_TICK_CS === 0` 的 cs 结算
//      ⇒ 落在非网格 cs 的记账，会在**下一个处理点**结算（最多晚 0.04s）；
//   ③ **20cs 只当配额**：每触发器每窗口至多释放一条，多出来的**顺延**到后续窗口
//      （`multicast: N` = N 条 ⇒ 第 2 条起顺延）；
//   ④ **来源卡先死照常结算**：记账后、释放前被打死，效果仍然落地；
//   ⑤ 内部事件 `active_action` **进帧快照**（表现层的"条归零"锚点）。
//
// 约束：不依赖 Vitest 快照序列化，断言一律写具体 cs / 具体来源键。
import { describe, expect, it } from 'vitest'
import { runBattle } from './tick.ts'
import type { Ability, BattleOptions, Card, FrameEvent, FrameSnapshot, Skill } from './types.ts'

/** 造一张卡：只写测试关心的字段，其余取最小合法值（`cooldown` 单位 = cs） */
function cardOf(
  id: string,
  cooldown: number,
  abilities: readonly Ability[] = [],
  stats: Readonly<Record<string, number>> = { atk: 1 },
): Card {
  return { id, name: id, version: 1, size: 'small', cooldown, rarity: 'common', stats, abilities: [...abilities] }
}

/**
 * 只治疗自己的主动效果。
 * **刻意不造成任何伤害**：这样"谁也没死"，对局必然跑到超时，
 * 观察前几秒的时序时不必担心某一方提前收场。
 */
function healAbility(): Ability {
  return {
    id: 1,
    kind: 'active',
    actions: [{ do: 'heal_player', target: 'own_player', amount: { ref: 'self.heal' } }],
  }
}

/** 治疗量 1 的主动卡（`stats.heal` 供 `{ ref: 'self.heal' }` 取用） */
function healer(id: string, cooldown: number): Card {
  return cardOf(id, cooldown, [healAbility()], { atk: 1, heal: 1 })
}

function battle(cardsA: readonly Card[], cardsB: readonly Card[], extra: Partial<BattleOptions> = {}) {
  return runBattle({
    seed: 42,
    playerAName: 'A',
    playerBName: 'B',
    boardA: cardsA.map((card, index) => ({ card, slot: index + 1 })),
    boardB: cardsB.map((card, index) => ({ card, slot: index + 1 })),
    captureFrames: true,
    ...extra,
  })
}

/** 全局的帧事件（按帧序、帧内按发生序拼起来） */
function allEvents(result: ReturnType<typeof runBattle>): FrameEvent[] {
  return result.frames.flatMap((frame) => frame.events)
}

/** 某张卡（来源键 = `active:<实例id>`）全局的 `after_action` 记录，按发生顺序 */
function activeEventsOf(result: ReturnType<typeof runBattle>, instanceId: string): FrameEvent[] {
  return allEvents(result).filter(
    (entry) => entry.event === 'after_action' && entry.sourceKey === `active:${instanceId}`,
  )
}

/** 某张卡的全部**行动记账**时刻（内部事件 `active_action` 的 cs） */
function recordCsOf(result: ReturnType<typeof runBattle>, instanceId: string): number[] {
  return allEvents(result)
    .filter((entry) => entry.event === 'active_action' && entry.sourceKey === `active:${instanceId}`)
    .map((entry) => entry.cs)
}

/** 取 `timeCs` 等于给定值的帧快照 */
function frameAt(result: ReturnType<typeof runBattle>, timeCs: number): FrameSnapshot {
  const found = result.frames.find((frame) => frame.timeCs === timeCs)
  if (found === undefined) throw new Error(`测试装配错误：没有 timeCs = ${String(timeCs)} 的帧快照`)
  return found
}

/** 帧号 = ⌈cs ÷ 20⌉（`triggerFrame` 在 `(timeCs + 1) % 20 === 0` 时自增 ⇒ cs 20–39 才是帧 1） */
function frameOfCs(cs: number): number {
  return Math.ceil(cs / 20)
}

describe('记账与结算（1cs 记账 / 5cs 处理点）', () => {
  it('落在 5cs 网格上的条满：记账与效果都在同一 cs（cs 150），快照 cs 160 已重新走到 10', () => {
    const result = battle([healer('slow', 150)], [])

    // 记账（`active_action`）与结算（`after_action`）都在 cs 150 —— 150 是 5 的倍数
    expect(recordCsOf(result, '1-slow-1').slice(0, 2)).toEqual([150, 300])
    expect(activeEventsOf(result, '1-slow-1')[0]?.cs).toBe(150)
    // 归零与记账同一 cs ⇒ 到 cs 160 恰好又走了 10cs
    expect(frameAt(result, 160).cards.find((card) => card.instanceId === '1-slow-1')?.gaugeCs).toBe(10)
  })

  it('落在非网格 cs 的条满：记账在 cs 152，效果在**下一个处理点** cs 155', () => {
    const result = battle([healer('odd', 152)], [])

    expect(recordCsOf(result, '1-odd-1').slice(0, 2)).toEqual([152, 304])
    expect(activeEventsOf(result, '1-odd-1').slice(0, 2).map((entry) => entry.cs)).toEqual([155, 305])
    // 归零发生在**记账**那一 cs（152）⇒ 到 160 走了 8cs
    expect(frameAt(result, 160).cards.find((card) => card.instanceId === '1-odd-1')?.gaugeCs).toBe(8)
  })

  it('内部事件 active_action 进帧快照（表现层的"条归零"锚点）', () => {
    const result = battle([healer('anchor', 150)], [])
    const anchor = allEvents(result).filter(
      (entry) => entry.event === 'active_action' && entry.sourceKey === 'active:1-anchor-1' && entry.cs === 150,
    )
    expect(anchor).toHaveLength(1)
    // 与 `after_action` 是**两个**事件（前者=记账、后者=结算完）
    const settled = allEvents(result).filter(
      (entry) => entry.event === 'after_action' && entry.sourceKey === 'active:1-anchor-1' && entry.cs === 150,
    )
    expect(settled).toHaveLength(1)
  })

  it('同一处理点多张卡：按 loadOrder 升序依次结算（A 方两张都在 B 方那张之前）', () => {
    const result = battle([healer('a1', 130), healer('a2', 130)], [healer('b1', 130)])

    for (const instanceId of ['1-a1-1', '1-a2-2', '2-b1-1']) {
      expect(activeEventsOf(result, instanceId)[0]?.cs).toBe(130)
    }
    const firstThree = allEvents(result)
      .filter((entry) => entry.event === 'after_action')
      .slice(0, 3)
      .map((entry) => entry.sourceKey)
    expect(firstThree).toEqual(['active:1-a1-1', 'active:1-a2-2', 'active:2-b1-1'])
  })

  it('纯被动（cooldown: -1）与冰冻的卡永不记账：卡面写了主动效果也不动', () => {
    const freezer: Skill = {
      id: 'freezer',
      name: '冰封',
      version: 1,
      rarity: 'bronze',
      stats: {},
      trigger: { event: 'battle_start' },
      actions: [{ do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', seconds: 179 }],
    }
    const result = battle([cardOf('pure', -1, [healAbility()], { atk: 1, heal: 1 })], [healer('frozen', 300)], {
      skillsA: [freezer],
    })

    expect(result.state.finished).toBe(true) // 跑到了超时收场，而不是中途抛错
    expect(recordCsOf(result, '1-pure-1')).toEqual([])
    expect(recordCsOf(result, '2-frozen-1')).toEqual([])
    expect(activeEventsOf(result, '1-pure-1')).toEqual([])
    expect(activeEventsOf(result, '2-frozen-1')).toEqual([])
    // 冰冻的卡在快照里周期为 null ——"没有行动条"与"永不行动"是同一件事
    expect(frameAt(result, 20).cards.find((card) => card.instanceId === '2-frozen-1')?.periodCs).toBeNull()
  })
})

describe('限流：20cs 只当配额', () => {
  it('charge 把自己反复推满：同一触发器每 20cs 至多释放一条（记 300/301 ⇒ 释放 300/320）', () => {
    // charger：周期 300cs，每次行动给自己方全体充能 3.5s（350cs）——大于一个周期 ⇒ 会把自己又推满
    const charger = cardOf(
      'charger',
      300,
      [{ id: 1, kind: 'active', actions: [{ do: 'charge', target: 'all_own_cards', seconds: 3.5 }] }],
      { atk: 1 },
    )
    // charged：周期 500cs —— 靠自己走条要等到 cs 500；靠上面那次充能才会在 cs 305 动
    const charged = healer('charged', 500)
    // B 方在 cs 600 一击打死 A（atk 400 ≥ 300）：把对局收在**窗口 300–319 完整收尾之后**
    // （若在 cs 320 就打死，那一帧的 capture 到不了 ⇒ 该窗口的事件不会进帧快照，断言会读不到）
    const finisher = cardOf(
      'finisher',
      600,
      [
        {
          id: 1,
          kind: 'active',
          actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
        },
      ],
      { atk: 400 },
    )
    const result = battle([charger, charged], [finisher], { includeText: false })

    // ① charger：cs 300 记账并结算；被自己充能又推满（记账在 301）⇒ 配额已用，顺延到**下一个窗口**
    expect(recordCsOf(result, '1-charger-1').slice(0, 2)).toEqual([300, 301])
    expect(activeEventsOf(result, '1-charger-1').slice(0, 2).map((entry) => entry.cs)).toEqual([300, 320])
    // ② 同一触发帧（帧 15 = cs 300–319）里只释放了一条
    const inFrame15 = activeEventsOf(result, '1-charger-1').filter((entry) => frameOfCs(entry.cs) === 15)
    expect(inFrame15).toHaveLength(1)
    // ③ 被充能的那张：**下个 cs 记账**（301）、**下个处理点结算**（305）
    expect(recordCsOf(result, '1-charged-2')[0]).toBe(301)
    expect(activeEventsOf(result, '1-charged-2')[0]?.cs).toBe(305)
  })

  it('multicast: N = N 条：同一窗口只放第 1 条，第 2 条顺延到下一个窗口', () => {
    const twin: Card = { ...healer('twin', 100), multicast: 2 }
    const result = battle([twin], [], { includeText: false })

    // cs 100 记账 ⇒ 两条释放条目；第 1 条在 cs 100 放，第 2 条等下一个窗口（cs 120）
    expect(recordCsOf(result, '1-twin-1').slice(0, 1)).toEqual([100])
    expect(activeEventsOf(result, '1-twin-1').slice(0, 4).map((entry) => entry.cs)).toEqual([100, 120, 200, 220])
    // 帧 5 与帧 6 各一条（不是同一处理点连发两条）
    expect(activeEventsOf(result, '1-twin-1').filter((entry) => frameOfCs(entry.cs) === 5)).toHaveLength(1)
    expect(activeEventsOf(result, '1-twin-1').filter((entry) => frameOfCs(entry.cs) === 6)).toHaveLength(1)
  })

  it('被动 / 技能在结算里推满的卡：下个 cs 记账、下个处理点结算', () => {
    // striker：周期 100cs，每次行动无条件广播 after_action（首次在 cs 100 = 窗口 5 的边界）
    const striker = cardOf(
      'striker',
      100,
      [
        {
          id: 1,
          kind: 'active',
          actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
        },
      ],
      { atk: 1 },
    )
    // ally：周期 300cs；被动听 after_action ⇒ 给自己充能 4s（400cs）
    const ally = cardOf(
      'ally',
      300,
      [
        {
          id: 1,
          kind: 'passive',
          trigger: { event: 'after_action' },
          actions: [{ do: 'charge', target: 'self', seconds: 4 }],
        },
        { id: 2, kind: 'active', actions: [{ do: 'heal_player', target: 'own_player', amount: { ref: 'self.heal' } }] },
      ],
      { atk: 1, heal: 1 },
    )
    const result = battle([striker, ally], [], { includeText: false })

    // cs 100：striker 结算并广播 after_action → 同一处理点里 ally 的被动释放（+400cs）⇒ ally 满条
    // ⇒ **下个 cs（101）记账**、**下个处理点（105）结算**
    expect(recordCsOf(result, '1-ally-2')[0]).toBe(101)
    expect(activeEventsOf(result, '1-ally-2')[0]?.cs).toBe(105)
  })
})

describe('来源卡在"记账 → 释放"之间被打死', () => {
  it('效果照常结算（"行动已记账 ⇒ 效果落地"）', () => {
    // 双方都是 152cs：同在 cs 152 记账、同在 cs 155 释放
    const saboteur = cardOf('saboteur', 152, [
      { id: 1, kind: 'active', actions: [{ do: 'destroy', target: 'all_enemy_cards' }] },
    ])
    const victim = cardOf('victim', 152, [
      {
        id: 1,
        kind: 'active',
        actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
      },
    ], { atk: 10 })

    const result = battle([saboteur], [victim], { includeText: false })

    // A 方 loadOrder 0 先结算 ⇒ victim 先被打死；但 victim 的行动已记账，故仍要落地
    expect(recordCsOf(result, '2-victim-1')[0]).toBe(152)
    expect(activeEventsOf(result, '2-victim-1').map((entry) => entry.cs)).toEqual([155])
    // 伤害真的打出去了：A 掉 10 点
    expect(result.state.players[1].hp).toBe(290)
  })
})
