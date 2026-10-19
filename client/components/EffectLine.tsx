// 效果行的统一渲染：**【触发器】▶【结果】**。
//
// 两个入口：
//   · `EffectSegments` —— **结构化**三段（`CardRegistry.summaryLines()` 的 `label` / `trigger` / `result`），
//     悬浮窗与卡牌库走这条（AG.6 = A：不靠中文前缀判分组）；
//   · `EffectLine` —— 只有**整行文本**时（当前生效附魔的合成行）用 `parseEffectLine` 切分。
//
// 三角形 = 内联 SVG（不依赖字体、随字号缩放、颜色走 `currentColor`）。

import type { SummaryLine } from '../../cards/registry.ts'
import type { ActionSpec } from '../../engine/types.ts'
import { naturalActions, naturalTriggerText } from '../i18n/effectText.ts'
import { humanizeTerms } from '../i18n/terms.ts'
import { parseEffectLine, resolveStatRefs } from '../state/effectLine.ts'

/** 三角形宽高比（10 : 12 ⇒ 视觉上比正三角略修长，和 11px 正文更匹配） */
const TRI_WIDTH = 10
const TRI_HEIGHT = 12

/** 向右三角形（纯装饰，读屏跳过） */
export function TriRight({ size = 8 }: { readonly size?: number }) {
  return (
    <svg
      className="ef-tri"
      viewBox={`0 0 ${String(TRI_WIDTH)} ${String(TRI_HEIGHT)}`}
      width={size}
      height={(size * TRI_HEIGHT) / TRI_WIDTH}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.5 1.5 L9 6 L1.5 10.5 Z" fill="currentColor" />
    </svg>
  )
}

/** 一行结构化效果：`[标签] 触发器 ▶ 结果`（任一段没有就不渲染，三角形只在有结果时出现） */
export function EffectSegments({
  label,
  trigger,
  result,
  values,
  actions,
}: {
  readonly label: string | null
  readonly trigger: string | null
  readonly result: string | null
  /** `stat → 数值`：给出时把 `self.<stat>` 解析成数字（编辑态 / 卡牌库没有战斗状态） */
  readonly values?: Readonly<Record<string, number>>
  /** 结构化行的原始动作：给出时结果侧渲染成**自然句**（F9 = A），否则用参数式文本 */
  readonly actions?: readonly ActionSpec[]
}) {
  // 顺序：① 先按数值表把 `self.atk` 换成数字；② 触发器再把条件表达式（`$player` / `count(…)`）翻成人话；
  // ③ 最后翻词表 id（AG.9 = C：人话只出现在显示层）。
  const withValues = (text: string): string => (values === undefined ? text : resolveStatRefs(text, values))
  const prepareTrigger = (text: string): string => humanizeTerms(naturalTriggerText(withValues(text)))
  const prepareResult = (text: string): string => humanizeTerms(withValues(text))
  const triggerText = trigger === null ? null : prepareTrigger(trigger)
  // 结果侧优先自然句；自然句里的 `self.<stat>` 同样要换数（这一步之前漏了，导致 `self.atk` 直接露出来）。
  const natural = actions === undefined ? null : naturalActions(actions)
  const resultText = natural === null ? (result === null ? null : prepareResult(result)) : prepareResult(natural)
  return (
    <span className="ef">
      {label !== null && <span className="ef-tag">{label}</span>}
      {triggerText !== null && triggerText.length > 0 && <span className="ef-trigger">{triggerText}</span>}
      {resultText !== null && (
        <>
          <TriRight />
          <span className="ef-result">{resultText}</span>
        </>
      )}
    </span>
  )
}

/** 一行文本效果（读取层回显的整行；`[标签] 触发器 → 结果` 形式） */
export function EffectLine({
  text,
  values,
}: {
  readonly text: string
  readonly values?: Readonly<Record<string, number>>
}) {
  const parts = parseEffectLine(text)
  return (
    <EffectSegments
      label={parts.tag}
      trigger={parts.trigger}
      result={parts.result}
      {...(values === undefined ? {} : { values })}
    />
  )
}

/**
 * 读取层回显的多行（`CardRegistry.summaryLines()`）。
 *
 * `header` 当小标题、`enchantCatalog` 是目录说明（灰注，不是效果），其余每行渲染成一条效果。
 */
export function EffectLines({
  lines,
  values,
}: {
  readonly lines: readonly SummaryLine[]
  readonly values?: Readonly<Record<string, number>>
}) {
  return (
    <div className="ef-list">
      {lines.map((line, at) => {
        const key = `${line.kind}-${String(at)}`
        if (line.kind === 'header') {
          return (
            <p key={key} className="ef-head">
              {line.text}
            </p>
          )
        }
        if (line.kind === 'enchantCatalog') {
          return (
            <p key={key} className="ef-note">
              {line.text.trim()}
            </p>
          )
        }
        return (
          <div key={key} className="ef-row">
            <EffectSegments
              label={line.label}
              trigger={line.trigger}
              result={line.result}
              {...(line.actions === undefined ? {} : { actions: line.actions })}
              {...(values === undefined ? {} : { values })}
            />
          </div>
        )
      })}
    </div>
  )
}
