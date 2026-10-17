// 构建期卡牌清单 + 图片拷贝

// 产物落 **`client/public/`**（Vite 的 publicDir）：dev 静态服务与 `vite build` 都直接可用
// ⇒ 不必再引任何拷贝插件。
//   ① `client/public/packs.manifest.json`      —— `LoadResult`（packs + errors）原样序列化
//   ② `client/public/packs/<packId>/images/**` —— 各包 `images/` 整目录拷贝（**先清后拷**，
//      避免留下已删卡包 / 已删图片的残件）
//   ③ `client/public/decks.json`               —— `decks/` 下全部 `.yml` 的路径 + 原文
//      （ = A"只读导入阵容"：DEV 走 `tools/packs-api.mjs` 的 `/api/decks`，PROD 读这个文件）

// 失败口径：只要有 `error` 级问题 ⇒ 打印清单 + **退出码 1**。
// 它被挂成 `prebuild:web`（`npm run build:web` 之前由 npm 自动跑）⇒ **数据有问题就构建失败**，
// 把数据错误挡在发布之前。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const PACKS_ROOT = 'packs'
const PUBLIC_DIR = join(ROOT, 'client', 'public')
const OUT_PACKS_DIR = join(PUBLIC_DIR, 'packs')
const MANIFEST_PATH = join(PUBLIC_DIR, 'packs.manifest.json')
const DECKS_DIR = join(ROOT, 'decks')
const DECKS_JSON_PATH = join(PUBLIC_DIR, 'decks.json')

// 读取层是 `.ts`（Node 类型擦除直跑）：按绝对路径动态 import（理由同 tools/packs-api.mjs ①）
const { loadPacks } = await import(pathToFileURL(join(ROOT, 'cards', 'loader.ts')).href)
// 相对路径 ⇒ 错误里的 file 字段是人读形式（`packs/test/cards/x.yml`）
const result = loadPacks(PACKS_ROOT)

const fatal = result.errors.filter((issue) => (issue.severity ?? 'error') === 'error')

// —— 写产物
rmSync(OUT_PACKS_DIR, { recursive: true, force: true })
mkdirSync(PUBLIC_DIR, { recursive: true })
writeFileSync(MANIFEST_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

let copiedPacks = 0
for (const pack of result.packs) {
  const from = join(ROOT, PACKS_ROOT, pack.packId, 'images')
  if (!existsSync(from)) continue
  cpSync(from, join(OUT_PACKS_DIR, pack.packId, 'images'), { recursive: true })
  copiedPacks += 1
}

// —— 阵容清单
// 递归收集（`decks/` 允许二级目录）；目录不存在 ⇒ 空表（不是错误）
function collectDeckFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectDeckFiles(full, acc)
    else if (/\.ya?ml$/i.test(entry.name)) acc.push(full)
  }
  return acc
}

const deckFiles = existsSync(DECKS_DIR) ? collectDeckFiles(DECKS_DIR, []).sort() : []
const decks = deckFiles.map((file) => ({
  path: relative(ROOT, file).replace(/\\/g, '/'),
  text: readFileSync(file, 'utf8'),
}))
writeFileSync(DECKS_JSON_PATH, `${JSON.stringify({ decks }, null, 2)}\n`, 'utf8')

// —— 回显（照着 CLI 的口径，便于人眼核对）
console.log(`=== 卡牌清单已生成：${MANIFEST_PATH} ===`)
for (const pack of result.packs) {
  const kinds = pack.builtin ? '内置' : '玩家'
  console.log(
    `  卡包 ${pack.packId}（${pack.name}）v${pack.version} · ${kinds} · 卡牌 ${pack.cards.length} / 技能 ${pack.skills.length} / 英雄 ${pack.heroes.length}`,
  )
}
console.log(`  图片目录已拷贝：${copiedPacks} 个包 → client/public/packs/<packId>/images/`)
console.log(`  阵容清单已生成：${DECKS_JSON_PATH}（${decks.length} 份：${decks.map((deck) => deck.path).join(' / ')}）`)
if (result.errors.length > 0) {
  console.log(`  校验问题 ${result.errors.length} 条：`)
  for (const issue of result.errors) {
    const where = issue.file === undefined ? '' : `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}  `
    console.log(`    [${issue.severity ?? 'error'}] ${issue.code}  ${where}${issue.message}`)
  }
}

if (fatal.length > 0) {
  console.error(`构建中止：数据有 ${fatal.length} 条 error 级问题（清单已写出，供查错用）`)
  process.exit(1)
}
