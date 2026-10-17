// 分级消息的唯一记账入口

// **为什么单独一个文件**：记录动作发生在 `engine/tick.ts`（`emitMessage`）与
// `engine/primitives.ts`（选择器类型不匹配 / 排序键提醒）**两个地方**，而 `primitives.ts`
// 被 `tick.ts` 反向依赖 —— 记账逻辑若留在 `tick.ts` 就会形成循环依赖。
// 因此把"产出一条 `LogMessage`"下沉到这里，两条路径共用同一个入口，实现保持唯一。

// 契约：
// - 结构化记录**只存 code + 参数**，文案的唯一权威是 `engine/log.ts` 的 `messageText`；
// - 级别阈值只决定"记不记"（`passesLogLevel`），**绝不参与任何判定**：不消耗 rng、
//   不写任何判定字段，故调整阈值不改变对局结果。
import { passesLogLevel } from './log.ts'
import type { BattleState, LogLevel, LogMessage, MessageCode, PlayerId, PrimitiveName } from './types.ts'

/** 产出一条消息所需的全部参数（`messages` / `actor` / `where` 都可选） */
export interface MessageInput {
  readonly level: LogLevel
  readonly code: MessageCode
  readonly tick: number
  readonly side?: PlayerId
  readonly actor?: string
  readonly where?: LogMessage['where']
  readonly data?: Readonly<Record<string, number | string>>
}

/**
 * 记账一条消息。
 *
 * @param threshold 记录阈值（`BattleOptions.logLevel`）；低于阈值的消息**直接丢弃**
 *   （既不进 `BattleState.messages`、也不渲染文本），与 `tick.ts` 既有的 `emitMessage` 同语义。
 * @param render 需要落文本行时的回调（`tick.ts` 传入 `lines.push(...)`；其余调用点为 undefined）
 */
export function recordMessage(
  state: BattleState,
  input: MessageInput,
  threshold: LogLevel,
  render?: (message: LogMessage) => void,
): LogMessage | null {
  if (!passesLogLevel(input.level, threshold)) return null
  // 逐字段展开而不是整体赋值：`exactOptionalPropertyTypes` 下 `side?: PlayerId` 不接受显式 undefined
  const message: LogMessage = {
    level: input.level,
    code: input.code,
    tick: input.tick,
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.where === undefined ? {} : { where: input.where }),
    ...(input.data === undefined ? {} : { data: input.data }),
  }
  state.messages.push(message)
  render?.(message)
  return message
}

/** 选择器"类型不匹配"的结构化参数（`engine/log.ts` 的 `messageText` 读它们渲染文案） */
export interface SelectorMismatchInput {
  readonly tick: number
  readonly side?: PlayerId
  readonly actor?: string
  readonly primitive?: PrimitiveName
  readonly selector: string
  readonly detail: string
}

/**
 * 记一条 `error` 级 `selector.type_mismatch`。
 *
 * `error` 级在阈值表里最高（任何阈值都会记），所以这里不额外做阈值判断 —— 仍然走
 * `recordMessage` 以保持"唯一入口"。
 */
export function recordSelectorMismatch(
  state: BattleState,
  input: SelectorMismatchInput,
  threshold: LogLevel = 'error',
): LogMessage | null {
  return recordMessage(
    state,
    {
      level: 'error',
      code: 'selector.type_mismatch',
      tick: input.tick,
      ...(input.side === undefined ? {} : { side: input.side }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      // 与上面同形：`where` 的对象字面量整体展开，避免 `exactOptionalPropertyTypes` 下的显式 undefined
      ...(input.primitive === undefined ? {} : { where: { primitive: input.primitive } }),
      data: { selector: input.selector, detail: input.detail, primitive: input.primitive ?? '?' },
    },
    threshold,
  )
}
