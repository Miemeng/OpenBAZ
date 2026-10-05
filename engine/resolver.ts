// 【作废文件 —— 请删除】
//
// 本文件是最小可跑版第一轮的 `resolver.ts`（只实现了 dealDamage 一个原语）。
// 现已由 [engine/primitives.ts](engine/primitives.ts) 取代：
//   - 八原语全部实现（dealDamage / healPlayer / shield / gainStat / applyStatus / charge / destroy / repair）
//   - 玩家侧持续效果通道（灼烧 / 剧毒 / 再生）
//   - 通过 `applyAction(state, spec, ctx)` 统一入口分发，返回 ActionEffect[]
//
// 保留本文件**只有一个原因**：Agent 的终端在本仓库不可用（`SetNamedSecurityInfoW failed`），
// 无法执行删除；同时它已被改写为纯注释，不再向 `tsc` 提供任何类型，故不会污染 typecheck。
// RW 可在项目根执行：`Remove-Item engine/resolver.ts`
export {}
