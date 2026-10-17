// 开发期卡牌数据中介（Vite dev middleware）—— 的 M2、

// 为什么需要它：`packs/` 是**工作区数据**（不是源码、也不在 client/ 里），浏览器没有文件系统，
// 前端**不得**把它当静态资源直接读。本中间件在 **Node 侧**跑现成的读取层
// `cards/loader.ts`，把 `LoadResult`（packs + errors）原样 JSON 出去 —— 于是校验错误带**真实行号**，
// 且"模组 → 重载"按钮只要再请求一次即可（`loadPacks` 无内部状态、可重复调用，本轮不接 fs.watch）。

// 三条路由（挂载在 `/api` 下）：
//   GET /api/packs                         → `loadPacks('packs')`
//   GET /api/packs/<packId>/images/<rest>  → 包内图片（卡图 / 技能图标 / **品阶卡框** / 头像）
//   GET /api/decks                         → `decks/` 下全部 `.yml`（**只读**：路径 + 文本）
//                                             = A「一键加载现成阵容」，**不写文件**

// 三个实现细节（都踩过）：
//   ① **用 `process.cwd()` 拼绝对路径再动态 import** —— 本文件会被 Vite 打包成临时文件后执行，
//      相对路径的解析基准不稳定；而 `npm run dev` 一定在仓库根跑。
//   ② **`loadPacks` 传相对路径 `'packs'`** —— 这样错误里的 `file` 字段是 `packs/test/cards/x.yml`
//      这种人读形式（传绝对路径会带上 `D:\...`），客户端状态栏直接显示它。
//   ③ **目录穿越防护** —— `resolve` 之后必须仍在该包的 `images/` 目录内。
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const PACKS_ROOT = 'packs'
const PACKS_DIR = join(ROOT, PACKS_ROOT)
const DECKS_DIR = join(ROOT, 'decks')

/** 只需认这几种（表现层资源一律 png 为主，svg 留给卡框矢量图） */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

/**
 * 读取层是 `.ts`（靠 Node 的类型擦除直跑）：按**绝对路径**动态 import 一次并缓存。
 * 不用静态 import：静态 import 会被 Vite 打进临时配置文件，路径基准反而不可控。
 */
let loaderPromise
function loadLoader() {
  loaderPromise ??= import(pathToFileURL(join(ROOT, 'cards', 'loader.ts')).href)
  return loaderPromise
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 把 `req.url` 切成段（去 query、逐段 decode） */
function segmentsOf(url) {
  const path = url.split('?')[0] ?? ''
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part))
}

/** 处理 `GET /api/packs/<packId>/images/<rest>`；找不到 / 越界都返回 JSON 错误（前端只在控制台看到） */
function serveImage(res, segments) {
  const [, packId, kind, ...rest] = segments
  if (packId === undefined || kind !== 'images' || rest.length === 0) return false

  const baseDir = resolve(PACKS_DIR, packId, 'images')
  const filePath = resolve(baseDir, ...rest)
  if (filePath !== baseDir && !filePath.startsWith(baseDir + sep)) {
    sendJson(res, 400, { message: '非法路径' })
    return true
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { message: `图片不存在：${packId}/${rest.join('/')}` })
    return true
  }

  const dot = filePath.lastIndexOf('.')
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
  res.setHeader('content-type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
  // 开发期不缓存：改完图刷新即见（与"数据靠重载按钮"同一取舍）
  res.setHeader('cache-control', 'no-cache')
  createReadStream(filePath).pipe(res)
  return true
}

/** 递归收集 `decks/` 下的 `.yml` / `.yaml`（`decks/` 允许二级目录） */
function collectDeckFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectDeckFiles(full, acc)
    else if (/\.ya?ml$/i.test(entry.name)) acc.push(full)
  }
  return acc
}

/**
 * 处理 `GET /api/decks`**只读**导入。
 *
 * 返回 `{ decks: [{ path, text }] }`：`path` 是**相对仓库根**的 POSIX 路径（UI 里显示、也给"加载哪个"用），
 * `text` 是原文（前端拿 `cards/deck.ts` 的 `parseDeckText` 解析 —— 校验口径与 CLI 完全同一份）。
 * 目录不存在 ⇒ 空表（不是错误：`decks/` 可以没有）。
 */
function serveDecks(res) {
  if (!existsSync(DECKS_DIR)) {
    sendJson(res, 200, { decks: [] })
    return true
  }
  try {
    const decks = collectDeckFiles(DECKS_DIR, [])
      .sort()
      .map((file) => ({
        path: relative(ROOT, file).replace(/\\/g, '/'),
        text: readFileSync(file, 'utf8'),
      }))
    sendJson(res, 200, { decks })
  } catch (error) {
    sendJson(res, 500, { message: error instanceof Error ? error.message : String(error) })
  }
  return true
}

export function packsApi() {
  return {
    name: 'bazaarsim:packs-api',
    apply: 'serve', // 只在 dev server 生效；构建期走 packs.manifest.json（tools/packs-manifest.mjs）
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        void (async () => {
          const segments = segmentsOf(req.url ?? '')

          // —— 阵容只读导入：/api/decks
          if (segments[0] === 'decks' && segments.length === 1) {
            serveDecks(res)
            return
          }

          if (segments[0] !== 'packs') {
            next()
            return
          }

          // —— 数据：/api/packs
          if (segments.length === 1) {
            try {
              const { loadPacks } = await loadLoader()
              sendJson(res, 200, loadPacks(PACKS_ROOT))
            } catch (error) {
              sendJson(res, 500, { message: error instanceof Error ? error.message : String(error) })
            }
            return
          }

          // —— 图片：/api/packs/<packId>/images/<rest>
          if (!serveImage(res, segments)) next()
        })()
      })
    },
  }
}
