// 桌面宿主的**数据层**构建配置：把 `desktop/host.ts` 打成 CJS，供纯 JS 主进程 `require`。
//
// 为什么不把主进程也写 TS：见《审阅》§AI.3 —— 不赌 Electron 内置 Node 的类型擦除；
// 主进程保持纯 JS（零构建），只有这一层需要打包（它要 import `cards/loader.ts` 的 zod 管线）。
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // SSR 构建：入口是 Node 侧代码，不注入浏览器 polyfill
    ssr: true,
    outDir: 'desktop/dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      input: 'desktop/host.ts',
      // 内置模块与第三方包都留给运行时 require（被打包会让 zod / js-yaml 的 CJS 形状出问题）
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'zod',
        'js-yaml',
      ],
      output: {
        format: 'cjs',
        entryFileNames: 'host.cjs',
        inlineDynamicImports: true,
      },
    },
  },
})
