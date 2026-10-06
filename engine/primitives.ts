// 动作原语（规则 §9）——封闭词表，8 个原语
//
//   deal_damage    造成伤害   { target, amount }
//   heal_player    治疗       { target, amount }
//   shield        护盾       { target, amount, duration? }
//   gain_stat      属性增减   { stat, amount, duration?, stack_limit?, target }
//   apply_status   卡牌状态   { target, status, duration }
//   charge        充能       { target, seconds }
//   destroy       失效       { target }
//   repair        修复       { target }
//
// 伤害口径（规则 §2 护盾行 + §9）：
// - 普通伤害 1 点护盾抵御 1 点；
// - 灼烧伤害每点护盾抵御 2 点（即 1 盾抵 2 伤，见 damageOverTime 的 burn 分支）；
// - 剧毒伤害无视护盾；
// - heal_player：X 治疗清除 0.05X 层灼烧与 0.05X 层剧毒。
//
// 本文件只做"对状态施加影响"，**不判定胜负**——胜负在 tick.ts 的 checkOutcome（见该文件注释）。
import {
  BURN_DECAY_RATIO,
  DOT_MIN_STACKS,
  DOT_PERIOD_CS,
  GLOBAL_FRAME_CS,
  chargeActionBar,
  effectiveStat,
  secondsToCs,
} from './state.ts'
import { selectTargets, type Selection } from './selectors.ts'
// ActionEffect 定义在 types.ts（公共契约），此处再导出，保持 `from './primitives.ts'` 的旧写法可用
export type { ActionEffect } from './types.ts'
import type {
  ActionEffect,
  ActionSpec,
  BoardCard,
  BattleState,
  CardStatusKind,
  DotKind,
  PlayerState,
} from './types.ts'
import type { EvalContext } from './expr.ts'
import { evaluateExpr } from './expr.ts'

/** 玩家侧持续效果通道（gain_stat 的 stat 命中这三个词时改走这里，规则 §9 gain_stat 说明） */
const DOT_STATS: ReadonlySet<string> = new Set<DotKind>(['burn', 'poison', 'regen'])

function isDotKind(stat: string): stat is DotKind {
  return DOT_STATS.has(stat)
}

/**
 * 对玩家造成伤害。先扣护盾、再扣血量。
 *
 * @param shieldCostPerDamage 每点护盾能抵御多少点该种伤害（普通 1、灼烧 2、剧毒 0=无视护盾）
 */
export function dealDamageToPlayer(
  player: PlayerState,
  amount: number,
  shieldCostPerDamage: number,
): { readonly hpDelta: number; readonly absorbed: number } {
  if (amount <= 0) return { hpDelta: 0, absorbed: 0 }

  if (shieldCostPerDamage <= 0 || player.shield <= 0) {
    const dealt = Math.min(amount, Math.max(player.hp, 0))
    player.hp -= dealt
    return { hpDelta: dealt, absorbed: 0 }
  }

  const absorbable = Math.min(amount, player.shield * shieldCostPerDamage)
  const shieldSpent = absorbable / shieldCostPerDamage
  player.shield -= shieldSpent
  if (player.shield < 0) player.shield = 0

  const remaining = amount - absorbable
  const dealt = Math.min(remaining, Math.max(player.hp, 0))
  player.hp -= dealt
  return { hpDelta: dealt, absorbed: absorbable }
}

/**
 * 施加 / 叠加一条持续效果实例（同 kind 同 source 累加层数）。
 *
 * @param durationCs 时长（cs，整数）；undefined = 常驻
 */
export function applyDot(
  player: PlayerState,
  kind: DotKind,
  stacks: number,
  source: string,
  durationCs?: number,
): void {
  const existing = player.dots.find((dot) => dot.kind === kind && dot.source === source)
  if (existing !== undefined) {
    existing.stacks += stacks
    if (durationCs !== undefined) existing.remainingCs = durationCs
    return
  }
  player.dots.push({
    kind,
    stacks,
    source,
    nextTickCs: DOT_PERIOD_CS[kind],
    ...(durationCs === undefined ? {} : { remainingCs: durationCs }),
  })
}

/** 治疗：不超 maxHp；并按 0.05 比例清除灼烧与剧毒层数（规则 §9 heal_player） */
export function healPlayerState(player: PlayerState, amount: number): number {
  const healed = Math.min(amount, Math.max(player.maxHp - player.hp, 0))
  player.hp += healed
  const cleanse = healed * 0.05
  for (const dot of player.dots) {
    if (dot.kind === 'burn' || dot.kind === 'poison') {
      dot.stacks = Math.max(dot.stacks - cleanse, 0)
    }
  }
  const cleaned = player.dots.filter((dot) => dot.stacks >= DOT_MIN_STACKS)
  if (cleaned.length !== player.dots.length) player.dots = cleaned
  return healed
}

/** 施加 / 叠加护盾（单一护盾池、总额累加，规则 §9 shield） */
export function addShield(player: PlayerState, amount: number): number {
  player.shield += amount
  return amount
}

/**
 * 施加卡牌状态。三者独立计时、不互相覆盖：同类则刷新时长（取较大者），异类则并存。
 *
 * @param durationCs 时长（**cs，整数**）；YAML 的秒 → cs 换算由调用方（applyAction）完成，
 *   与本文件其余内部信号保持同一单位口径
 */
export function applyCardStatus(boardCard: BoardCard, kind: CardStatusKind, durationCs: number): void {
  const existing = boardCard.statuses.find((status) => status.kind === kind)
  if (existing !== undefined) {
    existing.remainingCs = Math.max(existing.remainingCs, durationCs)
    return
  }
  boardCard.statuses.push({ kind, remainingCs: durationCs })
}

/**
 * 结算一条动作。
 *
 * @returns 每条受影响目标的观测结果（空数组 = 选择器没选到任何目标，属正常情况）
 */
export function applyAction(state: BattleState, spec: ActionSpec, context: EvalContext): ActionEffect[] {
  const effects: ActionEffect[] = []
  const selector = spec.target ?? 'self'
  const selection = selectForEffect(selector, context)

  const amountExpr = spec.amount
  const amount = amountExpr === undefined ? 0 : evaluateExpr(amountExpr, context)
  const seconds = spec.seconds === undefined ? 0 : evaluateExpr(spec.seconds, context)
  // duration 在 YAML 里同样以**秒**书写（两位小数），这里换算成 cs 后交给内部信号
  const durationCs = spec.duration === undefined ? undefined : secondsToCs(evaluateExpr(spec.duration, context))

  switch (spec.do) {
    case 'deal_damage': {
      for (const side of selection.players) {
        const target = state.players[side]
        const { hpDelta, absorbed } = dealDamageToPlayer(target, amount, 1)
        effects.push({
          kind: 'damage',
          targetSide: side,
          amount: hpDelta,
          absorbed,
          hpAfter: target.hp,
          shieldAfter: target.shield,
        })
      }
      // 作用于卡牌时仅广播 on_card_damaged，无实际损失（规则 §9 deal_damage 说明）
      for (const boardCard of selection.cards) {
        effects.push({
          kind: 'damage',
          targetSide: boardCard.owner,
          amount: 0,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
        })
      }
      break
    }

    case 'heal_player': {
      for (const side of selection.players) {
        const target = state.players[side]
        const healed = healPlayerState(target, amount)
        effects.push({
          kind: 'heal',
          targetSide: side,
          amount: healed,
          absorbed: 0,
          hpAfter: target.hp,
          shieldAfter: target.shield,
        })
      }
      break
    }

    case 'shield': {
      for (const side of selection.players) {
        const target = state.players[side]
        const gained = addShield(target, amount)
        effects.push({
          kind: 'shield',
          targetSide: side,
          amount: gained,
          absorbed: 0,
          hpAfter: target.hp,
          shieldAfter: target.shield,
        })
      }
      break
    }

    case 'gain_stat': {
      const stat = spec.stat
      if (stat === undefined) throw new Error('gain_stat 必须指定 stat')
      for (const side of selection.players) {
        const target = state.players[side]
        if (isDotKind(stat)) {
          applyDot(target, stat, amount, context.self?.instanceId ?? 'skill', durationCs)
          effects.push({
            kind: 'stat',
            targetSide: side,
            amount,
            absorbed: 0,
            hpAfter: target.hp,
            shieldAfter: target.shield,
            stat,
            dot: stat,
          })
        } else {
          // 玩家侧的一般数值修正（如 maxHp）暂时只记录，等角色 YAML 落地后并入
          effects.push({
            kind: 'stat',
            targetSide: side,
            amount,
            absorbed: 0,
            hpAfter: target.hp,
            shieldAfter: target.shield,
            stat,
          })
        }
      }
      for (const boardCard of selection.cards) {
        const source = context.self?.instanceId ?? 'skill'
        const existing = boardCard.stats.find((modifier) => modifier.stat === stat && modifier.source === source)
        if (existing !== undefined) {
          existing.amount += amount
          if (durationCs !== undefined) existing.remainingCs = durationCs
        } else {
          boardCard.stats.push({
            stat,
            amount,
            source,
            ...(durationCs === undefined ? {} : { remainingCs: durationCs }),
            ...(spec.stack_limit === undefined ? {} : { stack_limit: spec.stack_limit }),
          })
        }
        effects.push({
          kind: 'stat',
          targetSide: boardCard.owner,
          amount,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
          stat,
        })
      }
      break
    }

    case 'apply_status': {
      const status = spec.status
      if (status === undefined) throw new Error('apply_status 必须指定 status')
      // 状态时长口径与 applyDot 一致：`duration` 缺省时退回 `seconds`（两者都按秒书写，
      // 已在函数开头统一换算成 durationCs / seconds）。这里 durationCs 已是 cs，
      // 而 seconds 仍是秒，故缺省路径单独换算，避免把 cs 当成秒再乘 100。
      const statusDurationCs = durationCs ?? secondsToCs(seconds)
      for (const boardCard of selection.cards) {
        applyCardStatus(boardCard, status, statusDurationCs)
        effects.push({
          kind: 'status',
          targetSide: boardCard.owner,
          amount: 0,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
          status,
        })
      }
      break
    }

    case 'charge': {
      for (const boardCard of selection.cards) {
        // 充能 = 行动条直接推进 X 秒（规则 §9），单位换算在 chargeActionBar 内完成（秒 → cs）。
        // 不在此截断 gauge 上限："单次充能最多触发一次主动行动"由"同一卡同一触发帧最多
        // 执行一次主动行动"保证（规则 §6.3 第 5 条），而截断会丢掉余量、拉长高速卡的行动间隔。
        chargeActionBar(boardCard, seconds)
        effects.push({
          kind: 'charge',
          targetSide: boardCard.owner,
          amount: seconds,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
        })
      }
      break
    }

    case 'destroy': {
      for (const boardCard of selection.cards) {
        boardCard.destroyed = true
        effects.push({
          kind: 'destroy',
          targetSide: boardCard.owner,
          amount: 0,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
        })
      }
      break
    }

    case 'repair': {
      for (const boardCard of selection.cards) {
        boardCard.destroyed = false
        effects.push({
          kind: 'repair',
          targetSide: boardCard.owner,
          amount: 0,
          absorbed: 0,
          hpAfter: state.players[boardCard.owner].hp,
          shieldAfter: state.players[boardCard.owner].shield,
          card: boardCard,
        })
      }
      break
    }

    default: {
      // 封闭词表：写错即报错并给建议（AGENT.md §5.4）
      const exhaustive: never = spec.do
      throw new Error(`未知动作原语：${String(exhaustive)}（封闭词表见规则 §9）`)
    }
  }

  return effects
}

/** 选择器求值（转发到 selectors.ts，保持 applyAction 可读） */
function selectForEffect(selector: string, context: EvalContext): Selection {
  return selectTargets(selector, context)
}

/**
 * 推进一方的持续效果（灼烧 / 剧毒 / 再生）**一个全局帧**（0.01s，规则 §14/§15 的 0a）。
 *
 * - 灼烧：每 50cs（0.5s）跳伤（1 盾抵 2 伤）、层数 ×0.8；**层数保留小数**（唯一豁免累加器），
 *   只有"算伤害"这一处按四舍五入取整读取；
 * - 剧毒：每 100cs（1s）跳伤、无视护盾、不衰减；
 * - 再生：每 100cs（1s）回血、不衰减。
 *
 * 周期计时用整数 cs 累加（不会像浮点累加那样产生相位漂移）；
 * 本函数**不判定胜负**，跳伤后的因果点判定由主循环（tick.ts）负责。
 *
 * @returns 本次真正发生的跳伤/回血观测结果（一个全局帧内最多各 1 次，供日志）
 */
export function advanceDots(player: PlayerState): ActionEffect[] {
  const effects: ActionEffect[] = []
  if (player.dots.length === 0) return effects

  for (const dot of [...player.dots]) {
    dot.nextTickCs -= GLOBAL_FRAME_CS
    if (dot.nextTickCs > 0) continue

    // 对外读取（算伤害）时取整：层数累加器内部保留小数，见 DotInstance.stacks 的说明
    const stacks = Math.round(dot.stacks)

    switch (dot.kind) {
      case 'burn': {
        const { hpDelta, absorbed } = dealDamageToPlayer(player, stacks, 2)
        dot.stacks *= BURN_DECAY_RATIO
        effects.push({
          kind: 'damage',
          targetSide: player.id,
          amount: hpDelta,
          absorbed,
          hpAfter: player.hp,
          shieldAfter: player.shield,
          dot: 'burn',
        })
        break
      }
      case 'poison': {
        const { hpDelta } = dealDamageToPlayer(player, stacks, 0)
        effects.push({
          kind: 'damage',
          targetSide: player.id,
          amount: hpDelta,
          absorbed: 0,
          hpAfter: player.hp,
          shieldAfter: player.shield,
          dot: 'poison',
        })
        break
      }
      case 'regen': {
        const healed = healPlayerState(player, stacks)
        effects.push({
          kind: 'heal',
          targetSide: player.id,
          amount: healed,
          absorbed: 0,
          hpAfter: player.hp,
          shieldAfter: player.shield,
          dot: 'regen',
        })
        break
      }
    }
    dot.nextTickCs += DOT_PERIOD_CS[dot.kind]
  }

  // 层数视为耗尽即移除（规则 §14 的层数豁免：清除阈值 0.01，见 DOT_MIN_STACKS）
  const kept = player.dots.filter((dot) => dot.stacks >= DOT_MIN_STACKS)
  if (kept.length !== player.dots.length) player.dots = kept
  return effects
}

/** 纯被动卡判定：cooldown = -1 表示无行动条、不结算任何主动效果（规则 §5） */
export function isPassiveOnly(boardCard: BoardCard): boolean {
  return boardCard.card.cooldown < 0
}

/** 卡牌当前攻击值（含 buff），供卡面效果经 `{ ref: self.atk }` 读取；引擎不会自行使用它 */
export function attackOf(boardCard: BoardCard): number {
  return effectiveStat(boardCard, 'atk')
}
