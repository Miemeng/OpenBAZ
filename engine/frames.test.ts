// 逐触发帧快照测试（ ``；契约见 engine/types.ts 的 `FrameSnapshot`）

// 这个文件存在的意义是把**三条不变式**钉成断言，而不是"跑一遍看看有没有崩"：
//   1. **开关不影响对局**：`captureFrames` 开与不开，`lines` / `log` / 终局状态**逐字节相同**
//      —— 快照只读 `state`、不耗 rng、不进确定性 hash；
//   2. **形状稳定**：玩家恒 `[1, 2]`、卡牌按"方 → slot"、DOT 恒三项、`stats` 按键名升序、
//      `periodCs` 的 `null` 有明确含义；
//   3. **读数与引擎同源**：`periodCs` / `speed` / `statuses` / 逐帧推进 / 终局帧的 `finished`。

// 约束：**不依赖 Vitest 快照序列化**，断言一律写具体数值。
import { describe, expect, it } from 'vitest'
import { runBattle, type BattleResult } from './tick.ts'
import type { Ability, AuraDef, BattleOptions, Card, FrameSnapshot, Skill } from './types.ts'

/** 非空断言（`noUncheckedIndexedAccess` 下的装配便利；装配错了立刻抛出并说明原因） */
function need<T>(value: T | undefined, what = '测试装配'): T {
  if (value === undefined) throw new Error(`${what}错误：期望存在，实际是 undefined`)
  return value
}

/** 造一张卡：只写测试关心的字段，其余取最小合法值 */
function cardOf(
  id: string,
  stats: Readonly<Record<string, number>>,
  extra: { readonly cooldown?: number; readonly aura?: AuraDef; readonly abilities?: readonly Ability[] } = {},
): Card {
  return {
    id,
    name: id,
    version: 1,
    size: 'small',
    cooldown: extra.cooldown ?? 300,
    rarity: 'common',
    stats,
    ...(extra.aura === undefined ? {} : { aura: extra.aura }),
    ...(extra.abilities === undefined ? {} : { abilities: [...extra.abilities] }),
  }
}

/** 会主动打人的卡（`deal_damage` 必须显式声明 —— ：没有内置普攻） */
function attacker(id: string, atk: number, cooldown = 300): Card {
  return cardOf(id, { atk }, {
    cooldown,
    abilities: [
      { id: 1, kind: 'active', actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }] },
    ],
  })
}

/** 跑一局（摆盘按数组下标 1 基顺排；默认取 `captureFrames: true`） */
function battle(
  cardsA: readonly Card[],
  cardsB: readonly Card[] = [],
  extra: Partial<BattleOptions> = {},
): BattleResult {
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

describe('逐触发帧快照', () => {
  it('captureFrames 开与不开：lines / log / 终局状态逐字节相同', () => {
    const off = battle([attacker('a', 200)], [attacker('b', 30)], { captureFrames: false })
    const on = battle([attacker('a', 200)], [attacker('b', 30)])

    // 关闭时产出空数组（不是 undefined）：消费方不必到处判空
    expect(off.frames).toEqual([])
    expect(on.frames.length).toBeGreaterThan(1)

    expect(on.lines).toEqual(off.lines)
    expect(JSON.stringify(on.log)).toBe(JSON.stringify(off.log))
    expect(JSON.stringify(on.state)).toBe(JSON.stringify(off.state))
    expect(on.victory).toBe(off.victory)
  })

  it('开局帧（frames[0]）：triggerFrame = 0、timeCs = 0、双方满血、卡牌按"方 → slot"', () => {
    const result = battle([attacker('a', 200)], [attacker('b', 30)], { captureFrames: true })
    const first = need(result.frames[0], 'frames[0]')

    expect(first.triggerFrame).toBe(0)
    expect(first.timeCs).toBe(0)
    expect(first.finished).toBe(false)
    expect(first.winner).toBeNull()
    expect(first.players.map((player) => player.id)).toEqual([1, 2])
    // 无阵容覆盖时血量 = INITIAL_HP = 300
    expect(first.players.map((player) => player.hp)).toEqual([300, 300])
    expect(first.players.map((player) => player.shield)).toEqual([0, 0])
    // 卡牌顺序：方 1 → 方 2（同方按 slot 升序）；instanceId = `<方>-<卡 id>-<格号>`
    expect(first.cards.map((card) => card.instanceId)).toEqual(['1-a-1', '2-b-1'])
    // DOT 恒三项、顺序固定
    expect(first.players[0]?.dots.map((dot) => dot.kind)).toEqual(['burn', 'poison', 'regen'])
  })

  it('帧序列：triggerFrame 连续 +1、timeCs 每帧 +20cs；收尾帧是唯一例外', () => {
    const result = battle([attacker('a', 200)], [attacker('b', 30)], { captureFrames: true })

    for (let index = 1; index < result.frames.length; index += 1) {
      const previous = need(result.frames[index - 1], `frames[${String(index - 1)}]`)
      const current = need(result.frames[index], `frames[${String(index)}]`)

      // 胜负在触发帧**中途**由因果点判定 ⇒ 主循环直接跳出，帧没走完。
      // 引擎为此补一帧"判定结果帧"：帧号与上一帧相同、时间不回退、finished 为真。
      if (index === result.frames.length - 1 && current.triggerFrame === previous.triggerFrame) {
        expect(current.finished).toBe(true)
        expect(current.timeCs).toBeGreaterThanOrEqual(previous.timeCs)
        continue
      }

      expect(current.triggerFrame).toBe(previous.triggerFrame + 1)
      expect(current.timeCs).toBe(previous.timeCs + 20)
    }

    const last = need(result.frames[result.frames.length - 1], '末帧')
    expect(last.triggerFrame).toBe(result.state.triggerFrame)
    expect(last.timeCs).toBe(result.state.timeCs)
    expect(last.finished).toBe(true)
  })

  it('窗口中途结束：收尾帧带上本窗口的帧事件（最后一击不丢）', () => {
    // 150cs = 1.50s ⇒ 行动落在**非 20cs 网格**的 cs 上：cs 150 一发 300 打死 B（初始血量 300）。
    // 主循环在 cs 150 由因果点判出胜负后直接跳出 ⇒ 走的是"收尾帧"这条路径。
    const result = battle([attacker('a', 300, 150)], [attacker('b', 30, 300)])
    const last = need(result.frames[result.frames.length - 1], '末帧')
    const previous = need(result.frames[result.frames.length - 2], '倒数第二帧')

    // 前提：这确实是"帧没走完"的收尾帧 —— 帧号与上一帧相同、时刻落在窗口中间
    expect(last.finished).toBe(true)
    expect(last.triggerFrame).toBe(previous.triggerFrame)
    expect(last.timeCs).toBe(previous.timeCs + 10)
    expect(last.timeCs % 20).not.toBe(0)

    // 那一段窗口里发生过的事件不许丢：致命一击的 `on_player_damaged` 必须出现在末帧
    expect(last.events.length).toBeGreaterThan(0)
    expect(last.events.some((event) => event.event === 'on_player_damaged')).toBe(true)
    expect(last.events.every((event) => event.cs > previous.timeCs)).toBe(true)
  })

  it('卡牌读数：periodCs = 充满周期、纯被动为 null、stats 不含 speed', () => {
    const result = battle([attacker('fast', 200, 300)], [cardOf('pure', { atk: 1 }, { cooldown: -1 })])
    const first = need(result.frames[0], 'frames[0]')

    const fast = need(first.cards.find((card) => card.instanceId === '1-fast-1'), 'fast')
    // 300cs × cdp(100) ÷ 100 ÷ 速度 1 = 300cs
    expect(fast.periodCs).toBe(300)
    expect(fast.speed).toBe(1)
    expect(fast.gaugeCs).toBe(0)
    expect(fast.actionCount).toBe(0)
    expect(fast.destroyed).toBe(false)
    // `speed` 单独给（它不走 effectiveStat），故不在 stats 列表里
    expect(fast.stats.map((entry) => entry.stat)).toEqual(['atk'])
    expect(fast.stats.map((entry) => entry.value)).toEqual([200])

    const pure = need(first.cards.find((card) => card.instanceId === '2-pure-1'), 'pure')
    expect(pure.periodCs).toBeNull()
  })

  it('冰冻：periodCs 转 null、statuses 带 freeze、speed = 0', () => {
    const freezer = cardOf('freezer', { atk: 1 }, {
      abilities: [
        {
          id: 1,
          kind: 'passive',
          trigger: { event: 'battle_start' },
          actions: [{ do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', duration: 2 }],
        },
      ],
    })
    const result = battle([attacker('a', 200)], [freezer])
    const first = need(result.frames[0], 'frames[0]')

    const frozen = need(first.cards.find((card) => card.instanceId === '1-a-1'), '被冻结的卡')
    expect(frozen.statuses.map((status) => status.kind)).toEqual(['freeze'])
    expect(frozen.speed).toBe(0)
    // Infinity 一律转 null：JSON 里 Infinity 会变成 null，不如显式表达
    expect(frozen.periodCs).toBeNull()
    expect(JSON.parse(JSON.stringify(frozen))).not.toBeNull()
  })

  it('数值与状态读数是"已合成 buff / 光环"的实时值', () => {
    const buffer = cardOf('buffer', { atk: 10 }, {
      aura: { select: 'all_own_cards', apply: [{ stat: 'atk', amount: 5 }] },
    })
    const result = battle([buffer, attacker('hitter', 20)], [])
    const first = need(result.frames[0], 'frames[0]')

    // 光环对来源自己也生效（own 视角覆盖本方全体）：10 + 5 = 15
    const self = need(first.cards.find((card) => card.instanceId === '1-buffer-1'), 'buffer')
    expect(need(self.stats.find((entry) => entry.stat === 'atk'), 'atk').value).toBe(15)
    expect(first.auras.length).toBeGreaterThan(0)
  })

  it('DOT 派生态读数进快照：光环施加的 burn 无时长 ⇒ 省略 remainingCs', () => {
    const burner = cardOf('burner', { atk: 1 }, {
      aura: { select: 'enemy_player', apply: [{ stat: 'burn', amount: 3 }] },
    })
    const result = battle([burner], [cardOf('target', { atk: 1 })])
    const first = need(result.frames[0], 'frames[0]')

    const dot = need(first.players[1]?.dots.find((entry) => entry.kind === 'burn'), 'B 方 burn')
    expect(dot.stacks).toBe(3)
    // 光环不落状态、无时长 ⇒ 该字段省略（= 常驻）
    expect(dot.remainingCs).toBeUndefined()
  })

  it('末帧：finished 为真、winner 与 victory 一致、败方血量为 0', () => {
    const result = battle([attacker('strong', 500)], [attacker('weak', 1)])
    const last = need(result.frames[result.frames.length - 1], '末帧')

    expect(result.victory).toBe('hp')
    expect(last.finished).toBe(true)
    expect(last.winner).toBe(1)
    expect(last.players[0]?.hp).toBe(300)
    expect(last.players[1]?.hp).toBe(0)
  })

  it('技能与被动同样只体现在派生读数里（不额外产出快照项）', () => {
    const skill: Skill = {
      id: 'shield_skill',
      name: '护盾技能',
      version: 1,
      rarity: 'bronze',
      stats: { shield: 40 },
      trigger: { event: 'battle_start' },
      actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shield' } }],
    }
    const result = battle([attacker('a', 200)], [attacker('b', 30)], { skillsA: [skill] })
    const first = need(result.frames[0], 'frames[0]')

    expect(first.players[0]?.shield).toBe(40)
    expect(first.players[1]?.shield).toBe(0)
  })
})

describe('事件实例与帧内事件记录（R.3 = C / R.5-B）', () => {
  /** 一张"挨打就给自己治疗"的纯被动卡：每次结算产出一条 `passive` 日志，用来数结算次数 */
  function medic(id: string): Card {
    return cardOf(id, { atk: 3 }, {
      cooldown: -1,
      abilities: [
        {
          id: 1,
          kind: 'passive',
          trigger: { event: 'on_player_damaged' },
          condition: { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } },
          actions: [{ do: 'heal_player', target: 'own_player', amount: { ref: 'self.atk' } }],
        },
      ],
    })
  }

  it('每帧最多释放一次 + 多余顺延：3 次伤害 ⇒ 本帧 1 次、之后每帧各 1 次，共 3 次治疗', () => {
    // A 方三张同冷却的卡 ⇒ 同一触发帧三次行动 = 三个来源
    const result = battle(
      [attacker('a1', 10, 100), attacker('a2', 10, 100), attacker('a3', 10, 100)],
      [medic('m1')],
      { hpA: 200, maxHpA: 200, hpB: 40, maxHpB: 40 },
    )
    const firstHurtIndex = result.frames.findIndex((frame) =>
      frame.events.some((event) => event.event === 'on_player_damaged'),
    )
    const firstHurt = need(result.frames[firstHurtIndex], '首个受伤帧')

    // ① 记账全量：三个来源各一条记录（`events` 不丢信息）
    expect(firstHurt.events.filter((event) => event.event === 'on_player_damaged')).toHaveLength(3)

    // ② 每帧只释放一条：本帧 1 次，随后两帧各 1 次（共 3 次），第三帧之后不再有
    const healsIn = (frame: FrameSnapshot): number =>
      result.log.filter((entry) => entry.sourceKind === 'passive' && entry.tick === frame.triggerFrame).length
    expect(healsIn(firstHurt)).toBe(1)
    expect(healsIn(need(result.frames[firstHurtIndex + 1], '受伤帧 +1'))).toBe(1)
    expect(healsIn(need(result.frames[firstHurtIndex + 2], '受伤帧 +2'))).toBe(1)
    expect(healsIn(need(result.frames[firstHurtIndex + 3], '受伤帧 +3'))).toBe(0)
  })

  it('结算期产生的事件在同一帧内立刻被收集（不再被丢到"下个触发帧"）', () => {
    // A 方：主动打人的卡（它的行动广播 `after_action`）
    const striker = attacker('s1', 10, 100)
    // B 方：听到 `after_action` 就打 A 方玩家 ⇒ 这一次伤害发生在**结算期**
    const counter = cardOf('c1', { atk: 7 }, {
      cooldown: -1,
      abilities: [
        {
          id: 1,
          kind: 'passive',
          trigger: { event: 'after_action' },
          actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
        },
      ],
    })
    // A 方：只在**自己受伤**时治疗的被动 ⇒ 只有"结算期那次伤害"能让它触发
    const result = battle([striker, medic('m2')], [counter], {
      hpA: 300,
      maxHpA: 300,
      hpB: 600,
      maxHpB: 600,
    })

    const healed = result.log.filter((entry) => entry.actor.includes('m2'))
    expect(healed.length).toBeGreaterThan(0)
    const hurtFrame = need(
      result.frames.find(
        (frame) => frame.events.some((event) => event.event === 'on_player_damaged' && event.playerId === 1),
      ),
      'A 方受伤帧',
    )
    expect(healed.some((entry) => entry.tick === hurtFrame.triggerFrame)).toBe(true)
  })

  it('events 是纯增数据：开关快照不影响 lines，记录可 JSON 序列化', () => {
    const limit = { hpA: 120, maxHpA: 120, hpB: 120, maxHpB: 120 }
    const on = battle([attacker('a1', 40, 100)], [attacker('b1', 5, 100)], limit)
    const off = battle([attacker('a1', 40, 100)], [attacker('b1', 5, 100)], { ...limit, captureFrames: false })

    expect(off.frames).toHaveLength(0)
    expect(off.lines).toEqual(on.lines)
    expect(on.frames.some((frame) => frame.events.length > 0)).toBe(true)
    expect(() => JSON.stringify(on.frames)).not.toThrow()
  })
})
