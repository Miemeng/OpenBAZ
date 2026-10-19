// 文档「版本头」清理：把每份文档开头的 `> 版本：v…` 长段落**原样归档**，原位只留一行指针。
//
// 背景（《待办.md》§七「🧹 待清理」）：
//   多数设计文档开头堆着十几到几十条 `> 版本：vX.Y（…）` 长段落，每条形如一篇小作文；
//   而每份文档底部本来就有 `## 变更记录` 表格（同一份历史的紧凑版）⇒ 版本头是它的长段副本。
//   本脚本把这段**原样**搬进 `docs/待办归档/<文档名>.<当前版本>.md`，文件头只留：
//     ① 当前版本 + "版本头已归档"指针；② 沿革指针。
//   正文、§变更记录、以及**当前版本那一条的内容摘要**都不改（当前版本号沿用原值 ⇒ `H.5` 补注口径）。
//
// 只读依赖：node:fs / node:path；不联网、不装包。
// 用法：
//   node tools/doc-history-clean.mjs --dry     # 只报告，不写盘（先跑这个）
//   node tools/doc-history-clean.mjs           # 真跑：先写归档、再改文档
//
// 安全边界：
//   · 只在**文件前 40 行内**找 `> 版本：` 连续块；找不到 ⇒ 跳过（幂等，重复跑无副作用）；
//   · 块里只有 1 条 ⇒ 视为"已清过"跳过；
//   · 归档先写成功再改文档；任何异常直接抛出，不半途改文件。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const DOCS_DIR = join(ROOT, 'docs')
const ARCHIVE_DIR = join(DOCS_DIR, '待办归档')
const TODAY = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD（本机时区）

/** 这些不参与（过程文件 / 已清过 / 非文档） */
const SKIP_DIRS = new Set(['待办归档', '草图'])
const SKIP_FILES = new Set(['待办.md', '审阅.md'])

// 两种写法都认：`> 版本：v0.46（…` 与 `> 版本：**v0.10** —— …`
const VERSION_RE = /^>\s*版本：[\s*]*v?(\d+\.\d+)/

/** 递归收集 docs 下所有 markdown（跳过过程文件与归档目录） */
function collect(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...collect(full))
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    if (SKIP_FILES.has(entry.name)) continue
    found.push(full)
  }
  return found.sort()
}

/** 仓库相对路径（POSIX 分隔符，便于写进 markdown） */
function rel(absPath) {
  return relative(ROOT, absPath).split(sep).join('/')
}

/**
 * 找出文件前 40 行内的 `> 版本：` 连续块。
 * @returns {{ start: number, end: number, version: string, lines: string[] } | null} `end` 为**开区间**
 */
function findVersionBlock(lines) {
  const limit = Math.min(lines.length, 40)
  let start = -1
  for (let index = 0; index < limit; index += 1) {
    if (VERSION_RE.test(lines[index] ?? '')) {
      start = index
      break
    }
  }
  if (start < 0) return null

  let end = start
  while (end < lines.length && VERSION_RE.test(lines[end] ?? '')) end += 1

  const version = VERSION_RE.exec(lines[start] ?? '')?.[1]
  if (version === undefined) return null
  return { start, end, version, lines: lines.slice(start, end) }
}

function cleanDoc(absPath, dry) {
  const docRel = rel(absPath)
  const text = readFileSync(absPath, 'utf8')
  // 保住原换行风格（CRLF / LF 混用的仓库里很容易被脚本改成混合换行）
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(eol)
  const block = findVersionBlock(lines)
  if (block === null) return { docRel, status: 'skip', detail: '前 40 行内没有 `> 版本：`' }
  if (block.lines.length <= 1) return { docRel, status: 'skip', detail: '只有 1 条版本头（已清过）' }

  const name = basename(absPath, '.md')
  const archiveAbs = join(ARCHIVE_DIR, `${name}.${block.version}.md`)
  const archiveRel = rel(archiveAbs)
  // 链接方向：文档 → 归档（`../待办归档/x.md` 或 `待办归档/x.md`）；归档 → 文档（反向）
  const linkToArchive = relative(dirname(absPath), archiveAbs).split(sep).join('/')
  const linkToDoc = relative(ARCHIVE_DIR, absPath).split(sep).join('/')

  const archiveText = [
    `# ${name} 归档 · 版本头（v${block.version} 及更早，原文）`,
    '',
    `> 归档于 ${TODAY}，由 [${docRel}](${linkToDoc}) 的**整理轮**移出 —— **原样保留，未删改一字**。`,
    '> 用途：该文档的文件头只留"当前版本 + 本指针"；完整历史另见其 `## 变更记录` 表格。',
    '',
    '---',
    '',
    ...block.lines,
    '',
  ].join('\n')

  const pointer = [
    `> 版本：v${block.version}（${TODAY} 整理轮：版本头已归档）—— 开头原有的 **${String(block.lines.length)} 条** \`> 版本：…\` 长段落**原样**移入 [${basename(archiveAbs)}](${linkToArchive})；正文与 §变更记录 **一字未动**。此后本文件头只留这一行，每轮改动只往 §变更记录 加一行。`,
    `> 沿革：更早的版本头 = [${basename(archiveAbs)}](${linkToArchive}) · 完整历史 = 本文 §变更记录`,
  ]

  if (dry) {
    return {
      docRel,
      status: 'plan',
      detail: `${String(block.lines.length)} 条 → ${archiveRel}`,
      archiveRel,
      pointer,
    }
  }

  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true })
  writeFileSync(archiveAbs, archiveText, 'utf8')
  const next = [...lines.slice(0, block.start), ...pointer, ...lines.slice(block.end)]
  writeFileSync(absPath, next.join(eol), 'utf8')
  return {
    docRel,
    status: 'done',
    detail: `${String(block.lines.length)} 条 → ${archiveRel}`,
    archiveRel,
    pointer,
  }
}

const dry = process.argv.includes('--dry')
const docs = collect(DOCS_DIR)
const results = []
for (const absPath of docs) {
  if (!statSync(absPath).isFile()) continue
  results.push(cleanDoc(absPath, dry))
}

const changed = results.filter((item) => item.status !== 'skip')
console.log(`=== 文档版本头清理（${dry ? 'DRY RUN，不写盘' : '实际写入'}）===`)
console.log(`扫描 ${String(results.length)} 份文档，待处理 ${String(changed.length)} 份`)
for (const item of results) {
  const mark = item.status === 'skip' ? '  -' : dry ? '  ?' : '  ✓'
  console.log(`${mark} ${item.docRel}：${item.detail}`)
}
if (dry && changed.length > 0) {
  console.log('')
  console.log('—— 预览：每个文件头将被替换成下面两行 ——')
  for (const item of changed) {
    console.log('')
    console.log(`# ${item.docRel}`)
    for (const line of item.pointer ?? []) console.log(line)
  }
}
if (!dry) console.log(`\n完成：归档 ${String(changed.length)} 份 → docs/待办归档/`)
