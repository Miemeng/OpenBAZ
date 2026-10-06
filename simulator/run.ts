// 单局 CLI —— 最小可跑版入口（P0.6-B 第 6 项）
//
// 用法（Node 直接跑 .ts，依赖运行时的类型擦除，见 AGENT.md §4.1）：
//   node simulator/run.ts                  # 默认 seed=42
//   node simulator/run.ts --seed 7         # 指定种子
//   node simulator/run.ts --quiet          # 不打印摆盘图，只打印对局日志
//   node simulator/run.ts --log log.txt    # 同时把全部输出写入文件（UTF-8）
//   node simulator/run.ts --help
//
// 确定性自证（验收标准之一）：
//   node simulator/run.ts --seed 42 --log a.txt
//   node simulator/run.ts --seed 42 --log b.txt
//   fc.exe a.txt b.txt      # 必须完全一致（两条命令内容一致、无时间戳）
//
// 【临时输出日志，后面改】为什么由程序自己写文件而不是让 shell 重定向（RW 指示）：
// PowerShell 5.1 的 `>` / `Out-File` 默认写 UTF-16LE，而 `Get-Content` 不带编码参数时
// 又按系统 ANSI（中文机器 = GBK）解码，于是"文件乱码、终端正常"。本文件是宿主层，
// 允许碰 Node API，直接用 fs 写 UTF-8 即可绕开整个代码页问题。
// 待《模拟模式设计文档》的日志落地（结构化事件 + 可选落盘）后，本段整体删除。
//
// 本文件是**宿主层**：允许碰 Node API / console（engine/ 才禁止）。
// 卡牌数据现在是硬编码的：见 ./demo-deck.ts（YAML 加载与 schema 校验按后续阶段落地）。
import { writeFileSync } from 'node:fs'
import { renderRow, validatePlacements } from '../engine/board.ts'
import { renderSetup } from '../engine/log.ts'
import { csToSeconds, MAX_TIME_SECONDS } from '../engine/state.ts'
import { runBattle } from '../engine/tick.ts'
import { DECK_A, DECK_B, SKILLS_A, SKILLS_B } from './demo-deck.ts'

/** 命令行参数（手写解析：最小可跑版不引入依赖） */
interface CliOptions {
  readonly seed: number
  readonly quiet: boolean
  readonly help: boolean
  /** 若非 null，则把全部输出额外写入该路径（UTF-8） */
  readonly logPath: string | null
}

function parseArgs(argv: readonly string[]): CliOptions {
  let seed = 42
  let quiet = false
  let help = false
  let logPath: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--quiet' || arg === '-q') {
      quiet = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--log') {
      const raw = argv[i + 1]
      if (raw === undefined) {
        throw new Error('--log 后面缺少文件路径')
      }
      logPath = raw
      i += 1
    } else if (arg !== undefined && arg.startsWith('--log=')) {
      logPath = arg.slice('--log='.length)
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
    } else {
      throw new Error(`无法识别的参数：${String(arg)}（用 --help 查看用法）`)
    }
  }

  return { seed, quiet, help, logPath }
}

const USAGE = `用法：node simulator/run.ts [--seed N] [--quiet] [--log <路径>]
  --seed N       指定随机种子（默认 42）；同一 seed 必然得到完全相同的日志
  --quiet        不打印开局的 10 格摆盘图
  --log <路径>   把全部输出额外写入该文件（UTF-8，无时间戳；不要用 shell 的 > 重定向）
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

  // 摆盘几何校验（越界 / 重叠）：出错即中止，不带着非法摆盘开打
  const errors = [...validatePlacements(1, DECK_A), ...validatePlacements(2, DECK_B)]
  if (errors.length > 0) {
    for (const error of errors) out(`[${error.code}] ${error.message}`)
    flushLog(options.logPath, fileLines)
    process.exitCode = 1
    return
  }

  const result = runBattle({
    seed: options.seed,
    playerAName: '玩家A',
    playerBName: '玩家B',
    boardA: DECK_A,
    boardB: DECK_B,
    skillsA: SKILLS_A,
    skillsB: SKILLS_B,
  })

  const { state } = result

  if (!options.quiet) {
    out(`=== 对局开始（seed = ${String(options.seed)}）===`)
    out('')
    // 摆盘图：一行 10 格，卡牌左端所在格与占格数都在图里
    for (const side of [1, 2] as const) {
      const player = state.players[side]
      // 分隔用全角空格一律写成 \u3000 转义：模板字面量默认不被 no-irregular-whitespace 跳过，直接写字面量会 lint 报错
      out(`${player.name}\u3000血量 ${String(player.hp)}\u3000护盾 ${String(player.shield)}`)
      for (const line of renderRow(player.board, '')) out(line)
      out('')
    }
    for (const line of renderSetup(state)) out(line)
    out('=== 对局日志 ===')
  }

  for (const line of result.lines) out(line)

  out('')
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
