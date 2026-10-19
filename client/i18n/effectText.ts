// 效果行的**自然句**（3.2 步 · F9 = A）：把 `SummaryLine.actions` 渲染成「对 敌方玩家 造成 8 点伤害」。
//
// 三条纪律：
//  ① **只给显示层用**：CLI 打印的是 `SummaryLine.text`（参数式、带 id），本文一个字都不参与；
//  ② **不改引擎、不改数据**：这里只读 `ActionSpec`，不重算任何数值、不消耗随机；
//  ③ **未知词条一律回落**：返回 `null` 交给调用方走老的 `humanizeTerms(result)`，不显示空白。
//
// 数值里的引用（`{ ref: self.atk }`）**原样写成 `self.atk`** —— 渲染前由 `resolveStatRefs`
// （`client/state/effectLine.ts`）换成数字；换不到时保留引用，比显示"数额"更可读。

import { renderSelector } from '../../cards/registry.ts'
import type { ActionSpec, Expr, PrimitiveName } from '../../engine/types.ts'
import { TERM_LABELS } from './terms.ts'

/** 词表 id → 人话（未登记的原样返回，与 `humanizeTerms` 同一份表） */
function labelOf(id: string): string {
  return TERM_LABELS[id] ?? id
}

/**
 * 条件里的 `$<名>` 引用 → 人话。
 *
 * `$player` / `$card` 是**条件表达式里的引用根**（`Condition` 的 `{ var }`），
 * 渲染时引擎写的是 `$player`，这里翻成人话；未登记的名字保留成「事件参数 x」。
 */
const VAR_LABELS: Readonly<Record<string, string>> = {
  player: '事件玩家',
  card: '事件卡牌',
  amount: '事件数值',
  source_id: '来源 id',
  slot_index: '格位号',
  own_hp: '己方血量',
  enemy_hp: '敌方血量',
  damage_dealt: '本次伤害',
  shield_absorbed: '本次吸收',
  attack_count: '本次攻击次数',
  damage_type: '伤害类型',
  pending_count: '待释放数',
  cleansed_burn: '净化灼烧',
  cleansed_poison: '净化剧毒',
}

/**
 * 触发器里的**条件表达式**改成人话（F9 的补充规则）。
 *
 * `CardRegistry` 的条件是机器口径：`$player == 敌方玩家 或 count(全体敌方卡牌) > 1`。
 * 这里在**显示层**做四件事：
 * ① `$player` → 「事件玩家」；② `count(<选择器>)` → 「<选择器> 的数量」；
 * ③ `==` / `!=` → 「是 / 不是」；④ `>=` / `<=` → `≥` / `≤`（`<` / `>` 保持符号）。
 *
 * 注意顺序：**先跑它、再跑 `humanizeTerms`** —— 否则 `humanizeTerms` 会先把
 * `count(all_enemy_cards)` 里的 id 翻成中文，`count(...)` 的括号就认不出来了。
 *
 * @param text 触发器文本（`时机 on_player_damaged，条件（…）`）
 * @returns 人话文本（未识别的部分原样保留）
 */
export function naturalTriggerText(text: string): string {
  return text
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_all: string, name: string) => VAR_LABELS[name] ?? `事件参数 ${name}`)
    .replace(/count\(([a-z_][a-z0-9_]*)\)/gu, (_all: string, selector: string) => `${labelOf(selector)} 的数量`)
    .replace(/ == /gu, ' 是 ')
    .replace(/ != /gu, ' 不是 ')
    .replace(/ >= /gu, ' ≥ ')
    .replace(/ <= /gu, ' ≤ ')
}

/**
 * 目标：13 条字符串缩写查词表；**查询对象**（`{ side, zone, … }` 这类高级写法）
 * 回落到「符合『…』的目标」，里面的参数串来自 `renderSelector`（机器口径，但至少不是空白）。
 */
export function targetText(target: ActionSpec['target']): string {
  if (target === undefined) return '目标'
  if (typeof target === 'string') return labelOf(target)
  return `符合「${renderSelector(target)}」的目标`
}

/**
 * 数值表达式 → 句子里的一个词。
 *
 * - 字面量：直接写数字；
 * - 引用：原样写 `self.atk`（等待 `resolveStatRefs` 换数）；
 * - 事件参数：`事件参数 <名>`；
 * - 计数 / 四则：递归拼接。
 *
 * @returns 无法表达时 `null`（调用方写 `?` 或回落）
 */
export function amountText(expr: Expr | undefined): string | null {
  if (expr === undefined) return null
  if (typeof expr === 'number') return String(expr)
  if (typeof expr === 'string') return expr
  if ('ref' in expr) return expr.ref
  if ('var' in expr) return `事件参数 ${expr.var}`
  if ('count' in expr) return `${targetText(expr.count)} 的数量`
  const join = (items: readonly Expr[], op: string): string =>
    items.map((item) => amountText(item) ?? '?').join(` ${op} `)
  if ('add' in expr) return join(expr.add, '+')
  if ('sub' in expr) return join(expr.sub, '−')
  if ('mul' in expr) return join(expr.mul, '×')
  if ('div' in expr) return join(expr.div, '÷')
  return null
}

/** `gain_stat` 的数值：负数写成"减少 N"，其余写"增加 N" */
function statChange(expr: Expr | undefined): string {
  if (typeof expr === 'number' && expr < 0) return `减少 ${String(-expr)}`
  return `增加 ${amountText(expr) ?? '?'}`
}

/** 九条动作原语的句式。**漏一条就回落**（`naturalActions` 返回 `null`），不会产出半截句子。 */
const VERB: Partial<Record<PrimitiveName, (action: ActionSpec) => string>> = {
  deal_damage: (action) => `对 ${targetText(action.target)} 造成 ${amountText(action.amount) ?? '?'} 点伤害`,
  heal_player: (action) => `为 ${targetText(action.target)} 回复 ${amountText(action.amount) ?? '?'} 点生命`,
  shield: (action) => `为 ${targetText(action.target)} 施加 ${amountText(action.amount) ?? '?'} 点护盾`,
  gain_stat: (action) =>
    `使 ${targetText(action.target)} 的 ${labelOf(action.stat ?? '?')} ${statChange(action.amount)}`,
  apply_status: (action) => {
    const seconds = amountText(action.seconds)
    const status = labelOf(String(action.status ?? '?'))
    return `对 ${targetText(action.target)} 施加 ${status}${seconds === null ? '' : ` ${seconds} 秒`}`
  },
  charge: (action) =>
    `为 ${targetText(action.target)} 推进 ${amountText(action.seconds) ?? amountText(action.amount) ?? '?'} 秒行动条`,
  destroy: (action) => `使 ${targetText(action.target)} 失效`,
  repair: (action) => `修复 ${targetText(action.target)}`,
  enchant: (action) => `对 ${targetText(action.target)} 施加附魔「${action.enchant ?? '?'}」`,
}

/**
 * 一条动作 → 一句自然句。
 *
 * @returns 原语未登记（将来新增、前端还没补句式）时 `null`
 */
export function naturalAction(action: ActionSpec): string | null {
  const render = VERB[action.do]
  return render === undefined ? null : render(action)
}

/**
 * 一组动作 → 用 `；` 连起来的一句（多条动作的卡很常见）。
 *
 * @returns 空数组 / 任一动作无法表达时 `null`（调用方回落到参数式文本）
 */
export function naturalActions(actions: readonly ActionSpec[]): string | null {
  if (actions.length === 0) return null
  const parts: string[] = []
  for (const action of actions) {
    const text = naturalAction(action)
    if (text === null) return null
    parts.push(text)
  }
  return parts.join('；')
}
