// 光环数值读数层测试

// 覆盖范围：
//   1. 派生态快照的数值合成与取整时机；
//   2. 玩家侧派生态 DOT 层数（F2 = 读法 ①：只改读数、不落状态）；
//   3. `condition` 为假与来源离场的语义；
//   4. 错误政策（ 玩家侧越界"先记后抛"；定义级错误直接抛）；
//   5. 生效 / 退场播报与 `runBattle` 主循环的接线。

// 约束：**不依赖 Vitest 快照序列化**，断言一律写具体数值 / 具体消息码。
import { describe, expect, it } from 'vitest'
import { refreshAuras } from './aura.ts'
import { createBattleState, effectiveDotStacks, effectiveStat } from './state.ts'
import { runBattle } from './tick.ts'
import type { AuraDef, BattleOptions, BattleState, BoardCard, Card, LogMessage, Skill } from './types.ts'

/**
 * 非空断言（`noUncheckedIndexedAccess` 下的测试装配便利）。
 * 用函数而不是 `!`：装配错了会立刻抛出并给出可读原因，且不依赖 lint 是否开严格集。
 */
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('测试装配错误：期望存在，实际得到 undefined')
  return value
}

/** 造一张卡：只写测试关心的字段，其余取最小合法值 */
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
): { readonly state: BattleState; readonly messages: LogMessage[]; readonly emit: (message: LogMessage) => void } {
  const messages: LogMessage[] = []
  const state = createBattleState({
    seed: 42,
    playerAName: 'A',
    playerBName: 'B',
    boardA: cardsA.map((card, index) => ({ card, slot: index + 1 })),
    boardB: cardsB.map((card, index) => ({ card, slot: index + 1 })),
    ...(skillsA.length === 0 ? {} : { skillsA }),
  })
  return {
    state,
    messages,
    emit: (message: LogMessage): void => {
      messages.push(message)
    },
  }
}

function boardCardOf(state: BattleState, side: 1 | 2, index: number): BoardCard {
  return need(state.players[side].board[index])
}

function codesOf(messages: readonly LogMessage[]): string[] {
  return messages.map((message) => message.code)
}

describe('光环数值层', () => {
  it('**多张同名卡各带同一条光环 ⇒ 按来源数累加**（5 张 frostBinder ⇒ 每张友方卡 +10）', () => {
    const aura: AuraDef = { select: 'all_own_cards', apply: [{ stat: 'atk', amount: 2 }] }
    const card = cardOf('frostBinder', { atk: 12 }, aura)
    const { state, emit } = setup([card, card, card, card, card])
    refreshAuras(state, emit)

    // 每个目标都应拿到 5 个来源 × 2 = +10（而不是"只算一个来源"）
    for (const boardCard of state.players[1].board) {
      expect(effectiveStat(state, boardCard, 'atk')).toBe(22)
    }
    // 台账也按"来源 × 目标"记：5 个来源 × 5 个目标 = 25 条 apply
    expect(state.auras.entries.filter((entry) => entry.channel === 'apply')).toHaveLength(25)
    expect(new Set(state.auras.entries.map((entry) => entry.source)).size).toBe(5)
  })

  it('apply 先平铺、mul 再乘倍率，且 own 视角只覆盖来源方自己的卡', () => {
    const { state, emit } = setup(
      [
        cardOf('buffer', { atk: 40 }, {
          select: 'all_own_cards',
          apply: [{ stat: 'atk', amount: 2 }],
          mul: [{ stat: 'atk', factor: 1.5 }],
        }),
      ],
      [cardOf('target', { atk: 10 })],
    )
    refreshAuras(state, emit)

    // (40 + 2) × 1.5 = 63
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(63)
    // 敌方不受"own"视角光环影响
    expect(effectiveStat(state, boardCardOf(state, 2, 0), 'atk')).toBe(10)
  })

  it('同一 stat 的多个倍率之间加算（两个 ×2 ⇒ ×3，不是 ×4）', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, { select: 'all_own_cards', mul: [{ stat: 'atk', factor: 2 }] }),
      cardOf('y', { atk: 10 }, { select: 'all_own_cards', mul: [{ stat: 'atk', factor: 2 }] }),
    ])
    refreshAuras(state, emit)

    // 总系数 = 1 + (2−1) + (2−1) = 3 ⇒ 10 × 3 = 30（若按连乘会是 40）
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(30)
  })

  it('中间过程不取整，只在返回前取整一次', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 5 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: 0.5 }],
        mul: [{ stat: 'atk', factor: 1.5 }],
      }),
    ])
    refreshAuras(state, emit)

    // (5 + 0.5) × 1.5 = 8.25 ⇒ 8；任何"提前取整"的写法都会得到 9
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(8)
  })

  it('condition 为假 ⇒ 本帧贡献 0（不是移除，是"从未生效"）', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, {
        select: 'all_own_cards',
        apply: [{ stat: 'atk', amount: 5 }],
        condition: { cmp: 'gt', left: { ref: 'this.atk' }, right: 100 },
      }),
    ])
    refreshAuras(state, emit)

    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(10)
  })

  it('来源离场（destroyed）⇒ 下一帧重建快照后自然消失，无回滚', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, { select: 'all_own_cards', apply: [{ stat: 'atk', amount: 5 }] }),
    ])
    refreshAuras(state, emit)
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(15)

    boardCardOf(state, 1, 0).destroyed = true
    refreshAuras(state, emit)
    expect(effectiveStat(state, boardCardOf(state, 1, 0), 'atk')).toBe(10)
  })

  it('读数本身不消耗 rng：快照只在触发帧边界集中求值', () => {
    const { state, emit } = setup([
      cardOf('a', { atk: 10 }, { select: 'random_own_card', apply: [{ stat: 'atk', amount: 1 }] }),
      cardOf('b', { atk: 10 }),
    ])
    refreshAuras(state, emit)
    const rngAfterRefresh = state.rng.state

    for (let i = 0; i < 50; i += 1) {
      effectiveStat(state, boardCardOf(state, 1, 0), 'atk')
      effectiveStat(state, boardCardOf(state, 1, 1), 'atk')
    }

    // 若改成"每次读数现算"，这 100 次读数会把 rng 走掉，本断言立刻失败
    expect(state.rng.state).toBe(rngAfterRefresh)
  })
})

describe('玩家侧派生态 DOT（F2 = 读法 ①）', () => {
  it('只改"派生态读数"：不新建实例、不改真实 stacks', () => {
    const skill: Skill = {
      id: 'ember',
      name: 'ember',
      version: 1,
      rarity: 'bronze',
      stats: {},
      actions: [],
      aura: { select: 'own_player', apply: [{ stat: 'burn', amount: 3 }] },
    }
    const { state, emit } = setup([cardOf('x', { atk: 1 })], [], [skill])
    const player = state.players[1]
    player.dots.push({ kind: 'burn', stacks: 4, source: 'seed' })

    refreshAuras(state, emit)

    expect(player.dots).toHaveLength(1) // 没有为光环新建实例
    expect(effectiveDotStacks(state, player, 'burn')).toBe(7) // 4 + 3
    expect(need(player.dots[0]).stacks).toBe(4) // 真实层数不被光环改写（衰减只作用于它）
  })

  it('光环把 burn / poison 施加给玩家 ⇒ 记一条 warn 级 aura.dot_warning', () => {
    const skill: Skill = {
      id: 'ember',
      name: 'ember',
      version: 1,
      rarity: 'bronze',
      stats: {},
      actions: [],
      aura: { select: 'own_player', apply: [{ stat: 'poison', amount: 2 }] },
    }
    const { state, messages, emit } = setup([cardOf('x', { atk: 1 })], [], [skill])

    refreshAuras(state, emit)

    expect(codesOf(messages)).toEqual(['aura.dot_warning', 'aura.entered'])
    expect(need(messages[0]).level).toBe('warn')
  })
})

describe('错误政策', () => {
  it('玩家侧 mul ⇒ 先记 error 级 selector.type_mismatch，再抛错中止', () => {
    const skill: Skill = {
      id: 'bad',
      name: 'bad',
      version: 1,
      rarity: 'bronze',
      stats: {},
      actions: [],
      aura: { select: 'own_player', mul: [{ stat: 'atk', factor: 2 }] },
    }
    const { state, messages, emit } = setup([cardOf('x', { atk: 1 })], [], [skill])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/目标类型不匹配/)

    expect(codesOf(messages)).toEqual(['selector.type_mismatch'])
    expect(need(messages[0]).level).toBe('error')
  })

  it('玩家侧 apply 非 burn / poison / regen（如 shield）⇒ 同样先记后抛', () => {
    const skill: Skill = {
      id: 'bad',
      name: 'bad',
      version: 1,
      rarity: 'bronze',
      stats: {},
      actions: [],
      aura: { select: 'own_player', apply: [{ stat: 'shield', amount: 5 }] },
    }
    const { state, messages, emit } = setup([cardOf('x', { atk: 1 })], [], [skill])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/只接受 burn \/ poison \/ regen/)

    expect(codesOf(messages)).toEqual(['selector.type_mismatch'])
  })

  it('apply 与 mul 全空 ⇒ 定义级错误：抛普通 Error，不记消息码（静态校验留给 sim:validate）', () => {
    const { state, messages, emit } = setup([
      cardOf('x', { atk: 10 }, { select: 'all_own_cards' }),
    ])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/至少一条非空/)
    expect(messages).toHaveLength(0)
  })

  it('同一条 apply 里重复写同一个 stat ⇒ 抛错', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, {
        select: 'all_own_cards',
        apply: [
          { stat: 'atk', amount: 1 },
          { stat: 'atk', amount: 1 },
        ],
      }),
    ])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/重复写了 atk/)
  })

  it('apply 作用 speed ⇒ 抛错', () => {
    const { state, emit } = setup([
      cardOf('x', { atk: 10 }, { select: 'all_own_cards', apply: [{ stat: 'speed', amount: 1 }] }),
    ])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/不得作用于 speed/)
  })

  it('技能光环没有来源卡：condition 里引用 this ⇒ 抛"引用根不可用"', () => {
    const skill: Skill = {
      id: 'bad',
      name: 'bad',
      version: 1,
      rarity: 'bronze',
      stats: {},
      actions: [],
      aura: {
        select: 'own_player',
        apply: [{ stat: 'burn', amount: 1 }],
        condition: { cmp: 'gt', left: { ref: 'this.atk' }, right: 0 },
      },
    }
    const { state, emit } = setup([cardOf('x', { atk: 1 })], [], [skill])

    expect(() => {
      refreshAuras(state, emit)
    }).toThrow(/此处不可用/)
  })
})

describe('生效 / 退场播报', () => {
  it('生效与退场各记一条（info），连续存在不重复记', () => {
    const { state, messages, emit } = setup([
      cardOf('x', { atk: 10 }, { select: 'all_own_cards', apply: [{ stat: 'atk', amount: 5 }] }),
    ])

    refreshAuras(state, emit)
    expect(codesOf(messages)).toEqual(['aura.entered'])
    expect(need(messages[0]).level).toBe('info')

    refreshAuras(state, emit)
    expect(codesOf(messages)).toEqual(['aura.entered']) // 连续存在不重复记

    boardCardOf(state, 1, 0).destroyed = true
    refreshAuras(state, emit)
    expect(codesOf(messages)).toEqual(['aura.entered', 'aura.exited'])
  })
})

describe('主循环接线（engine/tick.ts）', () => {
  it('runBattle 会重建快照：info 门槛下能看到"光环生效"，缺省 note 门槛下看不到', () => {
    const base: BattleOptions = {
      seed: 7,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [
        {
          card: cardOf('beacon', { atk: 10 }, {
            select: 'all_own_cards',
            apply: [{ stat: 'atk', amount: 1 }],
          }),
          slot: 1,
        },
      ],
      boardB: [{ card: cardOf('dummy', { atk: 10 }), slot: 1 }],
    }

    const loud = runBattle({ ...base, logLevel: 'info' })
    expect(loud.lines.some((line) => line.includes('光环生效'))).toBe(true)
    expect(loud.state.messages.some((message) => message.code === 'aura.entered')).toBe(true)

    const quiet = runBattle(base)
    expect(quiet.lines.some((line) => line.includes('光环生效'))).toBe(false)
    expect(quiet.state.messages.some((message) => message.code === 'aura.entered')).toBe(false)
  })

  it('同种子两次 runBattle 的文本行完全一致', () => {
    const base: BattleOptions = {
      seed: 42,
      playerAName: 'A',
      playerBName: 'B',
      boardA: [
        {
          card: cardOf('beacon', { atk: 10 }, {
            select: 'all_own_cards',
            apply: [{ stat: 'atk', amount: 1 }],
          }),
          slot: 1,
        },
      ],
      boardB: [
        {
          card: cardOf('twin', { atk: 10 }, {
            select: 'random_enemy_card',
            mul: [{ stat: 'atk', factor: 1.5 }],
          }),
          slot: 1,
        },
      ],
    }

    const first = runBattle(base)
    const second = runBattle(base)
    expect(second.lines).toEqual(first.lines)
    expect(second.log).toEqual(first.log)
  })
})
