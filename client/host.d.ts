// 桌面宿主（Electron）在渲染层暴露的白名单桥（`desktop/preload.cjs` 注入）。
//
// 只有浏览器宿主里没有这个对象 ⇒ `client/data/packSource.ts` 用 `window.host !== undefined`
// 判断"第三条轨"（DEV 中间件 / PROD 清单 / 桌面 IPC）。

import type { LoadResult } from '../cards/types.ts'

/** 预加载层暴露的能力（纯转发 IPC，不含业务逻辑） */
export interface HostBridge {
  readonly kind: 'electron'
  /** 读 `userData/packs` 下的全部内容包 */
  loadPacks(): Promise<LoadResult>
  /** 读 `userData/decks` 下的阵容文件 */
  listDecks(): Promise<readonly { readonly path: string; readonly text: string }[]>
  /** 写一份阵容 YAML 到 `userData/decks` */
  saveDeck(name: string, text: string): Promise<{ readonly path: string }>
}

declare global {
  interface Window {
    /** 只在桌面宿主里存在；浏览器里是 `undefined` */
    readonly host?: HostBridge
  }
}

export {}
