// 确定性摘要（AG.5 = B）：把一局的**结构化产物**序列化成与语言无关的规范文本，
// 供 `tools/regression-check.mjs` 求 sha256 作为回归判据。
//
// 为什么不再 hash `--log` 文本：`--log` 是**渲染后的中文**，换语言、甚至改一句译文都会让基准变红
// （看起来像"引擎行为变了"）。判据必须只覆盖**判定相关**的内容：
//   · 终局结果（胜利方式 / 胜者 / 平局 / 时钟与触发帧）
//   · 双方终局血量 / 上限 / 护盾
//   · 完整结构化动作日志 `ActionLog[]`
//   · 分级消息 `LogMessage[]`（**只存 code + 参数**，不含渲染文本）
//
// 规范序列化约定（对齐 AGENT.md §7）：**显式字段列表**、对象键**排序**、`undefined` 键跳过、
// 数字按 JS 十进制字符串 —— 不依赖 `JSON.stringify` 的键序，也不含任何时间戳 / 路径。

import type { BattleResult } from '../engine/tick.ts'

/** 一个值是不是普通对象（排除 null / 数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 规范 JSON：对象键排序、跳过 `undefined`、数组保序。
 *
 * @param value 任意可序列化值
 * @returns 稳定的文本（同一结构必然得到同一字符串）
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    const pairs: string[] = []
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      if (item === undefined) continue
      pairs.push(`${JSON.stringify(key)}:${canonicalJson(item)}`)
    }
    return `{${pairs.join(',')}}`
  }
  return 'null'
}

/**
 * 一局的结构化摘要（**与语言无关**：同样的这局，换 `locale` 得到的摘要逐字节相同）。
 *
 * @param result `runBattle` 的产物
 * @returns 规范 JSON 文本（由调用方决定要不要再求 hash）
 */
export function battleDigest(result: BattleResult): string {
  const { state } = result
  return canonicalJson({
    victory: result.victory,
    seed: state.seed,
    timeCs: state.timeCs,
    triggerFrame: state.triggerFrame,
    finished: state.finished,
    winner: state.winner,
    draw: state.draw,
    players: {
      1: { hp: state.players[1].hp, maxHp: state.players[1].maxHp, shield: state.players[1].shield },
      2: { hp: state.players[2].hp, maxHp: state.players[2].maxHp, shield: state.players[2].shield },
    },
    log: result.log,
    messages: state.messages,
  })
}
