/// <reference types="vite/client" />

// 本文件是 Vite + React 项目的标准环境声明（`npm create vite` 默认生成同名文件）。
//
// 作用一：让 `import.meta.env` / `import.meta.hot` 等 Vite 注入的成员有类型。
// 作用二（当前的实际作用）：在表现层还没有业务源码的阶段，给 tsconfig.client.json
// 一个输入文件。否则 `tsc --noEmit -p tsconfig.client.json` 会报
// `TS18003: No inputs were found`，让 `npm run verify` 卡在第三步 ——
// 引擎侧早已有源码、不再属于"零源码期"，但 client/ 之前只有 .gitkeep，
// 于是"配置有效"与"这一侧还没源码"又混在一起了。
//
// 三斜线引用是官方推荐写法、不能用 import 替代（该规则已在 eslint.config.js
// 里对 client/**/*.d.ts 放行）。client/ 有第一个真实 .tsx 之后，本文件照常保留。
