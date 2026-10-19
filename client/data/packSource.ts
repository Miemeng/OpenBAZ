// 卡牌数据的**唯一**取数出口 —— DEV / PROD / **桌面宿主**三条轨在这里收口。

//   DEV  = `GET /api/packs`（tools/packs-api.mjs 的 dev middleware：当场真读盘，改完 YAML 点"重载"即生效）
//   PROD = `packs.manifest.json`（tools/packs-manifest.mjs 预生成，随 `vite build` 进 dist）
//   DESKTOP = `window.host`（Electron 预加载脚本注入；主进程读 `userData/packs`，见 `desktop/main.cjs`）

// 三条轨的出口都是 `registry.replaceAll(result.packs)` —— UI 不需要知道数据从哪来。
// 图片同理：DEV 走中间件的 `/api/packs/<packId>/images/...`、PROD 走 publicDir 预拷好的
// `packs/<packId>/images/...`、DESKTOP 走自定义协议 `app://packs/<packId>/images/...`（主进程映射到 userData）。
//
// ⚠️ 本文件是 `client/` 里**唯一**允许碰 `fetch` / `import.meta.env` / `window.host` 的地方：
//    换宿主只改这一层。
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
   * PROD 走 `decks.json`（`npm run packs:manifest` 预生成）；
   * DESKTOP 走 IPC 读 `userData/decks`。
   */
  loadDecks(): Promise<readonly DeckText[]>
  /**
   * **写盘**保存阵容（只有桌面宿主有）。
   *
   * 浏览器里是 `undefined` —— 那边只能"下载 + 复制"（没有写盘能力）；
   * 桌面里写到 `userData/decks/<name>` 并把相对路径回传。
   */
  saveDeck?(name: string, text: string): Promise<{ readonly path: string }>
}

const isDev = import.meta.env.DEV
const base = import.meta.env.BASE_URL
/** 桌面宿主注入的桥（浏览器里是 `undefined`） */
const hostBridge = typeof window === 'undefined' ? undefined : window.host

/**
 * 当前是不是**桌面宿主**（Electron）。
 *
 * 只用于界面上的提示措辞（例如"卡牌为空时去哪里放包"）—— 数据通路仍然统一走本文件，
 * 组件不许直接碰 `window.host`。
 */
export const isDesktopHost = hostBridge !== undefined

/** 去掉前导斜杠，避免拼出 `//` */
function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '')
}

/** 桌面宿主的写盘保存（浏览器里不会走到这里） */
function saveDeckOnHost(name: string, text: string): Promise<{ readonly path: string }> {
  if (hostBridge === undefined) throw new Error('当前宿主不支持写盘')
  return hostBridge.saveDeck(name, text)
}

export const packSource: PackDataSource = {
  async load(): Promise<LoadResult> {
    if (hostBridge !== undefined) return hostBridge.loadPacks()
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
    if (hostBridge !== undefined) return `app://packs/${safePackId}/images/${clean}`
    return isDev
      ? `/api/packs/${safePackId}/images/${clean}`
      : `${base}packs/${safePackId}/images/${clean}`
  },

  async loadDecks(): Promise<readonly DeckText[]> {
    if (hostBridge !== undefined) return hostBridge.listDecks()
    const url = isDev ? '/api/decks' : `${base}decks.json`
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`取阵容失败：GET ${url} → HTTP ${String(response.status)}`)
    }
    const body = (await response.json()) as { readonly decks?: readonly DeckText[] }
    return body.decks ?? []
  },

  ...(hostBridge === undefined ? {} : { saveDeck: saveDeckOnHost }),
}
