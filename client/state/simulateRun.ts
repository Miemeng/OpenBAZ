// 跑一局所需的**纯逻辑**：种子解析 / 生成 + 草稿装配结果 → `BattleOptions`。

// 三条口径：
//   · **本文件不调 `runBattle`** —— 引擎调用只允许出现在"开始对局"的事件处理里（《前端设计.md》§4 纪律 1）；
//   · 种子只在这里生成（`crypto.getRandomValues`，**不用 `Math.random()`**：全仓 ESLint 禁用）；
//   · 血量 / 摆盘 / 技能一律取 `cards/deck.ts` 的 `resolveDeck()` 产物，**前端不写第二份装配规则**。
import type { ResolvedDeck } from '../../cards/deck.ts'
import { DEFAULT_LOG_LEVEL } from '../../engine/log.ts'
import type { BattleOptions, LogLevel } from '../../engine/types.ts'

/**
 * 生成一个新种子（32 位无符号整数）。
 *
 * 用 `crypto.getRandomValues` 而非 `Math.random()` —— 后者是仓库级禁用的不确定性来源。
 * 这里随机的是**种子本身**：一旦回显进输入框，"同一 seed 重跑必然逐字节一致"就成立。
 */
export function newSeed(): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0] ?? 0
}

/** 把种子输入框的原文解析成数字（空串 = 交给调用方生成）。 */
export function parseSeedText(text: string): { readonly seed?: number; readonly error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) {
    return { error: `种子必须是非负数字（现在是「${trimmed}」）；留空 = 开始时自动生成并回显` }
  }
  return { seed: value }
}

/** 组装一局的引擎入参（字段与 `simulator/run.ts` 的 `battleOptions` 一一对应）。 */
export function buildBattleOptions(input: {
  readonly seed: number
  readonly sideA: ResolvedDeck
  readonly sideB: ResolvedDeck
  readonly logLevel?: LogLevel | undefined
  readonly captureFrames?: boolean | undefined
}): BattleOptions {
  return {
    seed: input.seed,
    // 玩家名与 CLI 保持一致（`玩家A` / `玩家B`）：页面日志与 CLI 日志因此可以逐行对照；
    // 阵容显示名（`ResolvedDeck.name`）走 UI 自己的标题，不进引擎。
    playerAName: '玩家A',
    playerBName: '玩家B',
    boardA: [...input.sideA.placements],
    boardB: [...input.sideB.placements],
    skillsA: [...input.sideA.skills],
    skillsB: [...input.sideB.skills],
    hpA: input.sideA.hp,
    maxHpA: input.sideA.maxHp,
    hpB: input.sideB.hp,
    maxHpB: input.sideB.maxHp,
    logLevel: input.logLevel ?? DEFAULT_LOG_LEVEL,
    captureFrames: input.captureFrames ?? false,
  }
}
