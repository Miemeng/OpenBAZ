// 附魔（enchant）的派生态测试
//
// 这一批只覆盖**引擎能立即验证**的三条口径（《审阅.md》§AD 的 A/A/A）：
//   1. `stats` **并入卡面基础层** ⇒ `effectiveStat` / 是否具有该属性 / 光环倍率都看得见；
//   2. **整件替换** ⇒ 换 id 后旧附魔的键立刻消失（没有"清除"路径，因为一切派生态只认当前 id）；
//   3. `aura` 的来源键 = `enchant:<卡实例>#<附魔 id>`（可追溯；换附魔 = 换来源）。
// 外加一条 §AC 的广播边界：**伤害全被盾吃掉**（溢出 0）也算一次击穿。
//
// ⚠️ `do: enchant` 原语（"谁在什么时候挂上附魔"）尚未实现 ⇒ 本文件的用例**直接写**
//    `BoardCard.enchant`（它就是运行期状态，写入即等价于被施加）。
import { describe, expect, it } from 'vitest'
import { runBattle } from './tick.ts'
import { createBattleState, effectiveStat } from './state.ts'
import { refreshAuras } from './aura.ts'
import type { Ability, BattleOptions, BoardCard, Card, EnchantDef, Skill } from './types.ts'

function need<T>(value: T | undefined, what = '测试装配'): T {
  if (value === undefined) throw new Error(`${what}错误：期望存在，实际是 undefined`)
  return value
}

/** 造一张卡：只写测试关心的字段，其余取最小合法值 */
function cardOf(
  id: string,
  stats: Readonly<Record<string, number>>,
  extra: {
    readonly cooldown?: number
    readonly enchantments?: readonly EnchantDef[]
    readonly abilities?: readonly Ability[]
    readonly multicast?: number
  } = {},
): Card {
  return {
    id,
    name: id,
    version: 1,
    size: 'small',
    cooldown: extra.cooldown ?? 300,
    rarity: 'common',
    stats,
    ...(extra.enchantments === undefined ? {} : { enchantments: [...extra.enchantments] }),
    ...(extra.abilities === undefined ? {} : { abilities: [...extra.abilities] }),
    ...(extra.multicast === undefined ? {} : { multicast: extra.multicast }),
  }
}

/** 会主动打人的卡（伤害写在 `abilities` 里：引擎没有内置普攻） */
function attacker(id: string, atk: number, cooldown = 300): Card {
  return cardOf(id, { atk }, {
    cooldown,
    abilities: [
      {
        id: 1,
        kind: 'active',
        actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
      },
    ],
  })
}

function optionsOf(card: Card, extra: Partial<BattleOptions> = {}): BattleOptions {
  return {
    seed: 42,
    playerAName: 'A',
    playerBName: 'B',
    boardA: [{ card, slot: 1 }],
    boardB: [],
    ...extra,
  }
}

/** 取 A 方第 1 格 */
function firstCardOf(state: ReturnType<typeof createBattleState>): BoardCard {
  return need(state.players[1].board[0], 'A 方第 1 格')
}

describe('附魔派生态（stats / 替换 / 光环来源）', () => {
  const EMERALD: EnchantDef = { id: 'emerald', stats: { heal: 6 } }
  const PLATING: EnchantDef = { id: 'plating', stats: { shield: 5 } }
  const OBSIDIAN: EnchantDef = {
    id: 'obsidian',
    aura: { select: 'self', mul: [{ stat: 'atk', factor: 2 }] },
  }

  it('stats 并入卡面基础层：读数看得见，未涉及的键不受影响', () => {
    const state = createBattleState(optionsOf(cardOf('e1', { atk: 10 }, { enchantments: [EMERALD] })))
    const boardCard = firstCardOf(state)

    // 没有附魔 ⇒ heal 读作 0（卡面没这个键）
    expect(effectiveStat(state, boardCard, 'heal')).toBe(0)

    boardCard.enchant = 'emerald'
    expect(effectiveStat(state, boardCard, 'heal')).toBe(6)
    expect(effectiveStat(state, boardCard, 'atk')).toBe(10)
  })

  it('整件替换：换 id 后旧附魔带来的键立刻消失（无残留）', () => {
    const state = createBattleState(optionsOf(cardOf('e2', { atk: 10 }, { enchantments: [EMERALD, PLATING] })))
    const boardCard = firstCardOf(state)

    boardCard.enchant = 'emerald'
    expect(effectiveStat(state, boardCard, 'heal')).toBe(6)
    expect(effectiveStat(state, boardCard, 'shield')).toBe(0)

    boardCard.enchant = 'plating'
    expect(effectiveStat(state, boardCard, 'heal')).toBe(0) // 旧件整体回滚
    expect(effectiveStat(state, boardCard, 'shield')).toBe(5)
  })

  it('附魔的 aura：来源键带附魔 id，且倍率作用到读数上', () => {
    const state = createBattleState(optionsOf(cardOf('e3', { atk: 10 }, { enchantments: [OBSIDIAN] })))
    const boardCard = firstCardOf(state)
    boardCard.enchant = 'obsidian'
    refreshAuras(state, () => {})

    const entry = state.auras.entries.find(
      (item) => item.source === `enchant:${boardCard.instanceId}#obsidian`,
    )
    expect(entry).toBeDefined()
    // 10 × 2 = 20
    expect(effectiveStat(state, boardCard, 'atk')).toBe(20)
  })

  it('附魔 id 不在目录里 ⇒ 视为没有附魔（不抛错）', () => {
    const state = createBattleState(optionsOf(cardOf('e4', { atk: 10 }, { enchantments: [EMERALD] })))
    const boardCard = firstCardOf(state)
    boardCard.enchant = 'nope'
    expect(effectiveStat(state, boardCard, 'heal')).toBe(0)
    expect(() => {
      refreshAuras(state, () => {})
    }).not.toThrow()
  })
})

describe('施加（do: enchant）与主动末尾附加组', () => {
  /** 绿宝石：自带一条回血动作（用来观察"附加组真的跑了"） */
  const EMERALD: EnchantDef = {
    id: 'emerald',
    stats: { heal: 0 },
    actions: [{ do: 'heal_player', target: 'own_player', amount: 10 }],
  }
  /** 只会"给自己挂绿宝石"的卡（最快的施加手段） */
  function enchanter(id: string, cooldown = 100): Card {
    return cardOf(id, { atk: 1 }, {
      cooldown,
      enchantments: [EMERALD],
      abilities: [{ id: 1, kind: 'active', actions: [{ do: 'enchant', target: 'self', enchant: 'emerald' }] }],
    })
  }

  it('原语：施加后帧快照带上 enchant（第一次行动只施加，不跑附加组）', () => {
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [{ card: enchanter('e1'), slot: 1 }],
      boardB: [],
      captureFrames: true,
    })

    // cs 100 第一次行动：记账那一刻还没有附魔 ⇒ 只有"施加"本身
    const first = need(
      result.frames.find((frame) => frame.timeCs >= 100),
      'cs>=100 的帧',
    )
    expect(first.cards.find((card) => card.instanceId === '1-e1-1')?.enchant).toBe('emerald')
  })

  it('附加组：附魔生效后，每次行动都在末尾接着跑它的 actions', () => {
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [{ card: enchanter('e2'), slot: 1 }],
      boardB: [],
    })

    const active = result.log.filter((entry) => entry.sourceKind === 'active' && entry.actor === '1-e2-1')
    // 第一次行动：只有 enchant 效果；第二次起：enchant + 附加组 heal
    expect(active.length).toBeGreaterThan(1)
    const withHeal = active.filter((entry) => entry.effects.some((effect) => effect.kind === 'heal'))
    expect(withHeal.length).toBeGreaterThan(0)
  })

  it('multicast 参与：N 条重复**每条**都带附魔的附加组', () => {
    // x1（cs 100）用 `all_own_cards` 把绿宝石挂给全队；m2（multicast 2，cs 200 起）随后行动
    const x1 = cardOf('x1', { atk: 1 }, {
      cooldown: 100,
      enchantments: [EMERALD],
      abilities: [
        { id: 1, kind: 'active', actions: [{ do: 'enchant', target: 'all_own_cards', enchant: 'emerald' }] },
      ],
    })
    const m2 = cardOf('m2', { atk: 1 }, {
      cooldown: 200,
      multicast: 2,
      enchantments: [EMERALD],
      abilities: [{ id: 1, kind: 'active', actions: [{ do: 'deal_damage', target: 'enemy_player', amount: 1 }] }],
    })
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [
        { card: x1, slot: 1 },
        { card: m2, slot: 2 },
      ],
      boardB: [],
    })

    // ⚠️ 实例 id = `<方>-<卡 id>-<格号>`：m2 在**2 号格** ⇒ `1-m2-2`（不是 `1-m2-1`）
    const m2Runs = result.log.filter((entry) => entry.sourceKind === 'active' && entry.actor === '1-m2-2')
    // multicast: 2 ⇒ 同一次行动压两条独立释放条目（第 2 条顺延到后续窗口）
    expect(m2Runs.length).toBeGreaterThanOrEqual(2)
    // **两条都带**附魔那条附加动作（说明附魔跟着 multicast 重复，而不是只跑一次）
    for (const entry of m2Runs.slice(0, 2)) {
      expect(entry.effects.some((effect) => effect.kind === 'heal')).toBe(true)
      expect(entry.effects.some((effect) => effect.kind === 'damage')).toBe(true)
    }
  })

  it('目标卡目录里没有该 id ⇒ 静默跳过（不抛错、不留下附魔）', () => {
    const card = cardOf('e4', { atk: 1 }, {
      cooldown: 100,
      enchantments: [EMERALD],
      abilities: [{ id: 1, kind: 'active', actions: [{ do: 'enchant', target: 'self', enchant: 'nope' }] }],
    })
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [{ card, slot: 1 }],
      boardB: [],
      captureFrames: true,
    })
    const last = need(result.frames[result.frames.length - 1], '末帧')
    expect(last.cards.find((frameCard) => frameCard.instanceId === '1-e4-1')?.enchant).toBeUndefined()
  })

  it('附魔自带的 stats 键进帧快照读数（挂上绿宝石后卡面才会出现"疗"）', () => {
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [{ card: enchanter('e5'), slot: 1 }],
      boardB: [],
      captureFrames: true,
    })
    const frame = need(
      result.frames.find((item) => item.timeCs >= 100),
      'cs>=100 的帧',
    )
    const frameCard = frame.cards.find((item) => item.instanceId === '1-e5-1')
    // 卡面本身没有 heal 键；它是**附魔**带上来的 ⇒ 必须在读数表里出现（值 0 也算"具有该词条"）
    expect(frameCard?.stats.some((entry) => entry.stat === 'heal')).toBe(true)
  })
})

describe('§AC：击穿广播的边界（伤害全被盾吃掉）', () => {
  /** 开局给本方加 60 盾的技能 */
  function wardSkill(): Skill {
    return {
      id: 'ward',
      name: 'ward',
      version: 1,
      rarity: 'common',
      stats: {},
      trigger: { event: 'battle_start' },
      actions: [{ do: 'shield', target: 'own_player', amount: 60 }],
    }
  }

  it('恰好打空护盾（溢出 0）也广播 on_shield_broken', () => {
    const result = runBattle({
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      // A 在 cs 150（非 20cs 网格）打 60；B 开局有 60 盾 ⇒ 全被吸收、溢出 0
      boardA: [{ card: attacker('striker', 60, 150), slot: 1 }],
      boardB: [{ card: cardOf('dummy', { atk: 1 }), slot: 1 }],
      skillsB: [wardSkill()],
      captureFrames: true,
    })

    const broken = result.frames
      .flatMap((frame) => frame.events)
      .filter((event) => event.event === 'on_shield_broken')
    expect(broken.length).toBeGreaterThan(0)
    // 触发点必须真的在推进之后（不是开局 cs 0 的伪事件）
    expect(broken.some((event) => event.cs > 0)).toBe(true)
  })
})
