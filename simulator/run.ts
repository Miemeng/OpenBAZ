// 单局 CLI —— 最小可跑版入口

// 用法：
//   node simulator/run.ts --deckA decks/testA.yml --deckB decks/testB.yml            # 缺省 seed=42
//   node simulator/run.ts --deckA decks/testA.yml --deckB decks/testB.yml --seed 7   # 指定种子
//   node simulator/run.ts --deckA ... --deckB ... --quiet                            # 不打印摆盘图
//   node simulator/run.ts --deckA ... --deckB ... --log log.txt                      # 输出另存（UTF-8）
//   node simulator/run.ts --deckA ... --deckB ... --log-level warn                   # 只记 warn 及以上
//   node simulator/run.ts --help

// 确定性自证（验收标准之一，已脚本化）：
//   npm run regression      # 同一 seed 连跑两次比 SHA256 + 与冻结基准比 hash（tools/regression-check.mjs）

// 【临时输出日志，后面改】为什么由程序自己写文件而不是让 shell 重定向：
// PowerShell 5.1 的 `>` / `Out-File` 默认写 UTF-16LE，而 `Get-Content` 不带编码参数时
// 又按系统 ANSI（中文机器 = GBK）解码，于是"文件乱码、终端正常"。本文件是宿主层，
// 允许碰 Node API，直接用 fs 写 UTF-8 即可绕开整个代码页问题。
// 待的日志落地（结构化事件 + 可选落盘）后，本段整体删除。

// 本文件是**宿主层**：允许碰 Node API / console（engine/ 才禁止）。
// 阵容来源：`--deckA` / `--deckB` **必填**，走读取层（`cards/loader.ts` + `./deck.ts`）。
// 内置示例卡组 `./demo-deck.ts` **已删除**（接线早已打通，示例数据改由 `packs/test` 承载），
// 因此不再有"裸跑回落"分支 —— 这也意味着 `npm run verify` 与回归基准都改跑真实阵容。
import { writeFileSync } from 'node:fs'
import { renderRow, validatePlacements } from '../engine/board.ts'
import { PACKS_ROOT } from '../cards/loader.ts'
import type { ValidationError } from '../cards/types.ts'
import { DEFAULT_LOG_LEVEL, parseLogLevel, renderSetup } from '../engine/log.ts'
import { csToSeconds, createBattleState, MAX_TIME_SECONDS } from '../engine/state.ts'
import { runBattle } from '../engine/tick.ts'
import type { BattleOptions, LocaleTable, LogLevel } from '../engine/types.ts'
import { hasFatal, loadDecks } from './deck.ts'
import { battleDigest } from './digest.ts'
import { loadLocaleTable, localeNameOf, resolveLocalePath } from './locale.ts'

/** 把一条校验问题渲染成一行（与 `simulator/validate.ts` 的 `formatIssue` 同形；那边未导出，故此处自带）。 */
function formatIssue(issue: ValidationError): string {
  const severity = issue.severity ?? 'error'
  const where = issue.line === undefined ? '' : `:${String(issue.line)}`
  const position = issue.file === undefined ? '' : `${issue.file}${where}  `
  const path = issue.path === undefined || issue.path === '' ? '' : `${issue.path}  `
  const suggestion = issue.suggestion === undefined ? '' : `\n    建议：${issue.suggestion}`
  return `[${severity}] ${issue.code}  ${position}${path}\n    ${issue.message}${suggestion}`
}

/** 命令行参数（手写解析：最小可跑版不引入依赖） */
interface CliOptions {
  readonly seed: number
  readonly quiet: boolean
  readonly help: boolean
  /** 若非 null，则把全部输出额外写入该路径（UTF-8） */
  readonly logPath: string | null
  /** 消息记录阈值（缺省 `note`），只影响"提示消息记不记"，不影响对局结果 */
  readonly logLevel: LogLevel
  /** A / B 方阵容文件路径；**两个都为 null ⇒ 回落内置示例卡组**（保持旧行为）。 */
  readonly deckAPath: string | null
  readonly deckBPath: string | null
  /** 额外数据根（可重复）；缺省 = 只加载 `packs/`。 */
  readonly packRoots: readonly string[]
  /** 语言表（语言名或文件路径）；`null` = 用引擎内置中文。 */
  readonly localePath: string | null
  /** 若非 null，把**结构化摘要**（与语言无关）写入该路径；确定性回归用它当判据。 */
  readonly digestPath: string | null
}

function parseArgs(argv: readonly string[]): CliOptions {
  let seed = 42
  let quiet = false
  let help = false
  let logPath: string | null = null
  let logLevel: LogLevel = DEFAULT_LOG_LEVEL
  let deckAPath: string | null = null
  let deckBPath: string | null = null
  const packRoots: string[] = []
  let localePath: string | null = null
  let digestPath: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--quiet' || arg === '-q') {
      quiet = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--deckA' || arg === '--deckB' || arg === '--pack') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error(`${arg} 后面缺少文件路径`)
      }
      if (arg === '--deckA') deckAPath = raw
      else if (arg === '--deckB') deckBPath = raw
      else packRoots.push(raw)
      i += 1
    } else if (arg === '--log') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--log 后面缺少文件路径')
      }
      logPath = raw
      i += 1
    } else if (arg !== undefined && arg.startsWith('--log=')) {
      logPath = arg.slice('--log='.length)
    } else if (arg === '--log-level') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--log-level 后面缺少级别名')
      }
      logLevel = parseLogLevel(raw)
      i += 1
    } else if (arg !== undefined && arg.startsWith('--log-level=')) {
      logLevel = parseLogLevel(arg.slice('--log-level='.length))
    } else if (arg === '--seed') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--seed 后面缺少数值')
      }
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) {
        throw new Error(`--seed 需要数值，收到 ${raw}`)
      }
      seed = parsed
      i += 1
    } else if (arg !== undefined && arg.startsWith('--seed=')) {
      const parsed = Number(arg.slice('--seed='.length))
      if (!Number.isFinite(parsed)) {
        throw new Error(`--seed 需要数值，收到 ${arg}`)
      }
      seed = parsed
    } else if (arg === '--locale') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--locale 后面缺少语言名或文件路径')
      }
      localePath = raw
      i += 1
    } else if (arg !== undefined && arg.startsWith('--locale=')) {
      localePath = arg.slice('--locale='.length)
    } else if (arg === '--digest') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--digest 后面缺少文件路径')
      }
      digestPath = raw
      i += 1
    } else if (arg !== undefined && arg.startsWith('--digest=')) {
      digestPath = arg.slice('--digest='.length)
    } else {
      throw new Error(`无法识别的参数：${String(arg)}（用 --help 查看用法）`)
    }
  }

  return { seed, quiet, help, logPath, logLevel, deckAPath, deckBPath, packRoots, localePath, digestPath }
}

// 需要强调路径 / 标识符时统一用「」。
const USAGE = `用法：node simulator/run.ts --deckA <路径> --deckB <路径> [--seed N] [--quiet] [--log <路径>] [--log-level <级别>]
  --deckA <路径>   A 方阵容文件（decks/<名>.yml）；**必填**，与 --deckB 成对给出
  --deckB <路径>   B 方阵容文件；**必填**（内置示例卡组 demo-deck 已于  删除，
                   示例数据改由「packs/test」承载：--deckA decks/testA.yml --deckB decks/testB.yml）
  --pack <路径>    额外数据根（可重复；缺省「packs/」）
  --seed N       指定随机种子（默认 42）；同一 seed 必然得到完全相同的日志
  --quiet        不打印开局的 10 格摆盘图
  --log <路径>   把全部输出额外写入该文件（UTF-8，无时间戳；不要用 shell 的 > 重定向）
  --log-level    消息记录阈值，缺省 note；合法取值：error / warn / note / info / debug
                 （只影响「提示消息记不记」，不影响对局结果；低于阈值的消息直接丢弃）
  --locale <名|路径> 语言表（缺省 = 引擎内置中文）：写语言名「zh-CN」⇒ 读「locales/zh-CN.yml」，
                 也可直接给文件路径。只换文案，不改对局结果
  --digest <路径> 把**结构化摘要**（与语言无关：终局结果 + 完整动作日志 + 消息 code/参数）
                 写入该文件；确定性回归用它当判据，不再 hash 文本日志
  --help         显示本帮助`

function main(): void {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(USAGE)
    return
  }

  // 输出统一走这个收集器：既打到 stdout，又在 --log 时累积成文件内容。
  // 这样"终端看到的"与"文件里的"是同一份字节，不会出现两边不一致。
  const fileLines: string[] = []
  const out = (line: string): void => {
    console.log(line)
    if (options.logPath !== null) fileLines.push(line)
  }

  // ——— 阵容来源：`--deckA` / `--deckB` **必填** —
  // 内置示例卡组（`demo-deck.ts`）已删除 ⇒ 不再有"裸跑回落"分支。
  // 原因：接线（`packs/` 真实数据 → 对局）已打通，示例数据由 `packs/test` 承载；
  // 代价是 `npm run verify` 的第 6 步与确定性回归基准都必须改跑真实阵容。
  if (options.deckAPath === null || options.deckBPath === null) {
    out('！--deckA 与 --deckB 必须成对给出（内置示例卡组已删除；用 --help 查看用法）')
    flushLog(options.logPath, fileLines)
    process.exitCode = 1
    return
  }

  const roots = options.packRoots.length > 0 ? options.packRoots : [PACKS_ROOT]
  // 数据文案（`name` / `description`）按 `--locale` 的**语言名**解析：
  // 给语言名就用它；给文件路径则取文件名主干（`locales/en.yml` ⇒ `en`）。
  const dataLocale = options.localePath === null ? undefined : localeNameOf(options.localePath)
  const loaded = loadDecks(roots, options.deckAPath, options.deckBPath, dataLocale)
  if (hasFatal(loaded.errors)) {
    out(`=== 数据 / 阵容有问题（${String(loaded.errors.length)} 条）===`)
    for (const issue of loaded.errors) out(formatIssue(issue))
    flushLog(options.logPath, fileLines)
    process.exitCode = 1
    return
  }
  for (const issue of loaded.errors) out(formatIssue(issue))
  if (loaded.deckA === undefined || loaded.deckB === undefined) {
    out('！阵容装配失败')
    flushLog(options.logPath, fileLines)
    process.exitCode = 1
    return
  }

  const boardA = [...loaded.deckA.placements]
  const boardB = [...loaded.deckB.placements]
  const skillsA = [...loaded.deckA.skills]
  const skillsB = [...loaded.deckB.skills]

  // 摆盘几何校验（越界 / 重叠）：出错即中止，不带着非法摆盘开打
  // （读取层分支已在校验里查过一遍；这里再兜一次，保证行为一致）
  const errors = [...validatePlacements(1, boardA), ...validatePlacements(2, boardB)]
  if (errors.length > 0) {
    for (const error of errors) out(`[${error.code}] ${error.message}`)
    flushLog(options.logPath, fileLines)
    process.exitCode = 1
    return
  }

  // ——— 语言表（选填）：**纯数据注入**，只换文案 ——
  // 注意：这里**只在给了 `--locale` 时才打印一行**，缺省路径的输出与引入语言表之前逐字节一致
  // （确定性回归的 5 条基准正是靠这一点不变）。
  let locale: LocaleTable | null = null
  if (options.localePath !== null) {
    try {
      locale = loadLocaleTable(resolveLocalePath(options.localePath))
    } catch (error) {
      out(`！${error instanceof Error ? error.message : String(error)}`)
      flushLog(options.logPath, fileLines)
      process.exitCode = 1
      return
    }
    out(`语言表：${options.localePath}（${String(Object.keys(locale).length)} 条）`)
  }

  const battleOptions: BattleOptions = {
    seed: options.seed,
    // 玩家名保持固定：阵容名（`loaded.deckX.name`）留给客户端展示，CLI 侧改名会顺手改掉日志语义
    // —— 而"旧基准逐字节不变"本身是"帧快照不进 hash"的证据。
    playerAName: '玩家A',
    playerBName: '玩家B',
    boardA,
    boardB,
    skillsA,
    skillsB,
    logLevel: options.logLevel,
    hpA: loaded.deckA.hp,
    maxHpA: loaded.deckA.maxHp,
    hpB: loaded.deckB.hp,
    maxHpB: loaded.deckB.maxHp,
    ...(locale === null ? {} : { locale }),
  }

  // 开局摆盘图必须打**开局**状态，而 `runBattle` 返回的 `state` 是**终局**状态
  // （ 修：此前这一段直接读 `result.state`，于是"对局开始"下面显示的是收局血量/护盾）。
  // 这里按同一份入参再建一次初始状态专供展示 —— `createBattleState` 只构造状态、不推进时钟。
  const initialState = createBattleState(battleOptions)
  const result = runBattle(battleOptions)

  // 结构化摘要（与语言无关）：确定性回归的判据落在这里，文本日志不再参与 hash（AG.5 = B）。
  if (options.digestPath !== null) {
    writeFileSync(options.digestPath, battleDigest(result), { encoding: 'utf8' })
  }

  const { state } = result

  if (!options.quiet) {
    out(`=== 对局开始（seed = ${String(options.seed)}）===`)
    out('')
    // 摆盘图：一行 10 格，卡牌左端所在格与占格数都在图里
    for (const side of [1, 2] as const) {
      const player = initialState.players[side]
      // 分隔用全角空格一律写成 \u3000 转义：模板字面量默认不被 no-irregular-whitespace 跳过，直接写字面量会 lint 报错
      out(`${player.name}\u3000血量 ${String(player.hp)}\u3000护盾 ${String(player.shield)}`)
      for (const line of renderRow(player.board, '')) out(line)
      out('')
    }
    for (const line of renderSetup(initialState)) out(line)
    out('=== 对局日志 ===')
  }

  for (const line of result.lines) out(line)

  out('')
  if (state.messages.length > 0) {
    out(`=== 提示消息 ${String(state.messages.length)} 条（已在日志中以 [ NOTE] / [ WARN] 行标出）===`)
  }
  const winnerName = state.winner === null ? '未判定' : state.players[state.winner].name
  const reason =
    result.victory === 'timeout'
      ? `到达 MAX_TIME=${MAX_TIME_SECONDS.toFixed(2)}s（超时判平局，平局视为发起方 ${state.players[1].name} 获胜）`
      : '血量归零'
  out(`=== 结果：${winnerName} 获胜（${reason}）===`)
  out(
    `=== 用时：触发帧=${String(state.triggerFrame)} 全局帧=${String(state.timeCs)}（${csToSeconds(state.timeCs).toFixed(2)}s）===`,
  )
  out(
    `=== 终局血量：${state.players[1].name} ${String(state.players[1].hp)}\u3000${state.players[2].name} ${String(state.players[2].hp)} ===`,
  )

  flushLog(options.logPath, fileLines)
}

/** 把累积的输出写入文件（UTF-8 + 末尾换行；无时间戳，保证同 seed 逐字节可比） */
function flushLog(logPath: string | null, lines: readonly string[]): void {
  if (logPath === null) return
  writeFileSync(logPath, `${lines.join('\n')}\n`, { encoding: 'utf8' })
  console.log(`（全部输出已写入 ${logPath}，UTF-8）`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`运行失败：${message}`)
  process.exitCode = 1
}
