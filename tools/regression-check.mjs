// 确定性回归检查

// 解决两个不同的问题，别混为一谈：
//   ① **自洽性**：同一命令连跑两次，日志文件必须**逐字节一致**；
//   ② **回归**：与冻结的基准 hash 比 —— 同一条命令跑两次永远相等，**它抓不到"引擎改了行为"**，
//      只有基准 hash 变了才说明输出发生了漂移（可能是回退，也可能是有意的口径变更）。

// 用法（在仓库根执行）：
//   node tools/regression-check.mjs                 # 日常校验：自洽性 + 与基准比对
//   node tools/regression-check.mjs --update        # 冻结 / 更新基准（**口径有意变更后**才用）
//   node tools/regression-check.mjs --only=tutorial-deck-seed42
//   node tools/regression-check.mjs --help

// 三条实现约定（都是踩过的坑换来的）：
//   1. **不开管道**：子进程用 `stdio: ['ignore','ignore','inherit']`。本仓库的沙箱禁止管道
//      stdio（Node 的 child_process 默认 pipe 会 EPERM），而且我们本来也不需要 stdout
//      对局输出经 `simulator/run.ts --log <文件>` 落到 UTF-8 文件，hash 与比对都基于该文件的**字节**。
//   2. **不比 stdout**：`run.ts` 在写文件后还会打印一句「（全部输出已写入 <路径>，UTF-8）」，
//      路径里含临时目录名 ⇒ 两次运行的 stdout 必然不同，拿它做 hash 会**假红**。
//   3. **不写时间戳**：基准文件里没有日期，保证"同一份代码 → 同一份基准文件"（可 diff、可入库）。
//      需要区分版本时看 `packageVersion`（= `package.json` 的 version = `ENGINE_VERSION`）。

// 另外会打一段**跨 seed 日志体比对**（去掉「对局开始（seed = N）」头行后比）：它回答的是
// "这几个 seed 到底买到了什么覆盖" —— 若某阵容跨 seed 完全相同，说明它对种子不敏感，
// 多跑几个 seed 只覆盖了"与种子有关的打印行"，**随机分支（如 `random_enemy_card`）没有走到**。

// 本文件在 `tools/` 下：ESLint 已 `ignores: ['tools/**']`，且不在两份 tsconfig 的 include 里，
// 故它是纯宿主脚本，不受"可擦除语法子集"约束（与 `tools/check-config.mjs` 同待遇）。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const baselinePath = join(root, 'tools', 'regression-baseline.json')

/**
 * 回归场景清单。
 *
 * **判据只有一条：与冻结的基准 hash 比**（另外每个场景还要连跑两次、逐字节一致）。
 *
 * 这里**不再放"人工记录的期望值"**：曾经有一套 `expect` 子串断言，但它与基准**重复**，
 * 而且会在口径有意变更后**假红** —— 基准已重冻、那串人工写的却没人手改。实测踩过一次：
 * `tutorial-deck-seed42` 的 hash 与基准**完全一致**，却因为 `expect` 里写的是旧结果
 * 而报"疑似回退"。要人工看"这局打成什么样"，用下面打印的 `summary` 三行即可。
 *
 * ⚠️  `demo-deck.ts` 已删除 ⇒ 原来的 `demo-seed42` / `demo-seed7` 两个场景**作废**，
 *    改为跑 `packs/test` 的真实阵容（`decks/testA.yml` × `decks/testB.yml`）。
 *    首次更换场景后必须重跑 `npm run regression:update` 重冻基准。
 */
const SCENARIOS = [
  {
    id: 'test-deck-seed42',
    group: 'test-deck（packs/test + decks/testA·testB）',
    note: '内置测试包对局（= `npm run verify` 第六步）',
    args: [
      'simulator/run.ts',
      '--deckA',
      'decks/testA.yml',
      '--deckB',
      'decks/testB.yml',
      '--seed',
      '42',
    ],
  },
  {
    id: 'test-deck-seed7',
    group: 'test-deck（packs/test + decks/testA·testB）',
    note: '内置测试包对局 · 另一个种子（该阵容含 `random_enemy_card`，是真正的随机分支覆盖）',
    args: [
      'simulator/run.ts',
      '--deckA',
      'decks/testA.yml',
      '--deckB',
      'decks/testB.yml',
      '--seed',
      '7',
    ],
  },
  {
    id: 'tutorial-deck-seed42',
    group: 'tutorial-deck（教学包 + 阵容样例）',
    note: '接线路径（教学包 + 阵容样例）：读取 → 校验 → 装配 → 对局',
    args: [
      'simulator/run.ts',
      '--pack',
      'tutorial/templates/packs',
      '--deckA',
      'decks/example.yml',
      '--deckB',
      'decks/example.yml',
      '--seed',
      '42',
    ],
  },
  {
    id: 'tutorial-deck-seed1',
    group: 'tutorial-deck（教学包 + 阵容样例）',
    note: '接线路径 · 另一个种子',
    args: [
      'simulator/run.ts',
      '--pack',
      'tutorial/templates/packs',
      '--deckA',
      'decks/example.yml',
      '--deckB',
      'decks/example.yml',
      '--seed',
      '1',
    ],
  },
  {
    id: 'tutorial-deck-seed20261005',
    group: 'tutorial-deck（教学包 + 阵容样例）',
    note: '接线路径 · 大种子（覆盖多位数解析）',
    args: [
      'simulator/run.ts',
      '--pack',
      'tutorial/templates/packs',
      '--deckA',
      'decks/example.yml',
      '--deckB',
      'decks/example.yml',
      '--seed',
      '20261005',
    ],
  },
]

const HELP = `用法：node tools/regression-check.mjs [--update] [--only=<场景 id>] [--help]

  （无参数）        跑全部场景：每个场景连跑两次比字节，再与 tools/regression-baseline.json 比 hash；
                    末尾另打一段「跨 seed 日志体比对」（去掉 seed 头行后比，只作信息报告、不判成败）
  --update         重新冻结基准（会先做自洽性检查；不自洽则拒绝写）
  --only=<id>      只跑一个场景，id 取值见 --help 末尾的清单
  --help           显示本帮助

场景 id：${SCENARIOS.map((s) => s.id).join(' / ')}
`

/** 每个场景跑两次的目标文件名 */
const RUN_FILES = ['run1.out.txt', 'run2.out.txt']

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 按前缀取出一行（找不到返回 null）；日志里同一前缀只会出现一次 */
function pickLine(text, prefix) {
  for (const line of text.split('\n')) {
    if (line.startsWith(prefix)) return line
  }
  return null
}

/** 汇总三行结论（结果 / 用时 / 终局血量），供基准与人工核对 */
function summarize(text) {
  return {
    result: pickLine(text, '=== 结果：'),
    time: pickLine(text, '=== 用时：'),
    final: pickLine(text, '=== 终局血量：'),
  }
}

/**
 * 去掉「=== 对局开始（seed = N）===」头行。
 *
 * 跨 seed 比日志体时必须去掉它：`run.ts` 会把这行写进 `--log` 文件，而它**必然**因 seed 不同
 * 而不同 —— 不去掉的话"跨 seed 有差异"永远成立，等于没比。
 */
function stripSeedHeader(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('=== 对局开始（seed'))
    .join('\n')
}

/** 找出第一处不同（用于自洽性失败时报位置），返回 null = 完全相同 */
function firstDifference(left, right) {
  if (left === right) return null
  const a = left.split('\n')
  const b = right.split('\n')
  const limit = Math.max(a.length, b.length)
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      return {
        line: i + 1,
        left: a[i] === undefined ? '<无此行>' : a[i],
        right: b[i] === undefined ? '<无此行>' : b[i],
        leftLines: a.length,
        rightLines: b.length,
      }
    }
  }
  return { line: 0, left: '<行数相同但字节不同>', right: '', leftLines: a.length, rightLines: b.length }
}

/** 跑一次对局，返回 { ok, text, hash }（text = --log 文件的 UTF-8 内容） */
function runOnce(scenario, outFile) {
  const result = spawnSync(process.execPath, [...scenario.args, '--log', outFile], {
    cwd: root,
    // 不开管道：见文件头"实现约定 1"
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  if (result.error !== undefined) {
    return { ok: false, text: null, hash: null, reason: `起不来子进程：${result.error.message}` }
  }
  if (!existsSync(outFile)) {
    return { ok: false, text: null, hash: null, reason: `没有产出日志文件（退出码 ${result.status}）` }
  }
  const buffer = readFileSync(outFile)
  return { ok: true, text: buffer.toString('utf8'), hash: sha256(buffer), status: result.status }
}

/** 跑一个场景：两次运行 + 期望值检查；返回结果对象（不抛错） */
function checkScenario(scenario, dir) {
  const runs = []
  for (const name of RUN_FILES) {
    const outFile = join(dir, name)
    const run = runOnce(scenario, outFile)
    runs.push(run)
    if (!run.ok) return { scenario, failure: run.reason, runs }
  }

  const [first, second] = runs
  const diff = first.hash === second.hash ? null : firstDifference(first.text, second.text)
  const summary = summarize(first.text)

  return { scenario, runs, hash: first.hash, summary, diff }
}

function readBaseline() {
  if (!existsSync(baselinePath)) return null
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    return { broken: error instanceof Error ? error.message : String(error) }
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }

  let update = false
  let only
  const unknown = []
  for (const arg of argv) {
    if (arg === '--update') update = true
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length)
    else unknown.push(arg)
  }

  if (unknown.length > 0) {
    console.log(`无法识别的参数：${unknown.join(' ')}（--only 只支持 --only=<id> 写法）\n\n${HELP}`)
    process.exitCode = 1
    return
  }

  const selected = only === undefined ? SCENARIOS : SCENARIOS.filter((s) => s.id === only)
  if (selected.length === 0) {
    console.log(`没有匹配的场景 id：${String(only)}\n\n${HELP}`)
    process.exitCode = 1
    return
  }

  const baseline = readBaseline()
  if (baseline !== null && baseline.broken !== undefined) {
    console.log(`！基准文件读不了（${baseline.broken}）：${baselinePath}`)
    console.log('  请修好它，或删掉后重跑 --update 重新冻结。')
    process.exitCode = 1
    return
  }

  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const workDir = mkdtempSync(join(tmpdir(), 'bazaarsim-regression-'))
  const results = []
  let failed = false

  try {
    console.log(`=== 确定性回归（${String(selected.length)} 个场景 × 2 次运行）===`)
    console.log(`仓库根：${root}`)
    console.log(
      `基准：${baseline === null ? `无（${baselinePath}）` : `${baselinePath}${baseline.packageVersion === packageVersion ? '' : `　⚠️ 基准记录的 packageVersion=${String(baseline.packageVersion)}，当前=${packageVersion}`}`}`,
    )
    console.log('')

    for (const scenario of selected) {
      const dir = join(workDir, scenario.id)
      mkdirSync(dir, { recursive: true })
      const outcome = checkScenario(scenario, dir)
      results.push(outcome)

      console.log(`—— ${scenario.id}：${scenario.note}`)
      console.log(`   命令：node ${scenario.args.join(' ')}`)

      if (outcome.failure !== undefined) {
        console.log(`   🔴 跑不起来：${outcome.failure}`)
        failed = true
        console.log('')
        continue
      }

      if (outcome.diff !== null) {
        console.log('   🔴 同一命令两次运行**逐字节不一致**（确定性被破坏）')
        console.log(
          `      首个不同在第 ${String(outcome.diff.line)} 行（左 ${String(outcome.diff.leftLines)} 行 / 右 ${String(outcome.diff.rightLines)} 行）`,
        )
        console.log(`      第 1 次：${String(outcome.diff.left)}`)
        console.log(`      第 2 次：${String(outcome.diff.right)}`)
        failed = true
      } else {
        console.log(`   ✅ 自洽：两次运行字节一致（sha256 ${String(outcome.hash).slice(0, 16)}…）`)
      }

      const recorded = baseline?.scenarios?.[scenario.id]
      if (recorded === undefined) {
        console.log(
          update
            ? '   （本轮将写入新基准）'
            : '   ⚠️ 基准里没有这一条 —— 跑一次 --update 把它冻进去',
        )
      } else if (recorded.sha256 !== outcome.hash) {
        console.log('   🔴 与基准**不一致**（要么是回退，要么是有意的口径变更）')
        console.log(`      基准 ${String(recorded.sha256).slice(0, 16)}… / 实际 ${String(outcome.hash).slice(0, 16)}…`)
        const keys = ['result', 'time', 'final']
        for (const key of keys) {
          const before = recorded.summary?.[key]
          const after = outcome.summary[key]
          if (before !== after) {
            console.log(`      ${key} 基准：${String(before)}`)
            console.log(`      ${key} 实际：${String(after)}`)
          }
        }
        console.log('      确认是有意变更后跑 --update；否则请把这段输出贴回给 Agent。')
        if (JSON.stringify(recorded.args) !== JSON.stringify(outcome.scenario.args)) {
          console.log(`      （基准记录的命令行与本脚本不同：${JSON.stringify(recorded.args)}）`)
        }
        failed = true
      } else {
        console.log('   ✅ 与基准一致')
      }

      if (outcome.summary.result !== null) console.log(`   ${outcome.summary.result}`)
      if (outcome.summary.time !== null) console.log(`   ${outcome.summary.time}`)
      if (outcome.summary.final !== null) console.log(`   ${outcome.summary.final}`)

      console.log('')
    }

    // ——— 跨 seed 日志体比对（只作信息报告，不判成败） —
    // 目的：回答"多跑几个 seed 到底买到了什么覆盖"。若同一 group 的不同 seed 在**去掉 seed 头行**后
    // 逐字节相同 ⇒ 该阵容对种子不敏感（随机分支没走到），多 seed 只覆盖了"与种子有关的打印行"。
    const groups = new Map()
    for (const outcome of results) {
      if (outcome.failure !== undefined || outcome.scenario.group === undefined) continue
      const list = groups.get(outcome.scenario.group) ?? []
      list.push(outcome)
      groups.set(outcome.scenario.group, list)
    }
    const crossSeedLines = []
    for (const [group, list] of groups) {
      if (list.length < 2) continue
      const baselineText = stripSeedHeader(list[0].runs[0].text)
      const same = list.every((o) => stripSeedHeader(o.runs[0].text) === baselineText)
      crossSeedLines.push(
        same
          ? `   · ${group}：**去掉 seed 头行后完全相同** ⇒ 该阵容对种子不敏感，多 seed 没覆盖到随机分支`
          : `   · ${group}：有差异 ⇒ 种子确实进入了对局（随机分支已被覆盖）`,
      )
    }
    if (crossSeedLines.length > 0) {
      console.log('=== 跨 seed 日志体比对（去掉「对局开始（seed = N）」头行）===')
      for (const line of crossSeedLines) console.log(line)
      console.log('')
    }

    // ——— 冻结基准 —
    if (update) {
      const nonSelfConsistent = results.filter((r) => r.failure !== undefined || r.diff != null)
      if (nonSelfConsistent.length > 0) {
        console.log(
          `！拒绝写基准：${nonSelfConsistent.map((r) => r.scenario.id).join(' / ')} 连自洽都没过（先修确定性，再谈基准）`,
        )
        process.exitCode = 1
        return
      }
      // 只保留**当前 SCENARIOS 里仍有**的条目：`--update` 是"重置基准"、不是"合并旧文件"
      // （ 退役的 `demo-*` 两个场景就是这样残留在基准文件里的）。
      const known = new Set(SCENARIOS.map((scenario) => scenario.id))
      const scenarios = {}
      for (const [id, entry] of Object.entries(baseline?.scenarios ?? {})) {
        if (known.has(id)) scenarios[id] = entry
      }
      for (const outcome of results) {
        scenarios[outcome.scenario.id] = {
          args: outcome.scenario.args,
          sha256: outcome.hash,
          summary: outcome.summary,
        }
      }
      const payload = {
        note: '确定性回归基准 —— 由 `node tools/regression-check.mjs --update` 生成。口径有意变更后才能重跑 --update，并须在登记。',
        packageVersion,
        scenarios,
      }
      writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      console.log(`=== 基准已写入：${baselinePath}（${String(Object.keys(scenarios).length)} 条）===`)
      console.log('    若这是**首次**冻结：请把下面这行贴回给 Agent —— 它会登记进。')
      console.log(`    packageVersion=${packageVersion}`)
      process.exitCode = failed ? 1 : 0
      return
    }

    console.log(failed ? '=== 结论：有 ❌ / 🔴，见上 ===' : '=== 结论：全部通过 ===')
    process.exitCode = failed ? 1 : 0
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main()
