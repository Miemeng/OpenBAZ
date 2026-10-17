// 卡牌数据的**唯一**取数出口 —— DEV 与 PROD 两条轨在这里收口。

//   DEV  = `GET /api/packs`（tools/packs-api.mjs 的 dev middleware：当场真读盘，改完 YAML 点"重载"即生效）
//   PROD = `packs.manifest.json`（tools/packs-manifest.mjs 预生成，随 `vite build` 进 dist）

// 两条轨的出口都是 `registry.replaceAll(result.packs)` —— UI 不需要知道数据从哪来。
// 图片同理只有一处差异：DEV 走中间件的 `/api/packs/<packId>/images/...`（真读盘），
// PROD 走 publicDir 里预拷好的 `/packs/<packId>/images/...`。

// ⚠️ 本文件是 `client/` 里**唯一**允许碰 `fetch` / `import.meta.env` 的地方：
//    将来换宿主（Electron / 本地服务）只改这一层。
import type { LoadResult } from '../../cards/types.ts'

export interface DeckText {
  /** 相对仓库根的 POSIX 路径（如 `decks/testA.yml`） */
  readonly path: string
  /** 原文（交给 `cards/deck.ts` 的 `parseDeckText` 解析 —— 校验口径与 CLI 同一份） */
  readonly text: string
}

export interface PackDataSource {
  /** 取全量卡包数据（只产出不抛错的是读取层；网络/HTTP 失败**会抛**，由调用方兜住） */
  load(): Promise<LoadResult>
  /** 包内图片的 URL（`relativePath` 形如 `cards/emberWolf.png`、`frames/diamond/card_frame.png`） */
  assetUrl(packId: string, relativePath: string): string
  /**
   * **只读**导入现成阵容（不写文件）：
   * DEV 走中间件的 `/api/decks`（真读盘 —— 改完 `decks/*.yml` 刷新即见）；
   * PROD 走 `decks.json`（`npm run packs:manifest` 预生成）。**不写文件。**
   */
  loadDecks(): Promise<readonly DeckText[]>
}

const isDev = import.meta.env.DEV
const base = import.meta.env.BASE_URL

/** 去掉前导斜杠，避免拼出 `//` */
function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '')
}

export const packSource: PackDataSource = {
  async load(): Promise<LoadResult> {
    const url = isDev ? '/api/packs' : `${base}packs.manifest.json`
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`取数失败：GET ${url} → HTTP ${String(response.status)}`)
    }
    return (await response.json()) as LoadResult
  },

  assetUrl(packId: string, relativePath: string): string {
    const clean = trimLeadingSlash(relativePath)
    const safePackId = encodeURIComponent(packId)
    return isDev
      ? `/api/packs/${safePackId}/images/${clean}`
      : `${base}packs/${safePackId}/images/${clean}`
  },

  async loadDecks(): Promise<readonly DeckText[]> {
    const url = isDev ? '/api/decks' : `${base}decks.json`
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`取阵容失败：GET ${url} → HTTP ${String(response.status)}`)
    }
    const body = (await response.json()) as { readonly decks?: readonly DeckText[] }
    return body.decks ?? []
  },
}
