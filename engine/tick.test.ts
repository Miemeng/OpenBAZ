// 触发层回归测试 —— 事件参数

// 这个文件的存在理由是一次**真实踩到的崩溃**（`packs/test` 首次暴露）：
// `on_player_damaged` 被"持续效果观测"复用（含**再生回血**那一跳），而再生跳原先**不带 `player`**
// 参数 ⇒ 任何写着 `{ var: player }` 的被动 / 技能在再生跳上抛
// "事件参数 player 不存在（见参数表设计.md）"、**整局中止**。
// 教学包（`myCard`）写着同样的 `{ var: player }` 却一直没踩到，只是因为它的阵容不产生再生跳。
//
// **现状**：再生跳已改由 `on_regen_tick` 承载（**不再借用** `on_player_damaged`），
// 下面第一个用例据此钉住"再生只走跳变时机词、且三个参数齐全"。

// 约束：不依赖 Vitest 快照序列化，断言写具体事实（能不能跑完 / 哪条被动入了日志）。
import { describe, expect, it } from 'vitest'
import { runBattle } from './tick.ts'
import type { Ability, BattleOptions, Card, Expr, FrameSnapshot, Skill } from './types.ts'

/** 造一张卡：只写测试关心的字段，其余取最小合法值 */
function cardOf(
  id: string,
  stats: Readonly<Record<string, number>>,
  abilities: readonly Ability[] = [],
): Card {
  return { id, name: id, version: 1, size: 'small', cooldown: 300, rarity: 'common', stats, abilities: [...abilities] }
}

/** 打人的主动效果 */
function damageAbility(amount: Expr): Ability {
  return { id: 1, kind: 'active', actions: [{ do: 'deal_damage', target: 'enemy_player', amount }] }
}

/** 一条被动：条件成立时给自己 +1 攻击（用来观察"这条被动有没有入日志"） */
function watchAbility(name: string, condition: Ability['condition'], id = 1): Ability {
  return {
    id,
    kind: 'passive',
    priority: 5,
    trigger: { event: name },
    ...(condition === undefined ? {} : { condition }),
    actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
  }
}

function battle(cardsA: readonly Card[], cardsB: readonly Card[], extra: Partial<BattleOptions> = {}) {
  return runBattle({
    seed: 42,
    playerAName: 'A',
    playerBName: 'B',
    boardA: cardsA.map((card, index) => ({ card, slot: index + 1 })),
    boardB: cardsB.map((card, index) => ({ card, slot: index + 1 })),
    ...extra,
  })
}

describe('持续效果跳变的事件参数', () => {
  it('再生跳改由 on_regen_tick 承载：不再借用 on_player_damaged', () => {
    // A 方：打完伤害后给自己叠再生 ⇒ 之后每个周期产生一次"再生回血"跳变
    const regenerator = cardOf('regenSource', { atk: 120, regen: 3 }, [
      {
        id: 1,
        kind: 'active',
        actions: [
          { do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } },
          { do: 'gain_stat', stat: 'regen', amount: { ref: 'self.regen' }, target: 'own_player' },
        ],
      },
    ])
    // A 方：听 on_regen_tick 的被动，条件同时引用 `player` / `stacks` / `heal` 三个参数
    // （缺任何一个都会在求值时抛错、中止整局）
    const tickWatcher = cardOf('tickWatcher', { atk: 1 }, [
      {
        id: 1,
        kind: 'passive',
        trigger: { event: 'on_regen_tick' },
        condition: {
          all: [
            { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } },
            { cmp: 'gte', left: { var: 'stacks' }, right: 0 },
            { cmp: 'gte', left: { var: 'heal' }, right: 0 },
          ],
        },
        actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
      },
    ])
    // A 方：听 on_player_damaged 的被动（历史崩溃点：条件里引用 `{ var: player }`）
    const damageWatcher = cardOf('damageWatcher', { atk: 1 }, [
      watchAbility('on_player_damaged', { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } }),
    ])

    // B 方留空、血量给足：这一局只关心 A 方的再生跳（跑到超时收场，再生跳有很多次）
    const result = battle([regenerator, tickWatcher, damageWatcher], [], {
      captureFrames: true,
      hpB: 5000,
      maxHpB: 5000,
    })

    expect(result.state.finished).toBe(true) // 跑到了收场，而不是中途抛错
    expect(eventsOf(result, 'on_regen_tick').some((entry) => entry.playerId === 1)).toBe(true)
    // **再生不再产生 `on_player_damaged`**（来源键以 `dot:regen` 开头的那类记录应当不存在）
    expect(eventsOf(result, 'on_player_damaged').some((entry) => entry.sourceKey.startsWith('dot:regen'))).toBe(false)
  })

  it('on_burn_tick / on_poison_tick：带 stacks（结算前层数）与 damage，且伤害事件仍独立广播', () => {
    // A 方：一次行动给对方叠 5 层灼烧 + 4 层剧毒
    const dotter = cardOf('dotter', { atk: 1, burn: 5, poison: 4 }, [
      {
        id: 1,
        kind: 'active',
        actions: [
          { do: 'gain_stat', stat: 'burn', amount: { ref: 'self.burn' }, target: 'enemy_player' },
          { do: 'gain_stat', stat: 'poison', amount: { ref: 'self.poison' }, target: 'enemy_player' },
        ],
      },
    ])
    const watcher = cardOf('dotWatcher', { atk: 1 }, [
      {
        id: 1,
        kind: 'passive',
        trigger: { event: 'on_burn_tick' },
        condition: {
          all: [
            { cmp: 'eq', left: { var: 'player' }, right: { ref: 'enemy_player' } },
            { cmp: 'gte', left: { var: 'stacks' }, right: 0 },
            { cmp: 'gte', left: { var: 'damage' }, right: 0 },
          ],
        },
        actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
      },
      {
        id: 2,
        kind: 'passive',
        trigger: { event: 'on_poison_tick' },
        condition: {
          all: [
            { cmp: 'eq', left: { var: 'player' }, right: { ref: 'enemy_player' } },
            { cmp: 'gte', left: { var: 'stacks' }, right: 0 },
            { cmp: 'gte', left: { var: 'damage' }, right: 0 },
          ],
        },
        actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
      },
    ])

    const result = battle([dotter, watcher], [cardOf('dummy', { atk: 1 })], { captureFrames: true })
    const burn = eventsOf(result, 'on_burn_tick')
    const poison = eventsOf(result, 'on_poison_tick')

    // 目标 = 承受跳变的那位玩家；来源 = 该持续效果实例（`dot:<kind>@<承受方>`）
    expect(burn.some((entry) => entry.playerId === 2 && entry.targetKey === 'player:2' && entry.sourceKey === 'dot:burn@2')).toBe(true)
    expect(poison.some((entry) => entry.playerId === 2 && entry.sourceKey === 'dot:poison@2')).toBe(true)
    // 第一次跳的"结算前层数"就是刚叠上的层数；伤害 = 层数（B 无护盾；剧毒无视护盾）
    expect(burn[0]?.amount).toBe(5)
    expect(poison[0]?.amount).toBe(4)
    // 灼烧 / 剧毒**仍然**广播 on_player_damaged（只有再生改走了跳变时机词）
    expect(eventsOf(result, 'on_player_damaged').some((entry) => entry.sourceKey === 'dot:burn@2')).toBe(true)
    const actors = result.log.map((entry) => entry.actor)
    expect(actors).toContain('1-dotWatcher-2#1')
    expect(actors).toContain('1-dotWatcher-2#2')
  })

  it('伤害跳的 player 恒为受伤方（条件可据此区分"谁挨打"）', () => {
    const striker = cardOf('striker', { atk: 200 }, [damageAbility({ ref: 'self.atk' })])
    // slot 1：只在自己一方挨打时触发；slot 2：只在对方挨打时触发（本局 A 不挨打 ⇒ 永不触发）
    const selfWatcher = cardOf('selfWatcher', { atk: 1 }, [
      watchAbility('on_player_damaged', { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } }),
    ])
    const enemyWatcher = cardOf('enemyWatcher', { atk: 1 }, [
      watchAbility('on_player_damaged', { cmp: 'eq', left: { var: 'player' }, right: { ref: 'enemy_player' } }),
    ])

    const result = battle([striker], [selfWatcher, enemyWatcher])
    const actors = result.log.map((entry) => entry.actor)

    // 被动入日志的 actor 口径 = `<instanceId>#<abilityId>`（见 ActionLog.actor）
    expect(actors).toContain('2-selfWatcher-1#1')
    expect(actors).not.toContain('2-enemyWatcher-2#1')
  })
})

// ————————————————————————————————————————————————————————
// 三个新时机词的广播（全在玩家侧：治疗 / 获得护盾 / 护盾被击穿）
//
// 每个用例同时钉两件事：① **广播确实发出**（帧事件里有该时机词、来源 / 目标 / 数值正确）；
// ② **参数确实带上**（监听方的条件引用该时机词的专属参数 —— 参数缺失时求值会直接抛错中止整局）。
// ————————————————————————————————————————————————————————

/** 一条"听到某时机词就给自己 +1 攻击"的监听被动（只为在日志里留一笔，便于断言触发过） */
function listenAbility(event: string, condition?: Ability['condition'], id = 1): Ability {
  return {
    id,
    kind: 'passive',
    trigger: { event },
    ...(condition === undefined ? {} : { condition }),
    actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
  }
}

/** 一局里某个时机词的全部帧事件记录 */
function eventsOf(result: ReturnType<typeof runBattle>, event: string) {
  return result.frames.flatMap((frame) => frame.events).filter((entry) => entry.event === event)
}

describe('新时机词的广播', () => {
  it('on_player_healed：满血 0 治疗也算一次发生（amount = 0）', () => {
    // A 方满血治疗自己 ⇒ 实际恢复量 0，但"治疗结算过"这件事必须广播
    const healer = cardOf('healer', { atk: 1, heal: 10 }, [
      {
        id: 1,
        kind: 'active',
        actions: [{ do: 'heal_player', target: 'own_player', amount: { ref: 'self.heal' } }],
      },
    ])
    const watcher = cardOf('healWatcher', { atk: 1 }, [
      listenAbility('on_player_healed', {
        all: [
          { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } },
          { cmp: 'eq', left: { var: 'amount' }, right: 0 },
        ],
      }),
    ])
    const killer = cardOf('killer', { atk: 120 }, [damageAbility({ ref: 'self.atk' })])

    const result = battle([healer, watcher], [killer], { captureFrames: true })
    const healed = eventsOf(result, 'on_player_healed')

    expect(healed.some((entry) => entry.playerId === 1 && entry.amount === 0)).toBe(true)
    expect(result.log.map((entry) => entry.actor)).toContain('1-healWatcher-2#1')
  })

  it('on_player_healed：cleansed_burn / cleansed_poison 随广播给出（按 0.05 比例真清掉的层数）', () => {
    // 一次行动里先给自己一方叠 20 层灼烧、再治疗 40：实际恢复 40 ⇒ 清掉 40 × 0.05 = 2 层灼烧
    const selfBurner = cardOf('selfBurner', { atk: 1, heal: 40, burn: 20 }, [
      {
        id: 1,
        kind: 'active',
        actions: [
          { do: 'gain_stat', stat: 'burn', amount: { ref: 'self.burn' }, target: 'own_player' },
          { do: 'heal_player', target: 'own_player', amount: { ref: 'self.heal' } },
        ],
      },
    ])
    const watcher = cardOf('cleanseWatcher', { atk: 1 }, [
      listenAbility('on_player_healed', {
        all: [
          { cmp: 'gt', left: { var: 'cleansed_burn' }, right: 0 },
          { cmp: 'gte', left: { var: 'cleansed_poison' }, right: 0 },
        ],
      }),
    ])
    const killer = cardOf('killer', { atk: 60 }, [damageAbility({ ref: 'self.atk' })])

    // A 方开局不满血（缺 100），治疗才有实际恢复量、才会清洗 DOT
    const result = battle([selfBurner, watcher], [killer], {
      captureFrames: true,
      hpA: 200,
      maxHpA: 300,
    })

    expect(result.log.map((entry) => entry.actor)).toContain('1-cleanseWatcher-2#1')
  })

  it('on_shield_gained：真的加上护盾才广播（加 0 的空转不算"获得"）', () => {
    const real: Skill = {
      id: 'realShield',
      name: '真盾',
      version: 1,
      rarity: 'bronze',
      stats: { shield: 25 },
      trigger: { event: 'battle_start' },
      actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shield' } }],
    }
    const zero: Skill = {
      id: 'zeroShield',
      name: '空盾',
      version: 1,
      rarity: 'bronze',
      stats: { shield: 0 },
      trigger: { event: 'battle_start' },
      actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shield' } }],
    }
    const watcher = cardOf('shieldWatcher', { atk: 1 }, [
      listenAbility('on_shield_gained', {
        all: [
          { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } },
          { cmp: 'gt', left: { var: 'amount' }, right: 0 },
        ],
      }),
    ])
    const killer = cardOf('killer', { atk: 120 }, [damageAbility({ ref: 'self.atk' })])

    const result = battle([watcher], [killer], { captureFrames: true, skillsA: [real, zero] })
    const gained = eventsOf(result, 'on_shield_gained')

    expect(gained.some((entry) => entry.playerId === 1 && entry.amount === 25)).toBe(true)
    expect(gained.every((entry) => entry.amount !== 0)).toBe(true)
    expect(result.log.map((entry) => entry.actor)).toContain('1-shieldWatcher-1#1')
  })

  it('on_shield_broken：护盾池被一次伤害从 >0 打空时广播，overflow = 溢出到血量的伤害', () => {
    const shieldSkill: Skill = {
      id: 'shieldSkill',
      name: '护盾术',
      version: 1,
      rarity: 'bronze',
      stats: { shield: 30 },
      trigger: { event: 'battle_start' },
      actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shield' } }],
    }
    // 30 点护盾被 100 点伤害一次打空 ⇒ 溢出到血量的是 70
    const striker = cardOf('striker', { atk: 100 }, [damageAbility({ ref: 'self.atk' })])
    const watcher = cardOf('breakWatcher', { atk: 1 }, [
      listenAbility('on_shield_broken', {
        all: [
          { cmp: 'eq', left: { var: 'player' }, right: { ref: 'own_player' } },
          { cmp: 'gte', left: { var: 'overflow' }, right: 0 },
        ],
      }),
    ])

    const result = battle([watcher], [striker], { captureFrames: true, skillsA: [shieldSkill] })
    const broken = eventsOf(result, 'on_shield_broken')

    expect(broken.some((entry) => entry.playerId === 1 && entry.amount === 70)).toBe(true)
    expect(result.log.map((entry) => entry.actor)).toContain('1-breakWatcher-1#1')
  })
})

// ————————————————————————————————————————————————————————
// 六个卡牌侧时机词的广播（destroy / repair / 三种卡牌状态 / charge）
//
// 目标键 = `card:<卡实例id>`（被作用的那张卡）；一条动作作用 N 张卡 ⇒ N 个实例。
// ————————————————————————————————————————————————————————

/** 非空断言（`noUncheckedIndexedAccess` 下的取帧便利） */
function needFrame(value: FrameSnapshot | undefined, what = '帧'): FrameSnapshot {
  if (value === undefined) throw new Error(`${what}不存在`)
  return value
}

describe('卡牌侧时机词的广播', () => {
  it('on_card_destroyed / on_card_repaired：一条动作里两个词各广播，目标与格位正确', () => {
    // A 方：先让对方全体失效，再修好本方全体（本方没失效 ⇒ 覆盖"对未失效的卡 repair 也算一次发生"）
    const saboteur = cardOf('saboteur', { atk: 1 }, [
      {
        id: 1,
        kind: 'active',
        actions: [
          { do: 'destroy', target: 'all_enemy_cards' },
          { do: 'repair', target: 'all_own_cards' },
        ],
      },
    ])
    const watcher = cardOf('cardWatcher', { atk: 1 }, [
      listenAbility('on_card_destroyed', { cmp: 'gte', left: { var: 'slot_index' }, right: 0 }),
      listenAbility('on_card_repaired', { cmp: 'gte', left: { var: 'slot_index' }, right: 0 }, 2),
    ])
    const victim = cardOf('victim', { atk: 1 })

    const result = battle([watcher, saboteur], [victim], { captureFrames: true })

    // 目标 = 被作用的那张卡：帧事件里 `instanceId` / `slot` / `targetKey` 三处一致
    expect(
      eventsOf(result, 'on_card_destroyed').some(
        (entry) => entry.instanceId === '2-victim-1' && entry.slot === 1 && entry.targetKey === 'card:2-victim-1',
      ),
    ).toBe(true)
    expect(
      eventsOf(result, 'on_card_repaired').some(
        (entry) => entry.instanceId === '1-cardWatcher-1' && entry.targetKey === 'card:1-cardWatcher-1',
      ),
    ).toBe(true)
    // 两条监听被动都真的结算过（actor 口径 = `<实例id>#<能力id>`）
    const actors = result.log.map((entry) => entry.actor)
    expect(actors).toContain('1-cardWatcher-1#1')
    expect(actors).toContain('1-cardWatcher-1#2')
  })

  it('on_card_frozen / on_card_hasted / on_card_slowed：按 status 分派，duration 以**秒**给出', () => {
    const statuser = cardOf('statuser', { atk: 1 }, [
      {
        id: 1,
        kind: 'active',
        actions: [
          { do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', seconds: 1.5 },
          { do: 'apply_status', target: 'all_enemy_cards', status: 'slow', seconds: 2 },
          { do: 'apply_status', target: 'self', status: 'haste', seconds: 3 },
        ],
      },
    ])
    const watcher = cardOf('statusWatcher', { atk: 1 }, [
      listenAbility('on_card_frozen', { cmp: 'gt', left: { var: 'duration' }, right: 0 }),
      listenAbility('on_card_hasted', { cmp: 'gt', left: { var: 'duration' }, right: 0 }, 2),
      listenAbility('on_card_slowed', { cmp: 'gt', left: { var: 'duration' }, right: 0 }, 3),
    ])
    const target = cardOf('targetCard', { atk: 1 })

    const result = battle([watcher, statuser], [target], { captureFrames: true })

    // `duration` 落到帧事件的 `amount` 上，单位 = 秒（与 YAML 的书写单位一致，**不是 cs**）
    expect(eventsOf(result, 'on_card_frozen').some((entry) => entry.instanceId === '2-targetCard-1' && entry.amount === 1.5)).toBe(true)
    expect(eventsOf(result, 'on_card_slowed').some((entry) => entry.instanceId === '2-targetCard-1' && entry.amount === 2)).toBe(true)
    expect(eventsOf(result, 'on_card_hasted').some((entry) => entry.instanceId === '1-statuser-2' && entry.amount === 3)).toBe(true)
    const actors = result.log.map((entry) => entry.actor)
    expect(actors).toContain('1-statusWatcher-1#1')
    expect(actors).toContain('1-statusWatcher-1#2')
    expect(actors).toContain('1-statusWatcher-1#3')
  })

  it('on_card_charged：amount = 充能秒数，一次作用两张卡 ⇒ 两个实例', () => {
    const charger = cardOf('charger', { atk: 1 }, [
      { id: 1, kind: 'active', actions: [{ do: 'charge', target: 'all_own_cards', seconds: 0.5 }] },
    ])
    const watcher = cardOf('chargeWatcher', { atk: 1 }, [
      listenAbility('on_card_charged', { cmp: 'gt', left: { var: 'amount' }, right: 0 }),
    ])
    const dummy = cardOf('dummy', { atk: 1 })

    const result = battle([watcher, charger], [dummy], { captureFrames: true })
    const charged = eventsOf(result, 'on_card_charged')

    expect(charged.some((entry) => entry.instanceId === '1-chargeWatcher-1' && entry.amount === 0.5)).toBe(true)
    expect(charged.some((entry) => entry.instanceId === '1-charger-2' && entry.amount === 0.5)).toBe(true)
    expect(result.log.map((entry) => entry.actor)).toContain('1-chargeWatcher-1#1')
  })

  it('一次动作冻结 3 张卡 ⇒ 3 个实例：帧内 3 条事件，但该触发器每帧只释放一条', () => {
    const freezer = cardOf('freezer', { atk: 1 }, [
      {
        id: 1,
        kind: 'active',
        actions: [{ do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', seconds: 1 }],
      },
    ])
    const watcher = cardOf('multiWatcher', { atk: 1 }, [
      listenAbility('on_card_frozen', { cmp: 'gt', left: { var: 'duration' }, right: 0 }),
    ])

    const result = battle([freezer], [watcher, cardOf('plain2', { atk: 1 }), cardOf('plain3', { atk: 1 })], {
      captureFrames: true,
    })
    const frozenIndex = result.frames.findIndex((frame) =>
      frame.events.some((entry) => entry.event === 'on_card_frozen'),
    )
    const frozenFrame = needFrame(result.frames[frozenIndex], '冻结帧')

    // ① 记账全量：三张卡各一条（目标不同 ⇒ 三个实例）
    expect(frozenFrame.events.filter((entry) => entry.event === 'on_card_frozen').map((e) => e.instanceId)).toEqual([
      '2-multiWatcher-1',
      '2-plain2-2',
      '2-plain3-3',
    ])

    // ② 每帧只释放一条：本帧 1 次，随后两帧各 1 次，第三帧之后不再有
    const firedIn = (frame: FrameSnapshot): number =>
      result.log.filter((entry) => entry.actor === '2-multiWatcher-1#1' && entry.tick === frame.triggerFrame).length
    expect(firedIn(frozenFrame)).toBe(1)
    expect(firedIn(needFrame(result.frames[frozenIndex + 1], '冻结帧 +1'))).toBe(1)
    expect(firedIn(needFrame(result.frames[frozenIndex + 2], '冻结帧 +2'))).toBe(1)
    expect(firedIn(needFrame(result.frames[frozenIndex + 3], '冻结帧 +3'))).toBe(0)
  })
})

// ————————————————————————————————————————————————————————
// `{ var: <参数名>.<字段> }` —— 事件参数取属性（**平铺一层**，字段表与 `self.` 同一张；
// `card.stats.atk` 那种两级写法不合法）
// ————————————————————————————————————————————————————————

describe('事件参数取属性', () => {
  it('`{ var: card.atk }` 读到事件来源卡的数值；B 方自己的行动读到的不是同一个值', () => {
    // A 方：atk = 30、站在第 1 格的卡主动打人 ⇒ 它自己就是本次 `after_action` 的来源卡
    const striker = cardOf('striker', { atk: 30 }, [damageAbility({ ref: 'self.atk' })])
    // B 方：条件要求"来源卡的 atk 恰好 30，且来源卡在第 1 格（0 基索引 0）"
    const reflector = cardOf('reflector', { atk: 1 }, [
      {
        id: 1,
        kind: 'passive',
        trigger: { event: 'after_action' },
        condition: {
          all: [
            { cmp: 'eq', left: { var: 'card.atk' }, right: 30 },
            { cmp: 'eq', left: { var: 'card.slot_index' }, right: 0 },
          ],
        },
        actions: [{ do: 'gain_stat', stat: 'atk', amount: 1, target: 'self' }],
      },
    ])

    const result = battle([striker], [reflector], { captureFrames: true })

    // A 方那一次行动使条件成立 ⇒ 被动入日志（若取属性解析失败会直接抛错、整局中止）
    const fired = result.log.filter((entry) => entry.actor === '2-reflector-1#1')
    expect(fired.length).toBeGreaterThan(0)
    expect(result.state.finished).toBe(true)
    // 首次触发就落在 A 方首次行动那一帧（frame 15）
    expect(fired.some((entry) => entry.tick === 15)).toBe(true)
  })
})
