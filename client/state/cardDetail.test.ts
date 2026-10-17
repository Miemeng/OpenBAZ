// 悬浮细节窗数据层的单元测试（`npm test`）
//
// 钉住的是《卡面表现设计.md》§4 / §5 / §6 的口径：
//   · 数值行 = 候选清单 `STAT_ROW` + **词条存在即显示**（值为 0 也显示）；
//   · 行动条读数 = 回放态用帧读数（就绪 / 冰冻 / 百分比）、编辑态让引擎算基础周期、纯被动卡不渲染；
//   · 效果区 = 主动在上、被动在下、光环最后（组内保持原顺序）；
//   · 底部信息条 = 无归属不渲染；`multicast > 1` 才标多重触发；
//   · 定位 = 默认右下、右侧不足翻左、下方不足翻上、最后夹进视口。
import { describe, expect, it } from 'vitest'
import type { Card, FrameCard, FrameStat } from '../../engine/types.ts'
import type { GaugeView } from './replay.ts'
import { buildCardDetail, classifyEffectLine, detailEffectsOf, detailStatsOf, placeDetail } from './cardDetail.ts'

function cardOf(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    name: '试验卡',
    version: 1,
    size: 'medium',
    cooldown: 300,
    rarity: 'bronze',
    stats: { atk: 10 },
    ...overrides,
  }
}

/** 帧数值是 `{stat, value}[]`（引擎按键名升序给） */
function statsOf(entries: Readonly<Record<string, number>>): readonly FrameStat[] {
  return Object.entries(entries)
    .map(([stat, value]) => ({ stat, value }))
    .sort((left, right) => (left.stat < right.stat ? -1 : 1))
}

function frameOf(stats: Readonly<Record<string, number>>, overrides: Partial<FrameCard> = {}): FrameCard {
  return {
    instanceId: '1-c1-1',
    owner: 1,
    slot: 1,
    gaugeCs: 100,
    periodCs: 300,
    speed: 1,
    actionCount: 0,
    destroyed: false,
    stats: statsOf(stats),
    statuses: [],
    ...overrides,
  }
}

function gaugeOf(overrides: Partial<GaugeView> = {}): GaugeView {
  return { ratio: 1 / 3, periodCs: 300, frozen: false, ready: false, ...overrides }
}

const NO_EFFECTS: readonly string[] = ['已加载 试验卡 v1:']

describe('detailStatsOf（数值行）', () => {
  it('按 STAT_ROW 的顺序输出，且**词条存在即显示**（值为 0 也显示）', () => {
    const rows = detailStatsOf({ regen: 3, shield: 0, atk: 10 })
    expect(rows.map((row) => row.stat)).toEqual(['atk', 'shield', 'regen'])
    expect(rows.find((row) => row.stat === 'shield')?.value).toBe(0)
  })

  it('不在表里的键不进数值行（速度 / cdp / value / 自定义键）', () => {
    const rows = detailStatsOf({ atk: 1, speed: 2, cdp: 90, value: 20, myCustom: 5 })
    expect(rows.map((row) => row.stat)).toEqual(['atk'])
  })
})

describe('buildCardDetail', () => {
  it('编辑态：数值取卡面自带；行动条 = 引擎算的基础周期（含 cdp），无百分比', () => {
    const view = buildCardDetail({
      card: cardOf({ cooldown: 300, stats: { atk: 10, cdp: 50 } }),
      frame: undefined,
      gauge: undefined,
      effectLines: NO_EFFECTS,
      rarityName: '青铜',
      rarityColor: '#8d6e63',
      ownerLabel: null,
    })
    expect(view.stats.map((row) => row.value)).toEqual([10])
    // cdp 50 ⇒ 周期 3s × 50% = 1.5s（下限 1s 不触发）
    expect(view.gauge?.periodSeconds).toBeCloseTo(1.5, 5)
    expect(view.gauge?.percent).toBeNull()
    expect(view.gauge?.ready).toBe(false)
  })

  it('编辑态：纯被动卡（cooldown = -1）⇒ 不渲染行动条读数条', () => {
    const view = buildCardDetail({
      card: cardOf({ cooldown: -1 }),
      frame: undefined,
      gauge: undefined,
      effectLines: NO_EFFECTS,
      rarityName: '青铜',
      rarityColor: '#8d6e63',
      ownerLabel: null,
    })
    expect(view.gauge).toBeNull()
  })

  it('回放态：数值取**当前帧** stats；行动条读帧读数（百分比四舍五入）', () => {
    const view = buildCardDetail({
      card: cardOf({ stats: { atk: 10 } }),
      frame: frameOf({ atk: 45, burn: 15 }),
      gauge: gaugeOf({ ratio: 0.672 }),
      effectLines: NO_EFFECTS,
      rarityName: '黄金',
      rarityColor: '#ffc107',
      ownerLabel: '通用',
    })
    expect(view.stats.map((row) => [row.stat, row.value])).toEqual([
      ['atk', 45],
      ['burn', 15],
    ])
    expect(view.gauge).toEqual({ periodSeconds: 3, percent: 67, ready: false, frozen: false })
    expect(view.foot.owner).toBe('通用')
  })

  it('回放态：就绪 / 冰冻两个标记透传', () => {
    const ready = buildCardDetail({
      card: cardOf(),
      frame: frameOf({ atk: 1 }, { gaugeCs: 300 }),
      gauge: gaugeOf({ ratio: 1, ready: true }),
      effectLines: NO_EFFECTS,
      rarityName: '青铜',
      rarityColor: '#8d6e63',
      ownerLabel: null,
    })
    expect(ready.gauge?.ready).toBe(true)

    const frozen = buildCardDetail({
      card: cardOf(),
      frame: frameOf({ atk: 1 }, { statuses: [{ kind: 'freeze', remainingCs: 50 }] }),
      gauge: gaugeOf({ frozen: true, periodCs: 600 }),
      effectLines: NO_EFFECTS,
      rarityName: '青铜',
      rarityColor: '#8d6e63',
      ownerLabel: null,
    })
    expect(frozen.gauge?.frozen).toBe(true)
    expect(frozen.gauge?.periodSeconds).toBe(6)
  })

  it('底部信息条：标签 / 归属 / 占格 / 版本；`multicast > 1` 才标多重触发', () => {
    const view = buildCardDetail({
      card: cardOf({ size: 'large', tags: ['野兽', '火系'], multicast: 3, owner: 'heroA' }),
      frame: undefined,
      gauge: undefined,
      effectLines: NO_EFFECTS,
      rarityName: '钻石',
      rarityColor: '#00e5ff',
      ownerLabel: '先锋',
    })
    expect(view.foot).toEqual({ tags: ['野兽', '火系'], owner: '先锋', span: 3, version: 1, multicast: 3 })

    const single = buildCardDetail({
      card: cardOf({ multicast: 1 }),
      frame: undefined,
      gauge: undefined,
      effectLines: NO_EFFECTS,
      rarityName: '青铜',
      rarityColor: '#8d6e63',
      ownerLabel: null,
    })
    expect(single.foot.multicast).toBeNull()
    expect(single.foot.owner).toBeNull() // 渲染层据此不画那一格
  })
})

describe('detailEffectsOf（效果区分组）', () => {
  it('主动在上、被动在下、光环最后；组内保持原书写顺序', () => {
    const effects = detailEffectsOf([
      '已加载 试验卡 v1:',
      '  [被动 P10] 时机 on_player_damaged → deal_damage 5',
      '  [主动] 行动条充满时 → deal_damage 45',
      '  [被动 P3] 时机 on_burn_tick → gain_stat',
      '  [光环] 平铺 atk+3',
    ])
    expect(effects.map((effect) => effect.kind)).toEqual(['active', 'passive', 'passive', 'aura'])
    expect(effects[1]?.text).toBe('[被动 P10] 时机 on_player_damaged → deal_damage 5')
    expect(effects[2]?.text).toBe('[被动 P3] 时机 on_burn_tick → gain_stat')
  })

  it('剥掉首行；空行与缩进都被规整', () => {
    const effects = detailEffectsOf(['已加载 试验卡 v1:', '', '  [主动] 行动条充满时 → shield'])
    expect(effects).toEqual([{ kind: 'active', text: '[主动] 行动条充满时 → shield' }])
  })

  it('认不出的前缀归到技能组（不丢内容）', () => {
    expect(classifyEffectLine('  [别的] x')).toBe('skill')
    expect(detailEffectsOf(['首行', '  [技能 P5] 时机 battle_start → shield'])[0]?.kind).toBe('skill')
  })
})

describe('placeDetail（贴边翻转）', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 360, height: 300 }

  it('默认落在光标右下方（留出间距）', () => {
    expect(placeDetail({ x: 100, y: 100 }, viewport, size)).toEqual({ left: 112, top: 112 })
  })

  it('右侧放不下 ⇒ 翻到光标左侧', () => {
    expect(placeDetail({ x: 900, y: 100 }, viewport, size).left).toBe(900 - 12 - 360)
  })

  it('下方放不下 ⇒ 翻到光标上方', () => {
    expect(placeDetail({ x: 100, y: 700 }, viewport, size).top).toBe(700 - 12 - 300)
  })

  it('两边都放不下 ⇒ 夹进视口（不露到屏幕外）', () => {
    const placed = placeDetail({ x: 10, y: 10 }, { width: 300, height: 200 }, size)
    expect(placed).toEqual({ left: 0, top: 0 })
  })
})
