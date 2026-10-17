// 品阶 → 颜色 / 卡框（表现层）

// 口径：
//   · **卡框只由品阶决定**（卡面没有 `frame` 字段）；
//   · 渲染优先级 = **品阶 `frame`（图片）> 品阶 `color`（纯色）> 内置兜底色**；
//   · 素材路径 = `packs/<pack_id>/images/frames/<frame>/card_frame.png`（同文件夹里还有 `skill_frame.png`）；
//     **读取层不解析路径也不校验图片**，所以"有没有图"这件事只有前端知道 —— 由 `border-image` 缺图不画回落纯色。

// `rarities: { source: builtin }` 的包**没有品阶项**（`LoadedRarities` 只有 `{ source: 'builtin' }`），
// 故颜色回落到 `cards/economy.ts` 的内置表（与 `packs/base/rarities.yml` 保持一致）。
import { BUILTIN_RARITY_COLORS, FALLBACK_RARITY_COLOR } from '../../cards/economy.ts'
import type { LoadedPack } from '../../cards/types.ts'

/** 某个品阶的**显示口径**（已套过兜底，UI 直接可用） */
export interface RarityLook {
  readonly id: string
  readonly name: string
  readonly color: string
  /** 卡框资源 id；没写 ⇒ 用纯色卡框 */
  readonly frame?: string
  /** 来自哪个包；内置兜底/未登记 = `null` */
  readonly packId: string | null
  /** 品阶顺序（列表排序用；越小越靠前） */
  readonly order: number
}

export interface RarityTable {
  readonly byId: ReadonlyMap<string, RarityLook>
  /** 按 order 排好的品阶（筛选器按这个顺序渲染） */
  readonly list: readonly RarityLook[]
}

/**
 * 汇总各包的品阶表。
 *
 * 顺序 = **先各包 `rarities.yml` 里声明的顺序**（游戏自己的表说了算），再用内置四档补齐缺的
 * （应对"包只声明了自定义品阶"或"基础包被改动"）。同 id **先到者保留** —— 与读取层
 * "同 id 先到者保留（目录名字典序）"同口径，不在这里另立规则。
 */
export function collectRarities(packs: readonly LoadedPack[]): RarityTable {
  const byId = new Map<string, RarityLook>()
  const list: RarityLook[] = []

  const push = (id: string, name: string, color: string, frame: string | undefined, packId: string | null): void => {
    if (byId.has(id)) return
    const look: RarityLook = {
      id,
      name,
      color,
      ...(frame === undefined ? {} : { frame }),
      packId,
      order: list.length,
    }
    byId.set(id, look)
    list.push(look)
  }

  for (const pack of packs) {
    if (pack.rarities?.source !== 'file') continue
    for (const item of pack.rarities.items) {
      push(item.id, item.name, item.color, item.frame, pack.packId)
    }
  }
  for (const [id, color] of Object.entries(BUILTIN_RARITY_COLORS)) {
    push(id, id, color, undefined, null)
  }

  return { byId, list }
}

/** 取一个品阶的显示口径；**未登记**的品阶也能返回（兜底色 + id 当名字），UI 不必判空 */
export function rarityOf(table: RarityTable, id: string): RarityLook {
  return (
    table.byId.get(id) ?? {
      id,
      name: id,
      color: FALLBACK_RARITY_COLOR,
      packId: null,
      order: Number.MAX_SAFE_INTEGER,
    }
  )
}
