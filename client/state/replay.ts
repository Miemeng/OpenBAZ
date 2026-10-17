// 回放：帧游标 + "这一帧画什么"的**纯逻辑** —— 不放 JSX、不碰 DOM、不调引擎。

// 三条纪律：
//   · **只消费**：进 `frames` / `events`，出"这一帧画什么"；不二次调 `runBattle`、
//     不改任何引擎产物、不按 `cooldown` 自己推周期（黄金法则 3）；
//   · **可复现**：同一份 `frames` 的同一个下标必然得到同一份结果（事件先按 `cs` 排序再分组，
//     分组顺序 = 首次出现顺序）⇒ "同一局重复播放逐帧相同"；
//   · **动画参数只在这里**：一帧时长 / 倍速档位 / 飘字存活时长 / 合并明细条数集中成 `REPLAY_ANIM`
//     一处常量（纯视觉的位移与缓动在 `client/styles.css` 的关键帧里 —— CSS 读不到 TS 常量）。
import { TRIGGER_FRAME_SECONDS } from '../../engine/state.ts'
import type { BattleResult } from '../../engine/tick.ts'
import type { DotKind, FrameCard, FrameEvent, FrameSnapshot, PlayerId } from '../../engine/types.ts'
import type { ResolvedDeck } from '../../cards/deck.ts'

/* ------------------------------------------------------------------ *
 * 观感常量（调动画只改这一处）
 * ------------------------------------------------------------------ */

export const REPLAY_ANIM = {
  /** 1× 播放时一帧占的**真实**时长（ms）= 引擎的触发帧粒度（0.2s） */
  frameMs: TRIGGER_FRAME_SECONDS * 1000,
  /** 飘字存活时长（ms） */
  floaterMs: 700,
  /** 触发高亮闪烁时长（ms） */
  highlightMs: 420,
  /** 倍速档位（只影响播放间隔，不影响任何读数） */
  speeds: [0.5, 1, 2, 4],
  /** 一条飘字最多列出几个"分量"明细（同帧同目标合并之后） */
  maxParts: 3,
} as const
/** 倍速档位取值：`0.5 | 1 | 2 | 4` */
export type ReplaySpeed = (typeof REPLAY_ANIM.speeds)[number]

/** 缺省倍速 */
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 1

/* ------------------------------------------------------------------ *
 * 回放的输入（不可变；《前端设计.md》§5.3 的 `ReplayInput`）
 * ------------------------------------------------------------------ */

/** 一局回放要的全部原料：引擎产物 + 跑那一局时的阵容快照 */
export interface ReplayInput {
  /** 引擎产物（`state` / `log` / `lines` / `victory` / `frames` 都在里面） */
  readonly outcome: BattleResult
  readonly seed: number
  /** **跑那一局时**的双方阵容；之后改草稿不影响回放（回放不读编辑器状态） */
  readonly sides: Readonly<Record<PlayerId, ResolvedDeck>>
}

/* ------------------------------------------------------------------ *
 * 帧游标
 * ------------------------------------------------------------------ */

export interface ReplayState {
  /** 当前帧下标（0 = 开局快照）；对应 `frames[index].triggerFrame` */
  readonly index: number
  readonly playing: boolean
  readonly speed: ReplaySpeed
  /** 已累积的、**乘过倍速**的毫秒余量（不足一帧的部分留到下一拍，避免丢时间） */
  readonly carryMs: number
}

/** 开局游标：停在第一帧、暂停 */
export function replayStart(speed: ReplaySpeed = DEFAULT_REPLAY_SPEED): ReplayState {
  return { index: 0, playing: false, speed, carryMs: 0 }
}

/** 最后一帧的下标（`frames` 为空时也是 0） */
export function lastIndexOf(total: number): number {
  return Math.max(0, total - 1)
}

function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), lastIndexOf(total))
}

/**
 * 推进游标。`elapsedMs` 是**真实**毫秒（由 `requestAnimationFrame` 的时间戳差给出）。
 *
 * 到末帧自动停：`playing` 转 `false`，余量清零 —— 播放到结尾就停住，等用户再点播放
 * （再点 = 从头重放，见 `setPlayingReplay`）。
 */
export function advanceReplay(state: ReplayState, elapsedMs: number, total: number): ReplayState {
  const last = lastIndexOf(total)
  if (!state.playing) return state
  // 只有一帧（或没有帧）：没有"下一帧"可放，直接停下
  if (last === 0) return { ...state, playing: false, carryMs: 0 }

  const scaled = state.carryMs + Math.max(0, elapsedMs) * state.speed
  const steps = Math.floor(scaled / REPLAY_ANIM.frameMs)
  const carryMs = scaled - steps * REPLAY_ANIM.frameMs
  if (steps <= 0) return { ...state, carryMs }

  const index = Math.min(state.index + steps, last)
  const playing = index < last
  return { ...state, index, playing, carryMs: playing ? carryMs : 0 }
}

/** 跳转（进度条 / 直接定位）：余量清零，播放状态不变 */
export function seekReplay(state: ReplayState, index: number, total: number): ReplayState {
  return { ...state, index: clampIndex(index, total), carryMs: 0 }
}

/** 逐帧步进（±1）：**步进必然暂停** —— 手动逐帧时不该让画面自己往前跑 */
export function stepReplay(state: ReplayState, delta: number, total: number): ReplayState {
  return { index: clampIndex(state.index + delta, total), playing: false, speed: state.speed, carryMs: 0 }
}

/** 播放 / 暂停；**已在末帧时点播放 = 从头再放一遍**（一次点击就能重看） */
export function setPlayingReplay(state: ReplayState, playing: boolean, total: number): ReplayState {
  if (!playing) return { ...state, playing: false, carryMs: 0 }
  const last = lastIndexOf(total)
  if (last <= 0) return { ...state, playing: false, carryMs: 0 }
  const index = state.index >= last ? 0 : state.index
  return { ...state, playing: true, index, carryMs: 0 }
}

/** 换倍速：余量清零（否则换档那一拍会突然跳好几帧） */
export function setSpeedReplay(state: ReplayState, speed: ReplaySpeed): ReplayState {
  return { ...state, speed, carryMs: 0 }
}

/** 0–1 的进度（进度条用）；只有一帧时恒为 0 */
export function replayProgress(state: ReplayState, total: number): number {
  const last = lastIndexOf(total)
  return last === 0 ? 0 : state.index / last
}

/* ------------------------------------------------------------------ *
 * 帧间**补帧**（插值）—— 纯表现，不改任何读数来源
 * ------------------------------------------------------------------ */

/**
 * 当前帧内的插值系数：`0` = 正落在该帧快照上，趋近 `1` = 快走到下一帧。
 *
 * 由"乘过倍速的余量"直接给出 ⇒ 与播放速度自动同步。**暂停 / 步进时调用方传 0**
 * （这样"停在任意帧"时画面严格等于 `frames[i]`，逐帧一致仍可验证）。
 */
export function frameFraction(state: ReplayState): number {
  const fraction = state.carryMs / REPLAY_ANIM.frameMs
  if (fraction <= 0) return 0
  return fraction >= 1 ? 1 : fraction
}

/** 线性插值（**只喂给条宽 / 填充高度 / 数字滚动**；插值的两端都是引擎给的原值） */
export function lerp(from: number, to: number, fraction: number): number {
  if (fraction <= 0) return from
  if (fraction >= 1) return to
  return from + (to - from) * fraction
}

/** 比例限制在 0–1（行动条填充用） */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 本窗口（`frames[index]` → `frames[index + 1]`）里这张卡的**行动归零时刻**（cs）。
 *
 * 引擎把"什么时候满、什么时候归零"写在帧事件里：该卡行动**记账**时广播的内部事件
 * `active_action`，其 `cs` 就是**归零那一 cs**（可能落在本帧窗口内任意位置，不能假设它在 0.2s 网格上）。
 * 事件记在**采集它的那一帧**（= 本窗口的右端点）里，故只看 `frames[index + 1].events`；
 * 同窗口内可能有多条（`charge` 连锁让同一张卡连着动）⇒ 取**最早**的那一条。
 *
 * @returns 归零时刻；`undefined` = 本窗口这张卡没有行动（gauge 的下降另有原因，如周期变化）
 */
function resetCsOf(frames: readonly FrameSnapshot[], index: number, instanceId: string): number | undefined {
  const current = frames[index]
  const next = frames[index + 1]
  if (current === undefined || next === undefined) return undefined
  let earliest: number | undefined
  for (const event of next.events) {
    if (event.event !== 'active_action') continue
    if (event.sourceKey !== `active:${instanceId}`) continue
    if (event.cs <= current.timeCs || event.cs > next.timeCs) continue
    earliest = earliest === undefined ? event.cs : Math.min(earliest, event.cs)
  }
  return earliest
}

/**
 * 行动条的**插值比例**（0–1）；`null` = 本帧不该画条（纯被动卡）。
 *
 * 分母仍取自引擎（`gaugeViewOf` 的 `periodCs`）；**分子按"这一 cs 到底走到哪"给**，
 * 分三种情形（顺序即优先级）：
 *
 * 1. **本窗口没有行动**（`active_action` 里查不到这张卡）⇒ 在"本帧比例 → 下一帧比例"之间
 *    **只增不减**地插值 —— `charge` 上跳与周期变化（加速 / 减速按比例缩放）都走这条，
 *    永远不会画出"向后退"；
 * 2. **归零之前** ⇒ **按充能速率推进**（1cs 一格）：`本帧比例 + 本窗口已流逝 cs ÷ 周期`
 *    ⇒ 条会**真的走满**，并在"满"的那一 cs 正好到 100%；
 * 3. **归零之后** ⇒ 从 0 重新走：到帧末**恰好等于下一帧的读数**（交接处不跳）。
 *
 * 为什么不能"朝下一帧插值"：卡牌行动会把 gauge 归零，而下一帧是**已消费**的小值 ——
 * 旧写法在那 0.2s 窗口里冻结在上一帧（观感 = "停在中途 → 突然归零"），且条几乎从不显示满格。
 */
export function gaugeRatioAt(
  frames: readonly FrameSnapshot[],
  index: number,
  card: FrameCard,
  fraction: number,
): number | null {
  const view = gaugeViewOf(frames, index, card)
  if (view.ratio === null || view.periodCs === null) return null
  const periodCs = view.periodCs
  const current = frames[index]
  const next = frames[index + 1]
  const nextCard = next?.cards.find((item) => item.instanceId === card.instanceId)
  // 末帧 / 下一帧里没有这张卡 / 拿不到本帧 / 窗口长度非正 ⇒ 本帧原值（逐帧一致仍可验证）
  if (current === undefined || next === undefined || nextCard === undefined) return view.ratio
  const spanCs = next.timeCs - current.timeCs
  if (spanCs <= 0) return view.ratio
  if (fraction <= 0) return view.ratio

  const nextRatio = gaugeViewOf(frames, index + 1, nextCard).ratio ?? view.ratio
  const atCs = current.timeCs + clamp01(fraction) * spanCs
  const resetCs = resetCsOf(frames, index, card.instanceId)

  if (resetCs === undefined) {
    return clamp01(Math.max(view.ratio, lerp(view.ratio, nextRatio, clamp01(fraction))))
  }
  if (atCs < resetCs) {
    return clamp01(Math.max(view.ratio, view.ratio + (atCs - current.timeCs) / periodCs))
  }
  const afterCs = next.timeCs - resetCs
  if (afterCs <= 0) return clamp01(nextRatio)
  return clamp01(lerp(0, nextRatio, (atCs - resetCs) / afterCs))
}

/* ------------------------------------------------------------------ *
 * 帧内"盾的路径"（存量型读数，不能只按端点插值）
 * ------------------------------------------------------------------ */

/** 引擎的内部事件词：护盾被消耗（**只进帧快照**，不在时机词词典里） */
const SHIELD_SPENT_EVENT = 'shield_spent'

/** 盾路径上的一个点：从 `cs` 起，盾为 `shield`（分段常值） */
export interface ShieldPoint {
  readonly cs: number
  readonly shield: number
}

/**
 * 本窗口里**某一方**的护盾轨迹：`本帧读数 → 帧内事件（获得 / 消耗 / 击穿）→ 下一帧读数`。
 *
 * **为什么不能只按端点插值**：护盾是**存量**，同一个 0.2s 帧内可以"先 +60、再被同一帧的伤害打空"，
 * 端点两端都是 0 ⇒ 画面永远看不到那 60（RW 实测："有 `+60` 盾的跳字，盾条却是 0"）。
 * 引擎把三件事都写进了帧事件 —— `on_shield_gained`（获得多少）、`shield_spent`（被消耗多少）、
 * `on_shield_broken`（打空）—— 这里按 `cs` 顺序重放，画面就与跳字一致。
 *
 * 事件记在**采集它的那一帧**（= 本窗口右端点）里，与 `resetCsOf` 同源。
 * 末尾**强制对齐**下一帧的读数（引擎读数永远权威）。
 */
export function shieldPathOf(
  frames: readonly FrameSnapshot[],
  index: number,
  side: PlayerId,
): readonly ShieldPoint[] {
  const current = frames[index]
  if (current === undefined) return []
  const startShield = playerShieldOf(current, side)
  const points: ShieldPoint[] = [{ cs: current.timeCs, shield: startShield }]
  const next = frames[index + 1]
  if (next === undefined) return points

  const target = `player:${String(side)}`
  let shield = startShield
  for (const event of next.events) {
    if (event.targetKey !== target) continue
    if (event.event === 'on_shield_gained') shield += event.amount ?? 0
    else if (event.event === SHIELD_SPENT_EVENT) shield -= event.amount ?? 0
    else if (event.event === 'on_shield_broken') shield = 0
    else continue
    points.push({ cs: event.cs, shield: Math.max(0, shield) })
  }
  points.push({ cs: next.timeCs, shield: playerShieldOf(next, side) })
  return points
}

/** 该帧里某一方的护盾读数（缺帧 / 缺玩家 ⇒ 0） */
function playerShieldOf(frame: FrameSnapshot, side: PlayerId): number {
  return frame.players.find((player) => player.id === side)?.shield ?? 0
}

/**
 * 补帧：某一方在本窗口 `fraction`（0–1）处应当**显示**的护盾值。
 *
 * - **窗口里有盾事件** ⇒ 按 `shieldPathOf` **分段常值**（盾是存量，事件那一刻直接跳，
 *   这样"+60 跳字 → 盾条 60 → 被打空 → 盾条 0"与跳字同步）；
 * - **没有事件**（或末帧）⇒ 沿用"本帧 → 下一帧"线性插值（与血条同口径）。
 */
export function shieldShownAt(
  frames: readonly FrameSnapshot[],
  index: number,
  side: PlayerId,
  fraction: number,
): number {
  const current = frames[index]
  const next = frames[index + 1]
  const from = current === undefined ? 0 : playerShieldOf(current, side)
  if (current === undefined || next === undefined) return from
  const to = playerShieldOf(next, side)
  const points = shieldPathOf(frames, index, side)
  if (points.length <= 2) return lerp(from, to, clamp01(fraction))
  const atCs = current.timeCs + clamp01(fraction) * (next.timeCs - current.timeCs)
  let shown = from
  for (const point of points) {
    if (point.cs > atCs) break
    shown = point.shield
  }
  return shown
}

/* ------------------------------------------------------------------ *
 * 帧事件 → 飘字
 * ------------------------------------------------------------------ */

/** 飘字色调（由时机词归并而来；配色见 `client/theme/colors.ts`） */
export type FloaterTone = 'damage' | 'heal' | 'shield' | 'shieldBreak' | 'status' | 'destroy' | 'repair'

/** 一条飘字里的一个"分量"（= 一个事件实例） */
export interface FloaterPart {
  /** 时机词（`on_burn_tick` …）；显示名走 `theme/colors.ts` 的 `EVENT_LOOK` */
  readonly event: string
  /** 该事件的收口金额（`FrameEvent.amount`；状态类事件是**秒**，其余是点/层） */
  readonly amount: number
  /** 来自持续效果时标注种类（灼烧 / 剧毒 / 再生） */
  readonly dot?: DotKind
}

/** 锚点上的一条飘字（**同帧同目标同色调已合并**） */
export interface Floater {
  /** 锚点 = 事件目标键原样：`player:<1|2>` / `card:<instanceId>` */
  readonly targetKey: string
  readonly tone: FloaterTone
  /**
   * 金额：伤害 / 治疗 / 护盾 / 破盾 = 各分量**求和**；
   * 状态 / 失效 / 修复 = **最后一条**的金额（状态是秒，不可求和）。
   */
  readonly total: number
  readonly parts: readonly FloaterPart[]
  /** 该锚点本条飘字的最早发生时刻（cs），用于同帧内排序 */
  readonly cs: number
}

/** 可求和的色调 */
const SUMMED_TONES: ReadonlySet<FloaterTone> = new Set<FloaterTone>(['damage', 'heal', 'shield', 'shieldBreak'])

/** 三个持续效果跳词 → 种类 */
export function dotOfEvent(word: string): DotKind | undefined {
  if (word === 'on_burn_tick') return 'burn'
  if (word === 'on_poison_tick') return 'poison'
  if (word === 'on_regen_tick') return 'regen'
  return undefined
}

/**
 * 时机词 → 飘字口径。`null` = **不产生飘字**（`battle_start` / `before_action` / `after_action`
 * 以及将来新增的词一律只做触发高亮；未知词按此兜底，不抛错、不静默画错东西）。
 */
export function floaterLookOf(event: FrameEvent): { readonly tone: FloaterTone; readonly dot?: DotKind } | null {
  switch (event.event) {
    case 'on_player_damaged':
      return { tone: 'damage' }
    case 'on_burn_tick':
      return { tone: 'damage', dot: 'burn' }
    case 'on_poison_tick':
      return { tone: 'damage', dot: 'poison' }
    case 'on_player_healed':
      return { tone: 'heal' }
    case 'on_regen_tick':
      return { tone: 'heal', dot: 'regen' }
    case 'on_shield_gained':
      return { tone: 'shield' }
    case 'on_shield_broken':
      return { tone: 'shieldBreak' }
    case 'on_card_destroyed':
      return { tone: 'destroy' }
    case 'on_card_repaired':
      return { tone: 'repair' }
    case 'on_card_frozen':
    case 'on_card_hasted':
    case 'on_card_slowed':
    case 'on_card_charged':
      return { tone: 'status' }
    default:
      return null
  }
}

/** 该帧的事件（按 `cs` 升序；`cs` 相同者保持引擎给的顺序） */
export function eventsOfFrame(frame: FrameSnapshot): readonly FrameEvent[] {
  return [...frame.events].sort((left, right) => left.cs - right.cs)
}

/**
 * 毒 / 再生的 1s **净值合并**（表现层口径，不改引擎读数）。
 *
 * 引擎把剧毒与再生放在**同一个 cs**（每 5 个触发帧的末尾）各广播一条跳变时机词、
 * 各带自己的分量；画面上要合成**一条净值飘字** ⇒ 这里把配对的两条换成一条：
 * `净 = 再生 − 剧毒`，为负按伤害色、为正（或 0）按治疗色，金额取绝对值。
 * 找不到配对的（只有毒、或只有再生）原样保留。
 *
 * @param events 一帧的事件（顺序无关；配对键 = 目标 × `cs`）
 * @returns 合并后的事件列表（未排序，配对项被替换为单条）
 */
export function mergeDotTickPairs(events: readonly FrameEvent[]): readonly FrameEvent[] {
  const consumed = new Set<FrameEvent>()
  const out: FrameEvent[] = []
  for (const event of events) {
    if (consumed.has(event)) continue
    if (event.event !== 'on_poison_tick') {
      out.push(event)
      continue
    }
    const partner = events.find(
      (other) =>
        other.event === 'on_regen_tick' &&
        other.cs === event.cs &&
        other.targetKey === event.targetKey &&
        !consumed.has(other),
    )
    if (partner === undefined) {
      out.push(event)
      continue
    }
    consumed.add(event)
    consumed.add(partner)
    const net = (partner.amount ?? 0) - (event.amount ?? 0)
    out.push({
      ...event,
      event: net < 0 ? 'on_poison_tick' : 'on_regen_tick',
      amount: Math.abs(net),
      sourceKey: net < 0 ? event.sourceKey : partner.sourceKey,
    })
  }
  return out
}

/**
 * 把一帧的事件合成**锚点上的飘字**。
 *
 * 合并键 = （目标 × 色调）：同一帧里灼烧跳伤与主动伤害落在同一个玩家身上 ⇒ 一条飘字，
 * 明细留在 `parts` 里（"同帧同目标合并成一个飘字"，避免数字叠在一起看不清）。
 * 无目标事件（`targetKey === '-'`）不产飘字。
 */
export function buildFloaters(events: readonly FrameEvent[]): readonly Floater[] {
  // 先做毒 / 再生的净值合并：引擎在同一 cs 上分别广播两条跳词，画面上只画一条净值
  const sorted = [...mergeDotTickPairs(events)].sort((left, right) => left.cs - right.cs)
  interface Group {
    targetKey: string
    tone: FloaterTone
    total: number
    parts: FloaterPart[]
    cs: number
  }
  const groups = new Map<string, Group>()

  for (const event of sorted) {
    if (event.targetKey === '' || event.targetKey === '-') continue
    const look = floaterLookOf(event)
    if (look === null) continue

    const amount = event.amount ?? 0
    const part: FloaterPart = {
      event: event.event,
      amount,
      ...(look.dot === undefined ? {} : { dot: look.dot }),
    }
    const key = `${event.targetKey}|${look.tone}`
    const found = groups.get(key)
    if (found === undefined) {
      groups.set(key, { targetKey: event.targetKey, tone: look.tone, total: amount, parts: [part], cs: event.cs })
      continue
    }
    found.parts.push(part)
    if (SUMMED_TONES.has(look.tone)) found.total += amount
    else found.total = amount
  }

  return [...groups.values()]
    .map((group): Floater => ({
      targetKey: group.targetKey,
      tone: group.tone,
      total: group.total,
      parts: group.parts,
      cs: group.cs,
    }))
    .sort((left, right) => left.cs - right.cs)
}

/* ------------------------------------------------------------------ *
 * 帧事件 → 触发高亮
 * ------------------------------------------------------------------ */

/** 本帧的高亮：谁动手、谁挨了、哪条持续效果跳了 */
export interface FrameHighlights {
  /** 被触发的卡（`instanceId`）→ 次数（来源 = 主动 / 被动 / 被选为目标） */
  readonly cards: ReadonlyMap<string, number>
  /** 被触发的技能（`skillId`）→ 次数 */
  readonly skills: ReadonlyMap<string, number>
  /** 涉及到的玩家（`'1'` / `'2'`）→ 次数 */
  readonly players: ReadonlyMap<string, number>
  /** 跳变的玩家持续效果（`` `${PlayerId}:${DotKind}` ``）→ 次数 */
  readonly dots: ReadonlyMap<string, number>
}

function bump(map: Map<string, number>, key: string): void {
  if (key === '') return
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * 一帧事件 → 高亮表。
 *
 * `sourceKey` 的四种可用来源键（`active:` / `passive:` / `skill:` / `engine:`）与 `targetKey` 的
 * 三种目标键（`player:` / `card:` / `-`）都在这里解读；**未知前缀忽略**，这样引擎将来加来源种类
 * 只会少高亮、不会崩。`dot:<种类>@<承受方>` 来源没有"可高亮的对象"（持续效果不是卡也不是技能），
 * 它那一下由**事件词 + `playerId`** 点亮对应玩家的角标 —— 两条路都走会重复计数，故只走后者。
 */
export function buildHighlights(events: readonly FrameEvent[]): FrameHighlights {
  const cards = new Map<string, number>()
  const skills = new Map<string, number>()
  const players = new Map<string, number>()
  const dots = new Map<string, number>()

  for (const event of events) {
    const source = event.sourceKey
    if (source.startsWith('active:')) {
      bump(cards, source.slice('active:'.length))
    } else if (source.startsWith('passive:')) {
      bump(cards, source.slice('passive:'.length).split('#')[0] ?? '')
    } else if (source.startsWith('skill:')) {
      bump(skills, source.slice('skill:'.length))
    }

    if (event.targetKey.startsWith('card:')) bump(cards, event.targetKey.slice('card:'.length))
    if (event.targetKey.startsWith('player:')) bump(players, event.targetKey.slice('player:'.length))
    if (event.playerId !== undefined) bump(players, String(event.playerId))

    const dotKind = dotOfEvent(event.event)
    if (dotKind !== undefined && event.playerId !== undefined) bump(dots, `${String(event.playerId)}:${dotKind}`)
  }

  return { cards, skills, players, dots }
}

/* ------------------------------------------------------------------ *
 * 逐帧读数
 * ------------------------------------------------------------------ */

/** 该帧某一方的卡（`FrameSnapshot.cards` 已是"方 → slot"排列，这里只过滤） */
export function cardsOfSide(frame: FrameSnapshot, side: PlayerId): readonly FrameCard[] {
  return frame.cards.filter((card) => card.owner === side)
}

/** 一张卡在本帧的行动条口径 */
export interface GaugeView {
  /** 填充比例 0–1；`null` = **本帧不该画行动条**（纯被动卡） */
  readonly ratio: number | null
  /** 分母（cs）；`null` = 没有可用周期 */
  readonly periodCs: number | null
  readonly frozen: boolean
  /** 满条（本帧已能行动 / 已行动） */
  readonly ready: boolean
}

/**
 * 一张卡在本帧的行动条。
 *
 * `FrameCard.periodCs` 为 `null` 有**两种**含义：纯被动卡（`cooldown: -1`）与**冰冻**（速度 = 0）。
 * 前者不该画条；后者向前沿用最近一个非 null 周期，这样冰冻期间仍画得出"冻住的进度"。
 * 两者用 `statuses` 区分 —— 不靠猜、也不由前端重算周期（那等于重实现战斗规则）。
 */
export function gaugeViewOf(frames: readonly FrameSnapshot[], index: number, card: FrameCard): GaugeView {
  const frozen = card.statuses.some((status) => status.kind === 'freeze')
  const periodCs = card.periodCs === null && frozen ? carriedPeriodCs(frames, index, card.instanceId) : card.periodCs

  if (periodCs === null || !Number.isFinite(periodCs) || periodCs <= 0) {
    return { ratio: null, periodCs: null, frozen, ready: false }
  }
  const ratio = Math.min(1, Math.max(0, card.gaugeCs / periodCs))
  return { ratio, periodCs, frozen, ready: card.gaugeCs >= periodCs }
}

/** 向前（含当前帧）找同一张卡最近一个非 null 的 `periodCs`；找不到 ⇒ `null` */
function carriedPeriodCs(frames: readonly FrameSnapshot[], index: number, instanceId: string): number | null {
  for (let at = index; at >= 0; at -= 1) {
    const frame = frames[at]
    if (frame === undefined) continue
    const found = frame.cards.find((card) => card.instanceId === instanceId)
    if (found === undefined) continue
    if (found.periodCs !== null) return found.periodCs
  }
  return null
}
