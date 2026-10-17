/**
 * YAML 行号表：把「字段路径」映射到「行列号」，供 zod 校验错误回查位置
 * （ **** / **** 的落地； 的 `line` / `column`）。
 *
 * 为什么不用 js-yaml 的 `load()` 结果：它只给 JS 值、丢掉了所有位置信息。
 * 所以这里走 `parseEvents()` 的**扁平事件流**（事件自带源码偏移），自己维护一个
 * 容器栈，边遍历边算出「蛇形键 + 数组下标」形式的路径 —— 与 zod 的 `issue.path`
 * 同构，直接拼起来就能查表。
 *
 * 纯逻辑：不碰 `node:*`、不读文件，浏览器宿主同样可跑。
 */
import { EVENT_ID, getScalarValue, parseEvents } from 'js-yaml'

/** 行列号均 1 起算。 */
export interface SourcePosition {
  readonly line: number
  readonly column: number
}

/** 事件流元素类型（js-yaml 未导出 `Event` 联合类型，用返回值反推）。 */
type YamlEvent = ReturnType<typeof parseEvents>[number]

interface Frame {
  readonly kind: 'document' | 'map' | 'seq'
  /** 本容器的路径（根为 `''`）。 */
  readonly path: string
  /** seq 专用：下一个子节点的下标。 */
  count: number
  /** map 专用：正在等待值的键名（`null` = 下一个标量是键）。 */
  pendingKey: string | null
}

/** 每个「行首」的字符偏移，用于把偏移换算成行列号。 */
function lineStarts(text: string): readonly number[] {
  const starts: number[] = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

function offsetToPosition(starts: readonly number[], offset: number): SourcePosition {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const start = starts[mid]
    if (start !== undefined && start <= offset) low = mid
    else high = mid - 1
  }
  const lineStart = starts[low] ?? 0
  return { line: low + 1, column: offset - lineStart + 1 }
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}

/**
 * 采集 `字段路径 → 位置` 表。
 *
 * - 语法错（`parseEvents` 抛 `YAMLException`）⇒ 返回**空表**：位置信息已不可信，
 *   调用方改用异常的 `mark.line` / `mark.column` 定位（见 `cards/schema.ts`）；
 * - 映射的**键**位置优先于其值（指向字段名比指向值更好用）；
 * - 不认识的路径（如未来新增字段）由 `lookupPosition()` 逐级回退到最近的祖先。
 */
export function collectPositions(text: string): ReadonlyMap<string, SourcePosition> {
  const positions = new Map<string, SourcePosition>()
  let events: readonly YamlEvent[]
  try {
    events = parseEvents(text, {})
  } catch {
    return positions
  }

  const starts = lineStarts(text)
  const stack: Frame[] = []

  const remember = (path: string, offset: number): void => {
    if (path === '' || positions.has(path)) return
    positions.set(path, offsetToPosition(starts, offset))
  }

  /** 当前待进入的节点路径；对 seq 会立刻消费一个下标。 */
  const takeChildPath = (): string => {
    const frame = stack[stack.length - 1]
    if (frame === undefined || frame.kind === 'document') return frame?.path ?? ''
    if (frame.kind === 'seq') {
      const path = `${frame.path}[${frame.count}]`
      frame.count += 1
      return path
    }
    const key = frame.pendingKey
    frame.pendingKey = null
    return key === null ? frame.path : joinPath(frame.path, key)
  }

  for (const event of events) {
    if (event.type === EVENT_ID.SCALAR) {
      const frame = stack[stack.length - 1]
      if (frame !== undefined && frame.kind === 'map' && frame.pendingKey === null) {
        // 键：位置记在「子路径」上（下一层的完整路径）
        const key = getScalarValue(text, event)
        frame.pendingKey = key
        remember(joinPath(frame.path, key), event.valueStart)
        continue
      }
      const path = takeChildPath()
      remember(path, event.valueStart)
      continue
    }

    if (event.type === EVENT_ID.MAPPING || event.type === EVENT_ID.SEQUENCE) {
      const path = takeChildPath()
      remember(path, event.start)
      stack.push({
        kind: event.type === EVENT_ID.MAPPING ? 'map' : 'seq',
        path,
        count: 0,
        pendingKey: null,
      })
      continue
    }

    if (event.type === EVENT_ID.DOCUMENT) {
      stack.push({ kind: 'document', path: '', count: 0, pendingKey: null })
      continue
    }

    if (event.type === EVENT_ID.POP) {
      stack.pop()
    }
    // ALIAS（锚点引用）不产生新路径，忽略。
  }

  return positions
}

/** 去掉路径最后一段（`a.b[0]` → `a.b`；`a[0]` → `a`）。 */
function parentPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const bracket = path.lastIndexOf('[')
  const cut = Math.max(dot, bracket)
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** 查位置；本级没有就逐级回退到最近的祖先（新增字段 / 容器整体报错的兜底）。 */
export function lookupPosition(
  positions: ReadonlyMap<string, SourcePosition>,
  path: string,
): SourcePosition | undefined {
  let current = path
  while (current !== '') {
    const hit = positions.get(current)
    if (hit !== undefined) return hit
    current = parentPath(current)
  }
  return undefined
}

/** zod 的 `issue.path`（`['abilities', 0, 'actions', 1, 'amount']`）→ 行号表的键。 */
export function formatIssuePath(path: readonly (string | number)[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}
