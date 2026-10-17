// 卡包数据校验 CLI（`npm run sim:validate`）—— YAML 读取层的宿主入口

// 用法：
//   node simulator/validate.ts                    # 校验仓库根 packs/ 下的全部卡包
//   node simulator/validate.ts --root tutorial/templates/packs
//   node simulator/validate.ts --summary          # 额外打印注册表的加载回显
//   node simulator/validate.ts --quiet            # 只打印问题条目，不打印每个卡包一行
//   node simulator/validate.ts --json             # 机器可读（整个 LoadResult）
//   node simulator/validate.ts --help

// 退出码：只要有一条 `severity = 'error'` 的问题 ⇒ **1**；否则 0（`warn` / `note` 不算失败）。
// 与对局的关系：`sim:run` 将来在开跑前调用同一入口，见 error 即中止对局（本轮 `run.ts` 仍用
// `simulator/demo-deck.ts` 的硬编码数据，接线是下一步）。

// 本文件是**宿主层**：允许碰 Node API / console（engine/ 才禁止）。
import { loadPacks, PACKS_ROOT } from '../cards/loader.ts'
import { CardRegistry } from '../cards/registry.ts'
import type { LoadedPack, ValidationError } from '../cards/types.ts'
import type { LogLevel } from '../engine/types.ts'

/** 命令行参数（手写解析：最小可跑版不引入依赖） */
interface CliOptions {
  /** 数据根（含若干 `<pack_id>/` 子目录） */
  readonly root: string
  readonly quiet: boolean
  readonly json: boolean
  readonly summary: boolean
  readonly help: boolean
}

const USAGE = [
  '用法：node simulator/validate.ts [--root <目录>] [--summary] [--quiet] [--json] [--help]',
  '',
  `  --root <目录>   数据根，缺省 ${PACKS_ROOT}/`,
  '  --summary       额外打印注册表加载回显（每个已注册卡牌 / 技能的条目）',
  '  --quiet         只打印问题条目，不打印卡包清单',
  '  --json          以 JSON 打印整个 LoadResult（含全部定义）',
  '  --help          打印本说明',
].join('\n')

function parseArgs(argv: readonly string[]): CliOptions {
  let root = PACKS_ROOT
  let quiet = false
  let json = false
  let summary = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--quiet' || arg === '-q') {
      quiet = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--summary') {
      summary = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--root') {
      const raw = argv[i + 1]
      if (raw === undefined) throw new Error('--root 后面缺少目录路径')
      root = raw
      i += 1
    } else if (arg !== undefined && arg.startsWith('--root=')) {
      root = arg.slice('--root='.length)
    } else if (arg !== undefined && arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}（用 --help 看用法）`)
    } else if (arg !== undefined) {
      throw new Error(`多余的位置参数：${arg}（用 --root 指定数据根）`)
    }
  }
  return { root, quiet, json, summary, help }
}

// `ValidationError.severity` 复用引擎 `LogLevel` 五档：读取层实际只用
// error / warn / note 三档，但类型上必须把 info / debug 也当合法值处理，否则收窄会编译不过。
const SEVERITY_RANK: Record<LogLevel, number> = { error: 0, warn: 1, note: 2, info: 3, debug: 4 }

function severityOf(issue: ValidationError): LogLevel {
  return issue.severity ?? 'error'
}

function isFatal(issue: ValidationError): boolean {
  return severityOf(issue) === 'error'
}

function sortIssues(issues: readonly ValidationError[]): readonly ValidationError[] {
  return [...issues].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[severityOf(left)] - SEVERITY_RANK[severityOf(right)]
    if (bySeverity !== 0) return bySeverity
    const byFile = (left.file ?? '').localeCompare(right.file ?? '')
    if (byFile !== 0) return byFile
    const byLine = (left.line ?? 0) - (right.line ?? 0)
    if (byLine !== 0) return byLine
    return (left.column ?? 0) - (right.column ?? 0)
  })
}

const SEVERITY_MARK: Record<LogLevel, string> = {
  error: '错误',
  warn: '警告',
  note: '提示',
  info: '信息',
  debug: '调试',
}

function formatIssue(issue: ValidationError): string {
  const severity = severityOf(issue)
  const file = issue.file ?? '(未知文件)'
  const location =
    issue.line === undefined ? file : `${file}:${String(issue.line)}:${String(issue.column ?? 1)}`
  const path = issue.path === undefined ? '' : `  ${issue.path}`
  const lines = [`[${SEVERITY_MARK[severity]}] ${issue.code}  ${location}${path}`, `    ${issue.message}`]
  if (issue.suggestion !== undefined) lines.push(`    建议：${issue.suggestion}`)
  return lines.join('\n')
}

function describePack(pack: LoadedPack): string {
  const builtin = pack.builtin ? '（内置）' : ''
  return `${pack.packId} v${String(pack.version)}${builtin}  卡牌 ${String(pack.cards.length)} / 技能 ${String(pack.skills.length)} / 英雄 ${String(pack.heroes.length)}`
}

function printSummary(result: { readonly packs: readonly LoadedPack[] }): void {
  const registry = new CardRegistry()
  registry.replaceAll(result.packs)
  const { cards, skills } = registry.getAll()
  for (const card of cards) {
    const latest = registry.get(card.id)
    if (latest !== card) continue // 同一 id 的旧版本不重复回显
    for (const line of registry.summary(card.id)) console.log(line)
  }
  for (const skill of skills) {
    const latest = registry.getSkill(skill.id)
    if (latest !== skill) continue
    for (const line of registry.summary(skill.id)) console.log(line)
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }

  const result = loadPacks(options.root)

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.errors.some(isFatal) ? 1 : 0
    return
  }

  console.log(`=== 数据根：${options.root} ===`)
  if (!options.quiet) {
    if (result.packs.length === 0) {
      console.log('（没有加载到任何卡包）')
    } else {
      for (const pack of result.packs) console.log(`✅ ${describePack(pack)}`)
    }
    console.log('')
  }

  const issues = sortIssues(result.errors)
  if (issues.length > 0) {
    console.log(`=== 问题 ${String(issues.length)} 条 ===`)
    for (const issue of issues) console.log(formatIssue(issue))
    console.log('')
  }

  if (options.summary) {
    console.log('=== 加载回显 ===')
    printSummary(result)
    console.log('')
  }

  const errors = issues.filter(isFatal).length
  const warns = issues.filter((issue) => severityOf(issue) === 'warn').length
  const notes = issues.filter((issue) => severityOf(issue) === 'note').length
  console.log(
    `=== 校验结果：卡包 ${String(result.packs.length)} 个，错误 ${String(errors)} / 警告 ${String(warns)} / 提示 ${String(notes)} ===`,
  )
  if (errors > 0) console.log('（有错误：退出码 1，调用方应中止对局）')

  process.exitCode = errors > 0 ? 1 : 0
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`校验失败：${message}`)
  process.exitCode = 1
}
