// 阵容 → YAML 文本（**保存 / 导出**用；纯逻辑，不碰 DOM、不引 js-yaml）。
//
// 为什么手写而不是 `js-yaml.dump`：字段是固定的（`DeckDto`），手写能保证
// ① **字段顺序稳定**（便于 diff / 比对）；② 前端 bundle 不额外吃一个 yaml 库。
// 形状与 `cards/deck.ts` 的 `parseDeckText` 完全对齐 —— 导出的文件放回 `decks/` 即可被读回。

import type { DeckDto } from '../../cards/deck.ts'

/** 保存时用的文件名：`<side>_<n>.yml`（n 从 01 起，跳过已占用的号） */
export function nextDeckFileName(side: 'A' | 'B', existingPaths: readonly string[]): string {
  const pattern = new RegExp(`(?:^|/)${side}_(\\d+)\\.ya?ml$`, 'u')
  const used = new Set<number>()
  for (const path of existingPaths) {
    const matched = pattern.exec(path)
    const digits = matched?.[1]
    if (digits !== undefined) used.add(Number(digits))
  }
  let next = 1
  while (used.has(next)) next += 1
  return `${side}_${String(next).padStart(2, '0')}.yml`
}

/** 需要引号的标量（含中文 / 冒号 / 空格等）一律写成 JSON 字符串 —— YAML 也接受这种写法 */
function scalar(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]*$/u.test(value) ? value : JSON.stringify(value)
}

/**
 * 把阵容 DTO 写成可读的 YAML。
 *
 * @param dto 阵容（`sideToDeckDto` 的产物）
 * @param name 显示名（同时写进 `name:`；通常就是文件名主干）
 * @returns YAML 文本（**不含**尾随换行以外的装饰；末尾保证一个换行）
 */
export function deckToYaml(dto: DeckDto, name: string): string {
  const lines: string[] = [
    '# 由摆盘导出 —— 放进 decks/ 即可被「导入阵容」读到',
    `name: ${scalar(name)}`,
    `hero: ${scalar(dto.hero)}`,
  ]
  if (dto.hp !== undefined) lines.push(`hp: ${String(dto.hp)}`)
  if (dto.maxHp !== undefined) lines.push(`maxHp: ${String(dto.maxHp)}`)
  lines.push('cards:')
  for (const card of dto.cards) {
    lines.push(`  - id: ${scalar(card.id)}`)
    lines.push(`    slot: ${String(card.slot)}`)
    if (card.enchant !== undefined) lines.push(`    enchant: ${scalar(card.enchant)}`)
    const stats = card.stats
    if (stats !== undefined && Object.keys(stats).length > 0) {
      const pairs = Object.keys(stats)
        .sort()
        .map((key) => `${key}: ${String(stats[key])}`)
      lines.push(`    stats: { ${pairs.join(', ')} }`)
    }
  }
  const skills = dto.skills ?? []
  if (skills.length > 0) {
    lines.push('skills:')
    for (const skill of skills) lines.push(`  - ${scalar(skill)}`)
  }
  return `${lines.join('\n')}\n`
}
