// 表现层构建配置

// 三条决定：
//   ① `root: 'client'` —— `client/` 自成一界，入口 = `client/index.html`；
//      产物落到仓库根的 `dist/`（与源码目录分开），`emptyOutDir` 必须显式开，
//      因为 `outDir` 在 root 之外时 Vite 默认不会清目录。
//   ② `server.fs.allow: ['..']` —— `client/` 里的 import 要走到仓库根的 `engine/` / `cards/` 源码，
//      而 dev server 默认只放行项目根（= `client/`）内的文件。
//   ③ **不设 `resolve.alias`** —— 与  tsconfig 的 paths 别名」同一口径：
//      同一份源码要能在 Node（CLI 直跑）与浏览器（Vite）两条链路上跑，路径一律写相对路径。
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { packsApi } from './tools/packs-api.mjs'

export default defineConfig({
  root: 'client',
  // `packsApi()` = 开发期卡牌数据中介（`/api/packs`、`/api/packs/<packId>/images/*`）：
  // 它在 Node 侧跑现成的读取层，把 `LoadResult` 原样 JSON 给前端。
  // 构建期这条路不存在，前端改读 `packs.manifest.json`（`npm run packs:manifest` 预生成）。
  plugins: [react(), packsApi()],
  server: {
    fs: {
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
