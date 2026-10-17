// 卡牌库的**纯逻辑**：`state/` 不放 JSX、不碰引擎调用

// 这里只有"把加载结果摊平成行 + 筛选 + 汇总选项"三件事，**不实现任何战斗规则**：
// 占格数、数值、效果描述全部来自引擎契约里的 `Card`，本层只做展示前的整理。
import type { Card } from '../../engine/types.ts'
import type { LoadedPack } from '../../cards/types.ts'
import { collectRarities, rarityOf, type RarityLook, type RarityTable } from '../theme/rarity.ts'

/** 卡牌列表的一行（把"卡 + 来源包 + 品阶显示口径"打包好，UI 不必重复查表） */
export interface CardRow {
  readonly card: Card
  readonly packId: string
  readonly packName: string
  readonly rarity: RarityLook
}

export interface LibraryFilter {
  /** 品阶多选（空 = 不限） */
  readonly rarities: readonly string[]
  /** 标签多选（空 = 不限；多选之间是**任一命中**） */
  readonly tags: readonly string[]
  /** 来源卡包多选（空 = 不限） */
  readonly packIds: readonly string[]
  /** 文本搜索（匹配 id / 名称 / 卡包名；空 = 不限） */
  readonly query: string
}

export const EMPTY_FILTER: LibraryFilter = { rarities: [], tags: [], packIds: [], query: '' }

export interface LibraryFacets {
  readonly rarities: readonly RarityLook[]
  readonly tags: readonly string[]
  readonly packs: readonly { readonly id: string; readonly name: string }[]
}

/** 摊平成行并排序：**品阶顺序 → 卡牌 id**（同品阶内按 id 稳定排列，便于反复筛选时定位） */
export function buildRows(packs: readonly LoadedPack[], table?: RarityTable): CardRow[] {
  const rarityTable = table ?? collectRarities(packs)
  const rows: CardRow[] = []
  for (const pack of packs) {
    for (const card of pack.cards) {
      rows.push({
        card,
        packId: pack.packId,
        packName: pack.name,
        rarity: rarityOf(rarityTable, card.rarity),
      })
    }
  }
  rows.sort((left, right) => left.rarity.order - right.rarity.order || left.card.id.localeCompare(right.card.id))
  return rows
}

/**
 * 筛选器的可选项。
 *
 * 品阶 = 当前**出现过**的品阶（按品阶顺序）；标签 = `tags` ∪ `hiddenTags`
 * （`hiddenTags` 是"隐藏词条"：不显示在卡面，但**过滤时仍然可用**）；
 * 卡包 = 每个包一项（显示名用 `pack.yml` 的 `name`，取不到才回落 `packId`）。
 */
export function facetsOf(rows: readonly CardRow[]): LibraryFacets {
  const rarityMap = new Map<string, RarityLook>()
  const tags = new Set<string>()
  const packs = new Map<string, string>()

  for (const row of rows) {
    if (!rarityMap.has(row.rarity.id)) rarityMap.set(row.rarity.id, row.rarity)
    for (const tag of row.card.tags ?? []) tags.add(tag)
    for (const tag of row.card.hiddenTags ?? []) tags.add(tag)
    packs.set(row.packId, row.packName)
  }

  return {
    rarities: [...rarityMap.values()].sort((left, right) => left.order - right.order),
    tags: [...tags].sort((left, right) => left.localeCompare(right)),
    packs: [...packs.entries()].map(([id, name]) => ({ id, name })),
  }
}

/** 应用筛选（纯函数；不改原数组） */
export function applyFilter(rows: readonly CardRow[], filter: LibraryFilter): CardRow[] {
  const query = filter.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter.rarities.length > 0 && !filter.rarities.includes(row.card.rarity)) return false
    if (filter.packIds.length > 0 && !filter.packIds.includes(row.packId)) return false
    if (filter.tags.length > 0) {
      const mine = new Set<string>([...(row.card.tags ?? []), ...(row.card.hiddenTags ?? [])])
      if (!filter.tags.some((tag) => mine.has(tag))) return false
    }
    if (query !== '') {
      const haystack = `${row.card.id} ${row.card.name} ${row.packName}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

/** 多选切换的小工具（chips 用；命中就移除、否则追加，保持原顺序） */
export function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}
