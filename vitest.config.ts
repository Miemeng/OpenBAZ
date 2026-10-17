// 测试框架：Vitest 5

// 两条必须记住的约束：
// 1. Vitest 经 esbuild 转译，会容忍 Node 类型擦除不支持的语法（enum / 参数属性 / 装饰器…），
//    因此"测试全绿"不能证明 `node simulator/*.ts` 能跑 —— CI 必须另跑一次真实 CLI。
// 2. 确定性回归不得依赖 Vitest 快照序列化；hash 一律按  的规范化序列化约定自行计算。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // engine/ cards/ simulator/ 是纯逻辑测试；client/ 只放行 **state/**（纯逻辑、不需要 DOM），
    // 组件测试（client/modes 等）到需要时再单独配 jsdom 环境。
    environment: 'node',
    include: [
      'engine/**/*.{test,spec}.ts',
      'cards/**/*.{test,spec}.ts',
      'simulator/**/*.{test,spec}.ts',
      'client/state/**/*.{test,spec}.ts',
    ],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
