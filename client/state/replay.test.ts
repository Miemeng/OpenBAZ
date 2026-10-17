// 回放纯逻辑测试：游标推进 / 步进 / 跳转 / 飘字合并 / 触发高亮 / 行动条分母。

// 三组断言各自钉住一条不变式：
//   1. **游标可复现**：同样的真实毫秒 + 同样的倍速 ⇒ 同样的帧步长（余量不丢、到末帧自停）；
//   2. **飘字口径**：同帧同目标同色调合并求和、无目标事件不产飘字、非求和色调取最后一条；
//   3. **行动条**：纯被动卡不画条、冰冻向前沿用最近一个非 null 周期；**"满即归零"那一窗口**按
//      "归零前按速率走满 → 归零那一刻归 0 → 之后重新走"补帧（不倒退、帧末与下一帧读数对齐）。
import { describe, expect, it } from 'vitest'
import type { FrameCard, FrameEvent, FrameSnapshot, FrameStatus } from '../../engine/types.ts'
import {
  REPLAY_ANIM,
  advanceReplay,
  buildFloaters,
  buildHighlights,
  frameFraction,
  gaugeRatioAt,
  gaugeViewOf,
  lastIndexOf,
  lerp,
  replayProgress,
  replayStart,
  seekReplay,
  setPlayingReplay,
  setSpeedReplay,
  shieldShownAt,
  stepReplay,
} from './replay.ts'

/** 造一个事件（只写测试关心的字段） */
function ev(
  cs: number,
  event: string,
  sourceKey: string,
  targetKey: string,
  amount?: number,
  playerId?: 1 | 2,
): FrameEvent {
  return {
    cs,
    event,
    sourceKey,
    targetKey,
    ...(amount === undefined ? {} : { amount }),
    ...(playerId === undefined ? {} : { playerId }),
  }
}

/** 造一张帧快照（只为行动条口径服务：玩家 / 光环留空；`timeCs` = 该帧结束时的全局帧数） */
function frameOf(
  cards: readonly FrameCard[],
  events: readonly FrameEvent[] = [],
  timeCs = 0,
): FrameSnapshot {
  return { triggerFrame: 0, timeCs, finished: false, winner: null, players: [], cards, auras: [], events }
}

/** 造一张卡的帧读数 */
function fcard(
  instanceId: string,
  slot: number,
  gaugeCs: number,
  periodCs: number | null,
  statuses: readonly FrameStatus[] = [],
): FrameCard {
  return {
    instanceId,
    owner: 1,
    slot,
    gaugeCs,
    periodCs,
    actionCount: 0,
    destroyed: false,
    stats: [],
    speed: 1,
    statuses,
  }
}

describe('回放游标', () => {
  it('1× 播放按一帧时长推进，不足一帧的余量留到下一拍', () => {
    const total = 5
    let state = setPlayingReplay(replayStart(), true, total)
    expect(state.playing).toBe(true)
    expect(state.index).toBe(0)

    // 恰好一帧
    state = advanceReplay(state, REPLAY_ANIM.frameMs, total)
    expect(state.index).toBe(1)
    expect(state.carryMs).toBeCloseTo(0)

    // 90ms 不够一帧：只攒余量，游标不动
    state = advanceReplay(state, 90, total)
    expect(state.index).toBe(1)
    expect(state.carryMs).toBeCloseTo(90)

    // 再 110ms：两拍凑成一帧
    state = advanceReplay(state, 110, total)
    expect(state.index).toBe(2)
    expect(state.carryMs).toBeCloseTo(0)
  })

  it('倍速只改播放间隔：2× 是半帧时长一帧，0.5× 是两倍帧时长一帧', () => {
    const total = 9
    const at2x = advanceReplay(setSpeedReplay(setPlayingReplay(replayStart(), true, total), 2), REPLAY_ANIM.frameMs / 2, total)
    expect(at2x.index).toBe(1)

    const atHalf = advanceReplay(
      setSpeedReplay(setPlayingReplay(replayStart(), true, total), 0.5),
      REPLAY_ANIM.frameMs * 2,
      total,
    )
    expect(atHalf.index).toBe(1)
  })

  it('到末帧自动停；在末帧再点播放 = 从头重放', () => {
    const total = 3
    let state = setPlayingReplay(replayStart(), true, total)
    state = advanceReplay(state, REPLAY_ANIM.frameMs * 10, total)
    expect(state.index).toBe(lastIndexOf(total))
    expect(state.playing).toBe(false)

    state = setPlayingReplay(state, true, total)
    expect(state.index).toBe(0)
    expect(state.playing).toBe(true)
  })

  it('暂停时推进不生效（时钟停了游标就不动）', () => {
    const state = replayStart()
    expect(advanceReplay(state, 100000, 20)).toBe(state)
  })

  it('步进必然暂停，并在两端夹住', () => {
    const total = 4
    let state = setPlayingReplay(replayStart(), true, total)
    state = stepReplay(state, 1, total)
    expect(state.playing).toBe(false)
    expect(state.index).toBe(1)
    expect(stepReplay(state, -5, total).index).toBe(0)
    expect(stepReplay(state, 99, total).index).toBe(lastIndexOf(total))
  })

  it('跳转夹住范围并清掉余量；进度按末帧归一', () => {
    const total = 5
    const state = seekReplay(setPlayingReplay(replayStart(), true, total), 99, total)
    expect(state.index).toBe(lastIndexOf(total))
    expect(state.carryMs).toBeCloseTo(0)
    expect(replayProgress(state, total)).toBeCloseTo(1)
    expect(replayProgress(replayStart(), total)).toBeCloseTo(0)
    // 只有一帧（或没有帧）时进度恒为 0，不除零
    expect(replayProgress(replayStart(), 1)).toBe(0)
    expect(replayProgress(replayStart(), 0)).toBe(0)
  })
})

describe('帧事件 → 飘字', () => {
  it('同帧同目标同色调合并求和，明细留在 parts 里', () => {
    const floaters = buildFloaters([
      ev(10, 'on_player_damaged', 'active:1-a-1', 'player:2', 8),
      ev(14, 'on_burn_tick', 'dot:burn@2', 'player:2', 4, 2),
    ])
    expect(floaters).toHaveLength(1)
    const floater = floaters[0]
    expect(floater?.tone).toBe('damage')
    expect(floater?.targetKey).toBe('player:2')
    expect(floater?.total).toBe(12)
    expect(floater?.parts).toHaveLength(2)
    expect(floater?.parts[1]?.dot).toBe('burn')
    // 排序键 = 该锚点最早发生时刻
    expect(floater?.cs).toBe(10)
  })

  it('不同目标 / 不同色调各自成条；无目标与无金额事件不产飘字', () => {
    const floaters = buildFloaters([
      ev(1, 'battle_start', 'engine:battle_start', '-'),
      ev(2, 'on_player_damaged', 'active:1-a-1', 'player:2', 5),
      ev(3, 'on_player_healed', 'skill:s1', 'player:2', 3),
      ev(4, 'on_player_damaged', 'active:1-b-2', 'player:1', 7),
      ev(5, 'after_action', 'active:1-a-1', '-'),
    ])
    expect(floaters.map((item) => `${item.targetKey}|${item.tone}`)).toEqual([
      'player:2|damage',
      'player:2|heal',
      'player:1|damage',
    ])
  })

  it('状态类事件不可求和：取最后一条的时长', () => {
    const floaters = buildFloaters([
      ev(5, 'on_card_frozen', 'passive:1-a-1#1', 'card:1-a-1', 2),
      ev(6, 'on_card_frozen', 'passive:1-a-1#1', 'card:1-a-1', 1.5),
    ])
    expect(floaters).toHaveLength(1)
    expect(floaters[0]?.tone).toBe('status')
    expect(floaters[0]?.total).toBe(1.5)
    expect(floaters[0]?.parts).toHaveLength(2)
  })

  it('毒 / 再生同一 cs 的配对合成一条净值飘字（净值为负 ⇒ 伤害色）', () => {
    const floaters = buildFloaters([
      ev(100, 'on_poison_tick', 'dot:poison@1', 'player:1', 5, 1),
      ev(100, 'on_regen_tick', 'dot:regen@1', 'player:1', 3, 1),
    ])
    expect(floaters).toHaveLength(1)
    expect(floaters[0]?.tone).toBe('damage')
    expect(floaters[0]?.total).toBe(2) // 5 - 3
    expect(floaters[0]?.parts).toHaveLength(1)
    expect(floaters[0]?.parts[0]?.dot).toBe('poison')
  })

  it('毒 / 再生净值为正 ⇒ 治疗色；cs 不同则不合并', () => {
    const netted = buildFloaters([
      ev(100, 'on_poison_tick', 'dot:poison@1', 'player:1', 3, 1),
      ev(100, 'on_regen_tick', 'dot:regen@1', 'player:1', 5, 1),
    ])
    expect(netted).toHaveLength(1)
    expect(netted[0]?.tone).toBe('heal')
    expect(netted[0]?.total).toBe(2)
    expect(netted[0]?.parts[0]?.dot).toBe('regen')

    // cs 不同（不该发生，但契约上要稳）：各自成条，不合并
    const apart = buildFloaters([
      ev(100, 'on_poison_tick', 'dot:poison@1', 'player:1', 3, 1),
      ev(150, 'on_regen_tick', 'dot:regen@1', 'player:1', 5, 1),
    ])
    expect(apart.map((item) => item.tone)).toEqual(['damage', 'heal'])
  })
})

describe('帧事件 → 触发高亮', () => {
  it('来源键与目标键各自落到正确的锚点（持续效果只算一次）', () => {
    const highlights = buildHighlights([
      ev(1, 'after_action', 'active:1-a-1', '-'),
      ev(2, 'on_player_damaged', 'passive:2-b-3#2', 'player:1', 6, 1),
      ev(3, 'on_burn_tick', 'dot:burn@2', 'player:2', 3, 2),
      ev(4, 'battle_start', 'engine:battle_start', '-'),
      ev(5, 'after_action', 'skill:s1', '-'),
    ])
    expect(highlights.cards.get('1-a-1')).toBe(1)
    // 被动键要**剥掉 #<能力id>**（高亮对象是卡，不是能力）
    expect(highlights.cards.get('2-b-3')).toBe(1)
    expect(highlights.cards.get('engine:battle_start')).toBeUndefined()
    expect(highlights.skills.get('s1')).toBe(1)
    expect(highlights.players.get('1')).toBe(2)
    expect(highlights.players.get('2')).toBe(2)
    expect(highlights.dots.get('2:burn')).toBe(1)
  })

  it('卡牌事件也能点亮卡（目标是卡时）', () => {
    const highlights = buildHighlights([ev(1, 'on_card_destroyed', 'skill:s1', 'card:1-a-1', undefined, 1)])
    expect(highlights.cards.get('1-a-1')).toBe(1)
    expect(highlights.players.get('1')).toBe(1)
  })
})

describe('行动条口径', () => {
  it('周期正常时按比例填充', () => {
    const card = fcard('1-c-1', 1, 50, 200)
    const view = gaugeViewOf([frameOf([card])], 0, card)
    expect(view.periodCs).toBe(200)
    expect(view.ratio).toBeCloseTo(0.25)
    expect(view.ready).toBe(false)
  })

  it('满条 = 就绪；比例钳在 0–1', () => {
    const card = fcard('1-c-1', 1, 300, 200)
    const view = gaugeViewOf([frameOf([card])], 0, card)
    expect(view.ready).toBe(true)
    expect(view.ratio).toBe(1)
  })

  it('纯被动卡（周期恒 null、没有冰冻）不画条', () => {
    const card = fcard('1-p-2', 2, 0, null)
    const view = gaugeViewOf([frameOf([card])], 0, card)
    expect(view.ratio).toBeNull()
    expect(view.periodCs).toBeNull()
    expect(view.frozen).toBe(false)
  })

  it('冰冻沿用**最近一个非 null 周期**，画出冻住的进度', () => {
    const warm = fcard('1-c-1', 1, 120, 200)
    const frozen = fcard('1-c-1', 1, 120, null, [{ kind: 'freeze', remainingCs: 100 }])
    const frames = [frameOf([warm]), frameOf([frozen])]
    const view = gaugeViewOf(frames, 1, frozen)
    expect(view.frozen).toBe(true)
    expect(view.periodCs).toBe(200)
    expect(view.ratio).toBeCloseTo(0.6)
  })
})

describe('帧间补帧（插值）', () => {
  it('插值系数由"乘过倍速的余量"给出；暂停时为 0（画面严格等于该帧快照）', () => {
    const playing = advanceReplay(setPlayingReplay(replayStart(), true, 5), REPLAY_ANIM.frameMs / 2, 5)
    expect(frameFraction(playing)).toBeCloseTo(0.5)
    expect(frameFraction(replayStart())).toBe(0)
  })

  it('lerp 的两端就是原值（补帧不改变帧快照本身）', () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
    expect(lerp(10, 20, 0.5)).toBe(15)
  })

  it('行动条按"这一 cs 走到哪"给：没有归零事件时只在比例上单调插值（不倒退）', () => {
    // 本窗口没有 after_action ⇒ 走"只增不减"的比例插值：charge 上跳 / 周期变化都由它兜底
    const first = fcard('1-c-1', 1, 100, 200) // 0.50
    const second = fcard('1-c-1', 1, 120, 200) // 0.60
    const frames = [frameOf([first], [], 0), frameOf([second], [], 20)]
    expect(gaugeRatioAt(frames, 0, first, 0.5)).toBeCloseTo(0.55)

    // 周期变化（保比例缩放）：本帧 60/200 = 0.30 → 下一帧 30/100 = 0.30 ⇒ 不倒退、也不跳
    const before = fcard('1-c-1', 1, 60, 200)
    const after = fcard('1-c-1', 1, 30, 100)
    const scaled = [frameOf([before], [], 0), frameOf([after], [], 20)]
    expect(gaugeRatioAt(scaled, 0, before, 0.5)).toBeCloseTo(0.3)
  })

  it('行动条"满即归零"：归零前按速率走满、归零那一刻归 0、之后重新走（帧末与下一帧对齐）', () => {
    // 周期 200cs：本帧（cs 0）已走到 190；它在 cs 10 满条并**记账**（内部事件 `active_action.cs = 10`，
    // 事件记在"采集它的那一帧" = 本窗口的右端点）；到 cs 20 时已从 0 重新走到 10。
    const id = '1-c-1'
    const first = fcard(id, 1, 190, 200)
    const second = fcard(id, 1, 10, 200)
    const reset = ev(10, 'active_action', `active:${id}`, '-')
    const frames = [frameOf([first], [], 0), frameOf([second], [reset], 20)]

    // 归零之前：190/200 + 5/200 = 0.975（按速率推进，而不是"朝下一帧的 0.05 插值"）
    expect(gaugeRatioAt(frames, 0, first, 0.25)).toBeCloseTo(0.975)
    // 走到"满"的那一 cs（f = 0.5 ⇒ cs 10）正好 100%
    expect(gaugeRatioAt(frames, 0, first, 0.499)).toBeCloseTo(1, 2)
    // 归零那一刻起从 0 重新走：f = 0.75 ⇒ (15 − 10) / (20 − 10) × 0.05 = 0.025
    expect(gaugeRatioAt(frames, 0, first, 0.75)).toBeCloseTo(0.025)
    // 帧末与下一帧读数交接：0.05（不跳）
    expect(gaugeRatioAt(frames, 0, first, 1)).toBeCloseTo(0.05)
  })

  it('gaugeRatioAt：末帧与纯被动卡走本帧原值 / null', () => {
    const first = fcard('1-c-1', 1, 100, 200)
    const second = fcard('1-c-1', 1, 120, 200)
    const frames = [frameOf([first], [], 0), frameOf([second], [], 20)]
    expect(gaugeRatioAt(frames, 1, second, 0.5)).toBeCloseTo(0.6)

    const passive = fcard('1-p-2', 2, 0, null)
    expect(gaugeRatioAt([frameOf([passive])], 0, passive, 0.5)).toBeNull()
  })
})

/** 造一帧玩家读数（护盾口径用：只有血 / 盾有意义） */
function frameShield(
  timeCs: number,
  shieldA: number,
  shieldB: number,
  events: readonly FrameEvent[] = [],
): FrameSnapshot {
  return {
    triggerFrame: 0,
    timeCs,
    finished: false,
    winner: null,
    players: [
      { id: 1, hp: 300, maxHp: 300, shield: shieldA, dots: [] },
      { id: 2, hp: 300, maxHp: 300, shield: shieldB, dots: [] },
    ],
    cards: [],
    auras: [],
    events,
  }
}

describe('护盾补帧（存量读数：帧内可以"先涨后空"）', () => {
  it('同一帧里 +60 再被打空：+60 跳字的那段时间盾条要显示 60，打空后归 0', () => {
    // 窗口 cs 0→20：cs 4 A 获得 60、cs 16 A 被消耗 60 并击穿；B 获得 60 且没被打
    const events = [
      ev(4, 'on_shield_gained', 'skill:secondWind', 'player:1', 60, 1),
      ev(16, 'shield_spent', 'engine:shield_spent', 'player:1', 60, 1),
      ev(16, 'on_shield_broken', 'dot:burn@burn@1', 'player:1', 0, 1),
      ev(4, 'on_shield_gained', 'skill:secondWind', 'player:2', 60, 2),
    ]
    const frames = [frameShield(0, 0, 0), frameShield(20, 0, 60, events)]

    // A：0 →（cs 4）+60 →（cs 16）打空（端点两端都是 0，旧写法永远画不出那 60）
    expect(shieldShownAt(frames, 0, 1, 0)).toBe(0)
    expect(shieldShownAt(frames, 0, 1, 0.25)).toBe(60) // cs 5
    expect(shieldShownAt(frames, 0, 1, 0.5)).toBe(60) // cs 10
    expect(shieldShownAt(frames, 0, 1, 0.9)).toBe(0) // cs 18 已打空
    expect(shieldShownAt(frames, 0, 1, 1)).toBe(0) // 帧末对齐引擎读数
    // B：0 → 60 并保持（端点上就有 60，所以它一直"有盾条"）
    expect(shieldShownAt(frames, 0, 2, 0.25)).toBe(60)
    expect(shieldShownAt(frames, 0, 2, 1)).toBe(60)
  })

  it('窗口里没有盾事件 ⇒ 退回线性插值（与血条同口径）；末帧取本帧读数', () => {
    const frames = [frameShield(0, 10, 0), frameShield(20, 30, 0)]
    expect(shieldShownAt(frames, 0, 1, 0.5)).toBeCloseTo(20)
    expect(shieldShownAt(frames, 1, 1, 0.5)).toBe(30)
  })
})
