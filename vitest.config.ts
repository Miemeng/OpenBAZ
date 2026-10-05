// 测试框架：Vitest 5（工具链契约见框架设计 §2.5.3 / AGENT.md §4.2）
//
// 两条必须记住的约束：
// 1. Vitest 经 esbuild 转译，会容忍 Node 类型擦除不支持的语法（enum / 参数属性 / 装饰器…），
//    因此"测试全绿"不能证明 `node simulator/*.ts` 能跑 —— CI 必须另跑一次真实 CLI（框架 §2.5.3 第 5 条）。
// 2. 确定性回归不得依赖 Vitest 快照序列化；hash 一律按 AGENT.md §7 的规范化序列化约定自行计算。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // engine/ cards/ simulator/ 是纯逻辑测试；client/ 组件测试到 M6 再单独配置环境
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'client/**'],
  },
})
