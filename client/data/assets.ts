// 表现层资源 URL 解析 —— **只拼路径，不校验图片是否存在**（读取层既不解析路径也不校验图片，
// 所以"有没有图"只有前端知道：一律靠 `<img>` 的 `onError` 回落，缺图不阻塞、不报错）。

// 文件名约定（**包内**；见《YAML数据格式规范.md》§5 与《卡面表现设计.md》§2.3）：
//   卡图     `images/cards/<card_id>.png`
//   技能图标 `images/skills/<skill_id>.png`
//   卡框     `images/frames/<frame_id>/card_frame.png`   ← v0.18 起：**每个品阶一个文件夹**
//   技能框   `images/frames/<frame_id>/skill_frame.png`  ← 同文件夹里的**固定文件名**（另一套素材）
//   角色头像 `images/heroes/<hero_id>/avatar.png`（**文件名固定 `avatar.png`**）
//
// `<frame_id>` = 品阶表 `rarities.yml` 里该品阶的 `frame` 取值（惯例与品阶 id 同名），
// 故**同一品阶的两张框在同一个文件夹里**、靠固定文件名区分（RW §Z.3）。
//
// 本文件**不碰** `fetch` / `import.meta.env`（那是 `packSource` 的唯一职责），只做"id → URL"。
// 卡 / 角色**各自属于哪个包**要查一遍，故提供 `buildAssetIndex()` 建一次表、之后 O(1) 查。
import type { LoadedPack } from '../../cards/types.ts'
import { packSource } from './packSource.ts'

/** id → 资源的 URL 表（在 `packs` 上建一次，别在 render 里循环 `packs`） */
export interface AssetIndex {
  /** 卡图（`images/cards/<card_id>.png`）；`null` = 没有哪个包装着这张卡 */
  cardArt(cardId: string): string | null
  /** 技能图标（`images/skills/<skill_id>.png`）；`null` = 没有哪个包装着这个技能 */
  skillIcon(skillId: string): string | null
  /** 角色头像（`images/heroes/<hero_id>/avatar.png`）；`null` = 找不到角色 */
  heroAvatar(heroId: string): string | null
  /**
   * 品阶**卡框**（`images/frames/<frame_id>/card_frame.png`）；`null` = 该品阶没写 `frame`。
   * `packId` 来自 `theme/rarity.ts` 的 `RarityLook.packId`（**声明该品阶的包**）——
   * 卡框只由品阶决定，与卡牌自己属于哪个包无关。
   */
  rarityFrame(frameId: string, packId: string | null): string | null
  /**
   * 品阶**技能框**（`images/frames/<frame_id>/skill_frame.png`）——与卡框**同一个文件夹**里的另一张素材
   *（**圆形贴图**：透明背景 + 只画环 / 材质，前端 `contain` 缩放，见 §Z.3）。⏳ T7（技能稀有度）接线。
   */
  skillFrame(frameId: string, packId: string | null): string | null
}

/** 在已加载的包上建"id → 包"表（同 id 多包时**先到者保留**，与读取层同口径） */
export function buildAssetIndex(packs: readonly LoadedPack[]): AssetIndex {
  const cardPack = new Map<string, string>()
  const skillPack = new Map<string, string>()
  const heroPack = new Map<string, string>()

  for (const pack of packs) {
    for (const card of pack.cards) if (!cardPack.has(card.id)) cardPack.set(card.id, pack.packId)
    for (const skill of pack.skills) if (!skillPack.has(skill.id)) skillPack.set(skill.id, pack.packId)
    for (const hero of pack.heroes) if (!heroPack.has(hero.id)) heroPack.set(hero.id, pack.packId)
  }

  return {
    cardArt(cardId: string): string | null {
      const packId = cardPack.get(cardId)
      return packId === undefined ? null : packSource.assetUrl(packId, `cards/${cardId}.png`)
    },
    skillIcon(skillId: string): string | null {
      const packId = skillPack.get(skillId)
      return packId === undefined ? null : packSource.assetUrl(packId, `skills/${skillId}.png`)
    },
    heroAvatar(heroId: string): string | null {
      const packId = heroPack.get(heroId)
      return packId === undefined ? null : packSource.assetUrl(packId, `heroes/${heroId}/avatar.png`)
    },
    rarityFrame(frameId: string, packId: string | null): string | null {
      return packId === null ? null : packSource.assetUrl(packId, `frames/${frameId}/card_frame.png`)
    },
    skillFrame(frameId: string, packId: string | null): string | null {
      return packId === null ? null : packSource.assetUrl(packId, `frames/${frameId}/skill_frame.png`)
    },
  }
}
