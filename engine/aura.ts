// 光环派生态

// 职责：**每个触发帧边界**把所有在场来源的光环整体重新求值一次，结果作为
// **只读派生态快照**替换 `BattleState.auras`。数值读取层（`state.ts` 的 `effectiveStat` /
// `effectiveDotStacks`）只读快照 ⇒ 光环**不落任何状态**：无叠加层数、无时长、无退场回滚
// 。

// 为什么必须"边界集中求值"而不是"每次读数现算"：
//   1. `effectiveStat` 会被 `selectors.ts` 的排序比较器调用，而光环自己的 `select`
//      也要走 `selectTargets` ⇒ 若现算、且 `select` 写了 `<stat>_asc/_desc`，
//      就会**无限递归**；
//   2. `select` 允许 `random`，现算会让 rng 消耗次数
//      随"读了几次数值"漂移，破坏确定性。

// 依赖方向：本文件 import `state` / `selectors` / `expr`，**反之不成立**
// （`state.ts` 不 import 本文件，空快照与拷贝写在 `state.ts` 内），故无循环依赖。
import { activeEnchantOf, opponentOf } from './state.ts'
import { selectTargets } from './selectors.ts'
import { evaluateCardFilter, evaluateCondition, type EvalContext } from './expr.ts'
import type {
  AuraDef,
  AuraEntry,
  BattleState,
  BoardCard,
  DotKind,
  LogLevel,
  LogMessage,
  MessageCode,
  PlayerId,
  PlayerState,
  SelectorQuery,
} from './types.ts'

// ————————————————————————————————————————————————————————
// 合法值域
// ————————————————————————————————————————————————————————

/** 玩家侧唯一可施加的数值名 */
const DOT_KINDS: ReadonlySet<string> = new Set<DotKind>(['burn', 'poison', 'regen'])

/**
 * `apply` 通道禁止的数值名：`speed`与加速 / 减速 / 冰冻
 * 三个 status 数值位（ 第 5 条「`status` 一律禁止」在本实现里的落点）。
 */
const FORBIDDEN_APPLY_STATS: ReadonlySet<string> = new Set(['speed', 'haste', 'slow', 'freeze'])

/** `mul` 通道再禁 `cdp` */
const FORBIDDEN_MUL_STATS: ReadonlySet<string> = new Set(['speed', 'cdp', 'haste', 'slow', 'freeze'])

// ————————————————————————————————————————————————————————
// 内部结构
// ————————————————————————————————————————————————————————

/** 累积中的合计（与 `AuraTotals` 同形，仅可写） */
interface Totals {
  flat: number
  factor: number
}

/** 一条光环的来源描述 */
interface AuraSource {
  readonly def: AuraDef
  /** 来源所属方：决定 `select` 里 `own` / `enemy` 的视角 */
  readonly side: PlayerId
  /** 来源标识：卡牌 = `instanceId`；技能 = `技能:<skill_id>` */
  readonly source: string
  /** 来源卡（技能光环无来源卡 ⇒ null） */
  readonly self: BoardCard | null
  /** 无来源卡时的 `self.<stat>` 取值来源：技能自带 stats */
  readonly selfStats: Readonly<Record<string, number>> | undefined
}

/** 一帧的累积器 */
interface Accumulator {
  readonly entries: AuraEntry[]
  readonly cards: Map<string, Map<string, Totals>>
  readonly dots: Map<string, number>
}

/** 光环条目的稳定标识 = 来源 × 通道 × 数值名 × 目标 */
function entryKey(entry: AuraEntry): string {
  return `${entry.source}|${entry.channel}|${entry.stat}|${entry.target}`
}

/**
 * 选择器文本（只用于报错 / 记账）。`primitives.ts` / `expr.ts` 各有一份同名实现，
 * 这里就地展开是为了避免为一个纯格式化函数引入跨模块依赖。
 */
function selectorText(selector: string | SelectorQuery): string {
  if (typeof selector === 'string') return selector
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector)) {
    parts.push(`${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
  }
  return `{ ${parts.join(', ')} }`
}

// ————————————————————————————————————————————————————————
// 定义级校验（数据契约错误 ⇒ 直接抛错中止；静态校验由 sim:validate 承担）
// ————————————————————————————————————————————————————————

/**
 * 校验一条光环定义（`apply` / `mul` 的**写法**，与目标无关）。
 *
 * 这些是"数据写错了"而非"选择器选错类型"，故**不记 `selector.type_mismatch`**
 *
 * 静态版本由后续的 `sim:validate` 在校验期拦下。
 */
function validateAuraDef(def: AuraDef, source: string): void {
  const apply = def.apply ?? []
  const mul = def.mul ?? []
  if (apply.length === 0 && mul.length === 0) {
    throw new Error(`光环 ${source} 的 apply 与 mul 至少一条非空`)
  }

  const seenApply = new Set<string>()
  for (const item of apply) {
    if (FORBIDDEN_APPLY_STATS.has(item.stat)) {
      throw new Error(
        `光环 ${source} 的 apply 不得作用于 ${item.stat}：speed 只能改 cooldown / cdp，` +
          `加速 / 减速 / 冰冻一律禁止`,
      )
    }
    if (seenApply.has(item.stat)) {
      throw new Error(
        `光环 ${source} 在同一条 apply 里重复写了 ${item.stat}：` +
          `单条光环内不得重复写同一效果`,
      )
    }
    seenApply.add(item.stat)
  }

  const seenMul = new Set<string>()
  for (const item of mul) {
    if (FORBIDDEN_MUL_STATS.has(item.stat)) {
      throw new Error(
        `光环 ${source} 的 mul 不得作用于 ${item.stat}：倍率只作用于卡牌 stats 最终读数，` +
          `不含 speed / cdp，也不含 status`,
      )
    }
    if (seenMul.has(item.stat)) {
      throw new Error(
        `光环 ${source} 在同一条 mul 里重复写了 ${item.stat}：` +
          `单条光环内不得重复写同一效果`,
      )
    }
    seenMul.add(item.stat)
  }
}

// ————————————————————————————————————————————————————————
// 求值上下文（与 `tick.ts` 的 `makeContext` 同形；`this` 额外绑定到光环来源卡）
// ————————————————————————————————————————————————————————

function makeAuraContext(
  state: BattleState,
  source: AuraSource,
  emitMessage: (message: LogMessage) => void,
): EvalContext {
  const side = source.side
  return {
    state,
    rng: state.rng,
    self: source.self,
    tick: state.triggerFrame,
    ...(source.selfStats === undefined ? {} : { selfStats: source.selfStats }),
    side,
    vars: {},
    // 光环顶层 `condition` 的 `this` = 光环来源卡（技能光环无来源卡 ⇒ 不绑定，
    // 此时 `this.*` 按既有行为抛"引用根不可用"）。
    ...(source.self === null ? {} : { this: source.self }),
    filterResolver: evaluateCardFilter,
    notify: (text: string): void => {
      emitMessage({
        level: 'note',
        code: 'selector.sort_key_ignored',
        tick: state.triggerFrame,
        side,
        actor: source.source,
        data: { text },
      })
    },
    mismatchReporter: (report): void => {
      emitMessage({
        level: 'error',
        code: 'selector.type_mismatch',
        tick: report.tick,
        ...(report.side === undefined ? {} : { side: report.side }),
        ...(report.actor === undefined ? {} : { actor: report.actor }),
        data: { selector: report.selector, detail: report.detail },
      })
    },
    ownPlayer: state.players[side],
    enemyPlayer: state.players[opponentOf(side)],
  }
}

// ————————————————————————————————————————————————————————
// 记账
// ————————————————————————————————————————————————————————

/** 组装一条光环相关消息（文案由 `engine/log.ts` 的 `messageText` 唯一决定） */
function auraMessage(
  level: LogLevel,
  code: MessageCode,
  state: BattleState,
  entry: AuraEntry,
): LogMessage {
  return {
    level,
    code,
    tick: state.triggerFrame,
    side: entry.sourceSide,
    actor: entry.source,
    data: {
      channel: entry.channel,
      stat: entry.stat,
      amount: entry.amount,
      target: entry.target,
      target_kind: entry.targetKind,
      target_name: entry.targetName,
    },
  }
}

/**
 * 玩家侧越界：**先记一条 `error` 级 `selector.type_mismatch`，再抛异常中止对局**。
 * 这是 错误政策①对"目标类型不匹配"的统一要求。
 */
function failPlayerSide(
  state: BattleState,
  emitMessage: (message: LogMessage) => void,
  source: AuraSource,
  detail: string,
): never {
  emitMessage({
    level: 'error',
    code: 'selector.type_mismatch',
    tick: state.triggerFrame,
    side: source.side,
    actor: source.source,
    data: { selector: selectorText(source.def.select), detail },
  })
  throw new Error(
    `光环 ${source.source} 的 select ${selectorText(source.def.select)} 目标类型不匹配：${detail}` +
      ``,
  )
}

// ————————————————————————————————————————————————————————
// 累积
// ————————————————————————————————————————————————————————

function totalsFor(accumulator: Accumulator, instanceId: string, stat: string): Totals {
  let perCard = accumulator.cards.get(instanceId)
  if (perCard === undefined) {
    perCard = new Map()
    accumulator.cards.set(instanceId, perCard)
  }
  let totals = perCard.get(stat)
  if (totals === undefined) {
    totals = { flat: 0, factor: 0 }
    perCard.set(stat, totals)
  }
  return totals
}

function cardEntry(
  source: AuraSource,
  channel: 'apply' | 'mul',
  stat: string,
  amount: number,
  target: BoardCard,
): AuraEntry {
  return {
    source: source.source,
    sourceSide: source.side,
    channel,
    stat,
    amount,
    target: target.instanceId,
    targetKind: 'card',
    targetName: target.card.id,
  }
}

function playerEntry(
  source: AuraSource,
  stat: string,
  amount: number,
  target: PlayerState,
): AuraEntry {
  return {
    source: source.source,
    sourceSide: source.side,
    channel: 'apply',
    stat,
    amount,
    target: String(target.id),
    targetKind: 'player',
    targetName: target.name,
  }
}

/**
 * 求值一条光环并并入累积器。
 *
 * 顺序：定义校验 → `condition` → `select` → 卡牌通道（平铺、再倍率）→
 * 玩家通道（只接受三 DOT 的固定数值 `apply`）。
 */
function accumulate(
  state: BattleState,
  emitMessage: (message: LogMessage) => void,
  source: AuraSource,
  accumulator: Accumulator,
): void {
  const def = source.def
  validateAuraDef(def, source.source)

  const context = makeAuraContext(state, source, emitMessage)
  //  `condition` 为假 ⇒ 本帧贡献 0（不是"移除"，是"从未生效"）
  if (def.condition !== undefined && !evaluateCondition(def.condition, context)) return

  const selection = selectTargets(def.select, context)
  const apply = def.apply ?? []
  const mul = def.mul ?? []

  // —— 卡牌通道：先平铺（apply）再乘倍率（mul），两者可写同一个 stat
  for (const boardCard of selection.cards) {
    for (const item of apply) {
      totalsFor(accumulator, boardCard.instanceId, item.stat).flat += item.amount
      accumulator.entries.push(cardEntry(source, 'apply', item.stat, item.amount, boardCard))
    }
    for (const item of mul) {
      // 台账里存 `factor − 1`，好让倍率之间直接相加
      totalsFor(accumulator, boardCard.instanceId, item.stat).factor += item.factor - 1
      accumulator.entries.push(cardEntry(source, 'mul', item.stat, item.factor - 1, boardCard))
    }
  }

  // —— 玩家通道：只接受 burn / poison / regen 的固定数值 apply
  if (selection.players.length === 0) return
  if (mul.length > 0) {
    failPlayerSide(
      state,
      emitMessage,
      source,
      '玩家侧不得使用 mul 倍率（玩家侧没有倍率层）',
    )
  }
  for (const targetSide of selection.players) {
    const target = state.players[targetSide]
    for (const item of apply) {
      if (!DOT_KINDS.has(item.stat)) {
        failPlayerSide(
          state,
          emitMessage,
          source,
          `玩家侧只接受 burn / poison / regen 的固定数值 apply，收到 ${item.stat}`,
        )
      }
      const key = `${targetSide}:${item.stat}`
      accumulator.dots.set(key, (accumulator.dots.get(key) ?? 0) + item.amount)
      accumulator.entries.push(playerEntry(source, item.stat, item.amount, target))
      if (item.stat === 'burn' || item.stat === 'poison') {
        // 火焰 / 剧毒施加给玩家是**暂定允许**的做法，记一条 WARN 让作者确认
        emitMessage({
          level: 'warn',
          code: 'aura.dot_warning',
          tick: state.triggerFrame,
          side: source.side,
          actor: source.source,
          data: { target: target.name, dot: item.stat },
        })
      }
    }
  }
}

// ————————————————————————————————————————————————————————
// 对外入口
// ————————————————————————————————————————————————————————

/**
 * 重建光环派生态快照（**每触发帧边界调用一次**，见 `engine/tick.ts` 的 `runBattle`）。
 *
 * 来源集合：
 * - **卡牌光环** = 双方场上 `destroyed === false` 的卡（按两侧 → 格位顺序，确定）；
 * - **技能光环** = 双方 `PlayerState.skills` 全部（按数组顺序，确定）；
 * - `condition` 为假 ⇒ 该来源本帧贡献 0。
 *
 * 生效 / 退场播报：与**上一帧快照**按 `来源 × 通道 × 数值名 × 目标` 做 diff，
 * 新出现的记 `aura.entered`、消失的记 `aura.exited`（均为 `info` 级 ⇒ 缺省阈值下不产出文本）。
 * 连续存在不重复记。
 *
 * 末尾**整体替换** `state.auras`（不改旧对象）⇒ 来源离场时下一帧自然消失，无需回滚。
 */
export function refreshAuras(
  state: BattleState,
  emitMessage: (message: LogMessage) => void,
): void {
  const accumulator: Accumulator = { entries: [], cards: new Map(), dots: new Map() }

  const sides: readonly PlayerId[] = [1, 2]
  for (const side of sides) {
    const player = state.players[side]
    for (const boardCard of player.board) {
      if (boardCard.destroyed) continue
      const def = boardCard.card.aura
      if (def !== undefined) {
        accumulate(
          state,
          emitMessage,
          {
            def,
            side,
            source: boardCard.instanceId,
            self: boardCard,
            selfStats: undefined,
          },
          accumulator,
        )
      }
      // 附魔光环（AD.3 = A）：来源键 = `enchant:<卡实例>#<附魔 id>` —— 换附魔即换来源，
      // 旧修饰在下一帧重建时自然消失（不需要回滚路径）。
      const enchant = activeEnchantOf(boardCard)
      if (enchant !== undefined && enchant.aura !== undefined) {
        accumulate(
          state,
          emitMessage,
          {
            def: enchant.aura,
            side,
            source: `enchant:${boardCard.instanceId}#${enchant.id}`,
            self: boardCard,
            selfStats: undefined,
          },
          accumulator,
        )
      }
    }    for (const skill of player.skills) {
      const def = skill.aura
      if (def === undefined) continue
      accumulate(
        state,
        emitMessage,
        {
          def,
          side,
          source: `技能:${skill.id}`,
          self: null,
          selfStats: skill.stats,
        },
        accumulator,
      )
    }
  }

  // —— 生效 / 退场 diff ——（台账按"上一帧 → 本帧"比较，与消息是否可见无关）
  const previous = new Map<string, AuraEntry>()
  for (const entry of state.auras.entries) previous.set(entryKey(entry), entry)
  const next = new Map<string, AuraEntry>()
  for (const entry of accumulator.entries) next.set(entryKey(entry), entry)

  for (const [key, entry] of next) {
    if (!previous.has(key)) emitMessage(auraMessage('info', 'aura.entered', state, entry))
  }
  for (const [key, entry] of previous) {
    if (!next.has(key)) emitMessage(auraMessage('info', 'aura.exited', state, entry))
  }

  state.auras = {
    entries: accumulator.entries,
    cards: accumulator.cards,
    dots: accumulator.dots,
  }
}
