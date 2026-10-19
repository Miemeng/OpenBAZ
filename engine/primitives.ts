// 动作原语——封闭词表，8 个原语

//   deal_damage    造成伤害   { target, amount }
//   heal_player    治疗       { target, amount }
//   shield        护盾       { target, amount, duration? }
//   gain_stat      属性增减   { stat, amount, duration?, stackLimit?, target }
//   apply_status   卡牌状态   { target, status, duration }
//   charge        充能       { target, seconds }
//   destroy       失效       { target }
//   repair        修复       { target }

// 伤害口径：
// - 普通伤害 1 点护盾抵御 1 点；
// - 灼烧伤害每点护盾抵御 2 点（即 1 盾抵 2 伤，见 damageOverTime 的 burn 分支）；
// - 剧毒伤害无视护盾；
// - heal_player：X 治疗清除 0.05X 层灼烧与 0.05X 层剧毒。

// 本文件只做"对状态施加影响"，**不判定胜负**——胜负在 tick.ts 的 checkOutcome（见该文件注释）。
import {
  BURN_DECAY_RATIO,
  DOT_MIN_STACKS,
  actionPeriodCs,
  effectiveDotStacks,
  isDotTickAt,
  chargeActionBar,
  secondsToCs,
  syncActionBarPeriod,
} from './state.ts'
import { selectTargets, type Selection } from './selectors.ts'
import { recordSelectorMismatch } from './messages.ts'
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
  PrimitiveName,
  SelectorQuery,
} from './types.ts'
import type { EvalContext } from './expr.ts'
import { evaluateExpr } from './expr.ts'

/** 玩家侧持续效果通道 */
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
    ...(durationCs === undefined ? {} : { remainingCs: durationCs }),
  })
}

/**
 * 一次治疗结算的结果。
 *
 * `healed` = **实际恢复量**（满血时为 0）；`cleansedBurn` / `cleansedPoison` = 本次真正清掉的层数
 * （按 `healed × 0.05` 上限截断，层数本身可带小数，故这两个量也可能是小数）。
 */
export interface HealOutcome {
  readonly healed: number
  readonly cleansedBurn: number
  readonly cleansedPoison: number
}

/** 治疗：不超 maxHp；并按 0.05 比例清除灼烧与剧毒层数 */
export function healPlayerState(player: PlayerState, amount: number): HealOutcome {
  const healed = Math.min(amount, Math.max(player.maxHp - player.hp, 0))
  player.hp += healed
  const cleanse = healed * 0.05
  let cleansedBurn = 0
  let cleansedPoison = 0
  for (const dot of player.dots) {
    if (dot.kind !== 'burn' && dot.kind !== 'poison') continue
    const before = dot.stacks
    dot.stacks = Math.max(dot.stacks - cleanse, 0)
    if (dot.kind === 'burn') cleansedBurn += before - dot.stacks
    else cleansedPoison += before - dot.stacks
  }
  const cleaned = player.dots.filter((dot) => dot.stacks >= DOT_MIN_STACKS)
  if (cleaned.length !== player.dots.length) player.dots = cleaned
  return { healed, cleansedBurn, cleansedPoison }
}

/**
 * 持续效果跳变的回血路径：**只回血、不做净化**。
 *
 * 与《规则说明书》§18.5 一致 —— 再生（`regen`）的周期结算由引擎直接调用、跳过净化环节，
 * 故不会按 `healed × 0.05` 削减灼烧 / 剧毒层数（那是 `heal_player` 原语的口径）。
 *
 * @param amount 本次应恢复量（**整数**；净值结算时 = 毒 / 再生的净值）
 * @returns 实际恢复量（不超 `maxHp`；满血时为 0）
 */
export function healPlayerNoCleanse(player: PlayerState, amount: number): number {
  const healed = Math.min(amount, Math.max(player.maxHp - player.hp, 0))
  player.hp += healed
  return healed
}

/** 施加 / 叠加护盾 */
export function addShield(player: PlayerState, amount: number): number {
  player.shield += amount
  return amount
}

/**
 * 施加卡牌状态。三者独立计时、不互相覆盖：**同类再次施加 ⇒ 时长叠加**（RW 2026-10-19 裁定，
 * 取代旧的"取较大者"），异类则并存。
 *
 * 周期若因这次施加而变化（加速 / 减速；冰冻不算）则**按比例缩放行动条**，见 `syncActionBarPeriod`。
 *
 * @param durationCs 时长（**cs，整数**）；YAML 的秒 → cs 换算由调用方（applyAction）完成，
 *   与本文件其余内部信号保持同一单位口径
 */
export function applyCardStatus(boardCard: BoardCard, kind: CardStatusKind, durationCs: number): void {
  const periodBeforeCs = actionPeriodCs(boardCard)
  const existing = boardCard.statuses.find((status) => status.kind === kind)
  if (existing !== undefined) {
    // 同类叠加**不改变周期**（状态本来就在），故不需要缩放行动条
    existing.remainingCs += durationCs
    return
  }
  boardCard.statuses.push({ kind, remainingCs: durationCs })
  syncActionBarPeriod(boardCard, periodBeforeCs)
}

/**
 * 结算一条动作。
 *
 * 目标类型不匹配**先记一条 error 级
 * `selector.type_mismatch`、再抛异常中止对局**。
 * **合法选择器但零目标仍是静默**（不记消息、不抛错、不改状态）。
 *
 * @returns 每条受影响目标的观测结果（空数组 = 选择器没选到任何目标，属正常情况）
 */
export function applyAction(state: BattleState, spec: ActionSpec, context: EvalContext): ActionEffect[] {
  const effects: ActionEffect[] = []
  const selector: string | SelectorQuery = spec.target ?? 'self'
  const selection = selectForEffect(state, spec, selector, context)
  assertSelectionMatches(state, spec, selector, selection, context)

  const amountExpr = spec.amount
  const amount = amountExpr === undefined ? 0 : evaluateExpr(amountExpr, context)
  const seconds = spec.seconds === undefined ? 0 : evaluateExpr(spec.seconds, context)
  // `duration` 在 YAML 里以**秒**书写（两位小数），这里换算成 cs 后交给内部信号；
  // 同时留一份**作者可见的秒数**（`durationSeconds`）—— "卡牌状态类"事件广播按秒给参数。
  // 只求值一次：表达式里可能含 `{ count }` 选择器，重复求值会让随机分支多抽一次 rng。
  const durationValue = spec.duration === undefined ? undefined : evaluateExpr(spec.duration, context)
  const durationCs = durationValue === undefined ? undefined : secondsToCs(durationValue)
  const durationSeconds = durationValue ?? seconds

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
      // 卡牌目标不可达：`deal_damage` 只处理玩家，选到卡牌已由 assertSelectionMatches 抛错。
      // 原来这里有一段"作用于卡牌 = 无损失 + 广播 on_card_damaged"的防御分支，随该时机词一起删除
      // （ ``）。
      break
    }

    case 'heal_player': {
      for (const side of selection.players) {
        const target = state.players[side]
        const outcome = healPlayerState(target, amount)
        effects.push({
          kind: 'heal',
          targetSide: side,
          amount: outcome.healed,
          absorbed: 0,
          hpAfter: target.hp,
          shieldAfter: target.shield,
          cleansedBurn: outcome.cleansedBurn,
          cleansedPoison: outcome.cleansedPoison,
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
            dots: [stat],
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
            ...(spec.stackLimit === undefined ? {} : { stackLimit: spec.stackLimit }),
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
      // 状态时长口径与 applyDot 一致：`duration` 缺省时退回 `seconds`（两者都按秒书写）。
      // `durationSeconds` 已在函数开头统一算好（秒），这里只做一次秒 → cs 的换算。
      const statusDurationCs = secondsToCs(durationSeconds)
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
          durationSeconds,
        })
      }
      break
    }

    case 'charge': {
      for (const boardCard of selection.cards) {
        // 充能 = 行动条直接推进 X 秒，单位换算在 chargeActionBar 内完成（秒 → cs）。
        // 不在此截断 gauge 上限："单次充能最多让同一张卡记账一次"由"同一卡同一 cs 至多记账一次"
        // 保证（见 tick.ts 的 recordedThisCs），"效果每 20cs 窗口至多一条"由限流窗口保证；
        // 而截断会丢掉余量、拉长高速卡的行动间隔。
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

    case 'enchant': {
      // 施魔（AD.4 = A）：把目标卡的"当前生效附魔"写成这一件。
      // **整件替换**：三块效果（stats / aura / actions）一律只认当前 id ⇒ 不需要任何回滚代码。
      // 目标卡目录里没有该 id ⇒ **静默跳过**（校验期只能看施法者自己的目录）。
      const enchantId = spec.enchant
      if (enchantId !== undefined) {
        for (const boardCard of selection.cards) {
          const exists = (boardCard.card.enchantments ?? []).some((enchant) => enchant.id === enchantId)
          if (!exists) continue
          boardCard.enchant = enchantId
          effects.push({
            kind: 'enchant',
            targetSide: boardCard.owner,
            amount: 0,
            absorbed: 0,
            hpAfter: state.players[boardCard.owner].hp,
            shieldAfter: state.players[boardCard.owner].shield,
            card: boardCard,
            enchantId,
          })
        }
      }
      break
    }

    default: {
      // 封闭词表：写错即报错并给建议
      const exhaustive: never = spec.do
      throw new Error(`未知动作原语：${String(exhaustive)}`)
    }
  }

  return effects
}

/**
 * 选择器求值（转发到 selectors.ts，保持 applyAction 可读）。
 * 两种写法（字符串缩写 / 查询对象）语义等价。
 *
 * **先记一条 error 级消息、再抛**：契约 / 书写错误
 * （未知选择器名、未知查询字段、`filter` 引用不存在字段或类型不匹配、排序键拼写错误、
 * `random` 与 `sort` 同写…）全部从 `selectTargets` 抛出，这里统一兜住，让"抛错中止对局"
 * 的路径也在 `BattleState.messages` 里留下可检索的结构化记录。
 * 目标类型不匹配不在此处记 —— 它由 `assertSelectionMatches` 自己记，
 * 避免同一次失败被记两条。
 */
function selectForEffect(
  state: BattleState,
  spec: ActionSpec,
  selector: string | SelectorQuery,
  context: EvalContext,
): Selection {
  try {
    return selectTargets(selector, context)
  } catch (error) {
    recordSelectorMismatch(state, {
      tick: context.tick,
      side: context.side,
      ...(context.self === null ? {} : { actor: context.self.instanceId }),
      primitive: spec.do,
      selector: selectorText(selector),
      detail: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** 供报错 / 记账用的选择器文本（查询对象按 `{ k=v, … }` 展开，保证日志可检索） */
export function selectorText(selector: string | SelectorQuery): string {
  if (typeof selector === 'string') return selector
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector)) {
    parts.push(`${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
  }
  return `{ ${parts.join(', ')} }`
}

/**
 * 各原语允许的目标类型。
 * - `players` = 选到玩家是否合法；`cards` = 选到卡牌是否合法。
 *
 * **注意**（ 的两个例外，不要"顺手"收紧）：
 * - 卡牌侧 `gain_stat` 的 `atk` / `shield` / `heal` 等**卡面字面量仍然允许**（卡牌 buff 的正常通道）；
 * - 玩家侧的 `burn` / `poison` / `regen` 也**仍然允许**（DOT 施加给玩家）。
 *
 * 只有"玩家侧的非 DOT stat"（如 `atk`）与"卡牌侧的 DOT stat"是 ❌ —— 这两条按 `DOT_STATS`
 * 对 `gain_stat` 作**双向**判定，见 `assertSelectionMatches`。
 */
const PRIMITIVE_TARGET_RULES: Readonly<Record<PrimitiveName, {
  readonly players: boolean
  readonly cards: boolean
}>> = {
  deal_damage: { players: true, cards: false },
  heal_player: { players: true, cards: false },
  shield: { players: true, cards: false },
  gain_stat: { players: true, cards: true },
  apply_status: { players: false, cards: true },
  charge: { players: false, cards: true },
  destroy: { players: false, cards: true },
  repair: { players: false, cards: true },
  enchant: { players: false, cards: true },
}

/**
 * 检查"原语 × 选中目标类型"是否匹配。
 *
 * **顺序很重要**：先记账、再抛错。零目标直接返回 —— 静默。
 *
 * @throws 目标类型与效果不匹配时抛 `Error`
 */
function assertSelectionMatches(
  state: BattleState,
  spec: ActionSpec,
  selector: string | SelectorQuery,
  selection: Selection,
  context: EvalContext,
): void {
  if (selection.players.length === 0 && selection.cards.length === 0) return
  const rule = PRIMITIVE_TARGET_RULES[spec.do]
  const text = selectorText(selector)

  let detail: string | null = null
  if (!rule.players && selection.players.length > 0) {
    detail = `原语 ${spec.do} 只能作用于卡牌，但选择器选到了玩家`
  } else if (!rule.cards && selection.cards.length > 0) {
    detail = `原语 ${spec.do} 只能作用于玩家，但选择器选到了卡牌`
  } else if (spec.do === 'gain_stat' && spec.stat !== undefined) {
    // 玩家侧只认持续效果通道；卡牌侧反之（卡牌没有 DOT 通道）—— 的两个例外
    const stat = spec.stat
    if (selection.players.length > 0 && !DOT_STATS.has(stat)) {
      detail = `原语 gain_stat 施加给玩家的 stat「${stat}」不是持续效果（只允许 burn / poison / regen）`
    } else if (selection.cards.length > 0 && DOT_STATS.has(stat)) {
      detail = `原语 gain_stat 不能把持续效果「${stat}」施加给卡牌（卡牌没有持续效果通道）`
    }
  }

  if (detail === null) return

  recordSelectorMismatch(state, {
    tick: context.tick,
    side: context.side,
    ...(context.self === null ? {} : { actor: context.self.instanceId }),
    primitive: spec.do,
    selector: text,
    detail,
  })
  throw new Error(`${detail}（选择器 ${text}； /  第 12 条）`)
}

/**
 * 推进一方的持续效果（灼烧 / 剧毒 / 再生）**一个全局帧**。
 *
 * **相位 = 全局 cs 网格**（`isDotTickAt`），与施加时刻无关：
 * - 灼烧：每 50cs（0.5s）跳伤（1 盾抵 2 伤）、层数 ×0.8；**层数保留小数**（唯一豁免累加器），
 *   只有"算伤害"这一处按四舍五入取整读取；
 * - 剧毒与再生：每 100cs（1s）到点，且**合并为一次净值结算** —— 先毒后再生，
 *   `净变化 = 再生读数 − 剧毒读数`：为负则按剧毒口径扣血（无视护盾）、为正则按再生口径回血
 *   （受 `maxHp` 截断，**不净化**）、为 0 则血量不变但仍算一次结算。
 *
 * **合并粒度 = 玩家 × 种类**：同一玩家同一种类的多个实例合成**一次**结算，
 * 读数 = `Σ 实例 stacks + 光环贡献`（`effectiveDotStacks`）；灼烧的 `×0.8` 仍逐实例施加。
 *
 * 本函数**不判定胜负**，跳变后的因果点判定由主循环（tick.ts）负责。
 *
 * @returns 本次到点产生的观测结果（一个全局帧内最多 2 条：灼烧 1 条 + 毒/再生净值 1 条）
 */
export function advanceDots(state: BattleState, player: PlayerState): ActionEffect[] {
  const effects: ActionEffect[] = []
  if (player.dots.length === 0) return effects

  // —— 灼烧：0.5s 网格，独立结算 ——
  if (hasDotKind(player, 'burn') && isDotTickAt('burn', state.timeCs)) {
    const burnStacks = effectiveDotStacks(state, player, 'burn')
    const { hpDelta, absorbed } = dealDamageToPlayer(player, burnStacks, 2)
    // 衰减逐实例施加（合计等效 ×BURN_DECAY_RATIO，不写派生态）
    for (const dot of player.dots) {
      if (dot.kind === 'burn') dot.stacks *= BURN_DECAY_RATIO
    }
    effects.push({
      kind: 'damage',
      targetSide: player.id,
      amount: hpDelta,
      absorbed,
      hpAfter: player.hp,
      shieldAfter: player.shield,
      dots: ['burn'],
      burnStacks,
    })
  }

  // —— 剧毒 + 再生：1s 网格，合并为**一次净值结算**（顺序：先毒后再生）——
  const poisonAt = hasDotKind(player, 'poison') && isDotTickAt('poison', state.timeCs)
  const regenAt = hasDotKind(player, 'regen') && isDotTickAt('regen', state.timeCs)
  if (poisonAt || regenAt) {
    const dots: DotKind[] = []
    if (poisonAt) dots.push('poison')
    if (regenAt) dots.push('regen')
    const poisonStacks = poisonAt ? effectiveDotStacks(state, player, 'poison') : 0
    const regenStacks = regenAt ? effectiveDotStacks(state, player, 'regen') : 0
    const base = {
      targetSide: player.id,
      dots,
      ...(poisonAt ? { poisonStacks } : {}),
      ...(regenAt ? { regenStacks } : {}),
    }
    const net = regenStacks - poisonStacks
    if (net < 0) {
      // 净值为负 ⇒ 按剧毒口径扣血（无视护盾、不衰减）
      const { hpDelta } = dealDamageToPlayer(player, -net, 0)
      effects.push({
        ...base,
        kind: 'damage',
        amount: hpDelta,
        absorbed: 0,
        hpAfter: player.hp,
        shieldAfter: player.shield,
      })
    } else {
      // 净值为正（或 0）⇒ 按再生口径回血（不超 maxHp；**跳过净化环节**）
      const healed = healPlayerNoCleanse(player, net)
      effects.push({
        ...base,
        kind: 'heal',
        amount: healed,
        absorbed: 0,
        hpAfter: player.hp,
        shieldAfter: player.shield,
      })
    }
  }

  // 层数视为耗尽即移除
  const kept = player.dots.filter((dot) => dot.stacks >= DOT_MIN_STACKS)
  if (kept.length !== player.dots.length) player.dots = kept
  return effects
}

/** 该玩家身上是否已有某种持续效果实例（光环给的派生态层数不单独触发结算） */
function hasDotKind(player: PlayerState, kind: DotKind): boolean {
  return player.dots.some((dot) => dot.kind === kind)
}


/** 纯被动卡判定：cooldown = -1 表示无行动条、不结算任何主动效果 */
export function isPassiveOnly(boardCard: BoardCard): boolean {
  return boardCard.card.cooldown < 0
}
