// 效果回显行的**结构化切分**：把读取层的 `[标签] 触发器 → 结果` 拆成三段，
// 供前端统一渲染成「触发器 ▶ 结果」。纯逻辑 —— 不碰 DOM、不改写原文、不引入任何战斗规则。

/** 一段效果回显的切分结果 */
export interface EffectLineParts {
  /** 行首标签：`主动` / `被动 P10` / `技能 P5` / `光环` / `附魔`；没有标签 ⇒ `null` */
  readonly tag: string | null
  /** 箭头左侧（触发器侧）；这一行没有箭头时就是整行正文 */
  readonly trigger: string
  /** 箭头右侧（结果侧）；这一行没有箭头 ⇒ `null`（渲染时不画三角形） */
  readonly result: string | null
  /** 原文（去首尾空白）—— 复制 / 搜索用 */
  readonly raw: string
}

/** 行首标签：`[主动] ` / `[被动 P10] ` / `[附魔] ` … */
const TAG = /^\[([^\]]+)\]\s*/u

/** 读取层用的箭头字符（见 `cards/registry.ts` 的 `abilitySummary`） */
const ARROW = '→'

/**
 * 把一行效果回显拆成三段。
 *
 * @param text 读取层给的一行（可带行首缩进）
 * @returns 标签 / 触发器 / 结果三段 + 原文；**任何输入都不抛异常**，无法识别的部分原样留在 `trigger`
 */
export function parseEffectLine(text: string): EffectLineParts {
  const raw = text.trim()
  let rest = raw
  let tag: string | null = null
  const tagMatch = TAG.exec(rest)
  if (tagMatch !== null) {
    tag = tagMatch[1] ?? null
    rest = rest.slice(tagMatch[0].length)
  }
  const at = rest.indexOf(ARROW)
  if (at < 0) return { tag, trigger: rest, result: null, raw }
  const trigger = rest.slice(0, at).trim()
  const result = rest.slice(at + ARROW.length).trim()
  return { tag, trigger, result: result.length === 0 ? null : result, raw }
}

/**
 * 把整行文本里的箭头换成三角形符号 `▶`。
 *
 * 用于"整行就是一段文本"的地方（本帧动作日志）：引擎的日志文本不在前端改写，
 * 只在**渲染时**换字形，因此不影响确定性 hash、也不改引擎产物。
 */
export function arrowToTri(text: string): string {
  return text.split(ARROW).join('▶')
}

/**
 * 把 `self.<stat>` / `this.<stat>` 换成**数值**。
 *
 * 编辑态与卡牌库**没有战斗状态**，文本里的 `数额=self.atk` 只能是符号；这里用调用方给的
 * 数值表（编辑态 = 卡面 / 帧读数）把它变成 `数额=8`。
 *
 * @param text 触发器 / 结果的一侧文本
 * @param values `stat → 数值` 表（查不到的引用**原样保留**，例如技能 stats 或未出现的键）
 */
export function resolveStatRefs(text: string, values: Readonly<Record<string, number>>): string {
  return text.replace(
    /(?<![A-Za-z0-9_.])(?:self|this)\.([A-Za-z][A-Za-z0-9_]*)/gu,
    (all: string, stat: string) => {
      const value = values[stat]
      return value === undefined ? all : String(value)
    },
  )
}
