// 桌面宿主主进程（Electron）。
//
// 按《审阅》§AI 的拍板：
//   AI.1 = A Electron · AI.3 = A 主进程写**纯 JS**（不赌 Electron 内置 Node 的类型擦除）
//   AI.4 = A 数据目录 = `userData`（首次启动把内置 `packs/base` 拷过去）
//   AI.5 = A Windows only；打包只带 `packs/base`（测试包不打包）
//
// 三件事：① 起窗口（dev 读 dist，或 `OPENBAZ_DEV_URL` 指到 vite dev server）；
//        ② IPC：`packs:load` / `decks:list` / `decks:save`（真正的活在 `desktop/dist/host.cjs`）；
//        ③ `app://` 协议给包内图片（C3 的落点，带目录穿越防护）。
'use strict'

const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { listDecksAt, loadPacksAt, saveDeckAt } = require('./dist/host.cjs')

/** 可选：把渲染层指到 Vite dev server（默认读 `dist/index.html`，即"先 build 再起壳"） */
const DEV_URL = process.env.OPENBAZ_DEV_URL

// 数据目录固定为 `%APPDATA%\OpenBaz`：开发期 `electron .` 读到的 package.json `name` 是
// 小写 `openbaz`，不显式指定的话开发版与安装版会落在两个不同目录（教程与界面提示都按
// `%APPDATA%\OpenBaz\packs` 写，必须统一）。`OPENBAZ_DATA_DIR` 仍可整体覆盖。
const userDataDir = path.join(app.getPath('appData'), 'OpenBaz')
fs.mkdirSync(userDataDir, { recursive: true })
app.setPath('userData', userDataDir)

/**
 * 数据目录（AI.4）：`userData` 下的 `packs/` 与 `decks/`。
 * `OPENBAZ_DATA_DIR` 可整体覆盖（开发期想用独立目录时用）。
 */
function dataRoots() {
  const base = process.env.OPENBAZ_DATA_DIR || app.getPath('userData')
  return { base, packs: path.join(base, 'packs'), decks: path.join(base, 'decks') }
}

/**
 * 首次启动准备：建目录 + 把内置包拷进 `userData/packs/<name>`。
 * - 默认只种 **`base`**（AI.5：测试包不随安装包分发）；
 * - `OPENBAZ_SEED_TEST=1` 时**连 `test` 一起种** —— 内测期想看满卡组时用，不影响正式分发。
 * 已存在就不动（**不覆盖玩家改过的包**）。
 */
async function seedData() {
  const roots = dataRoots()
  await fsp.mkdir(roots.packs, { recursive: true })
  await fsp.mkdir(roots.decks, { recursive: true })
  // 内置包来源：开发期 = 仓库根；打包后 = `resources/packs`（extraResources，放在 asar 外面，
  // 因为 `fs.cp` 对 asar 内的虚拟文件不可靠）
  const bundledRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'packs')
    : path.join(app.getAppPath(), 'packs')
  const seeds = process.env.OPENBAZ_SEED_TEST === '1' ? ['base', 'test'] : ['base']
  for (const name of seeds) {
    const target = path.join(roots.packs, name)
    const source = path.join(bundledRoot, name)
    if (fs.existsSync(target) || !fs.existsSync(source)) continue
    await fsp.cp(source, target, { recursive: true })
  }
}

/** 只允许 `app://packs/...` 映射到 `userData/packs` 里面（防目录穿越） */
function packsFileOf(url) {
  const parsed = new URL(url)
  if (parsed.host !== 'packs') return null
  const roots = dataRoots()
  const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/u, '')
  const target = path.normalize(path.join(roots.packs, rel))
  const fence = path.normalize(roots.packs + path.sep)
  return target.startsWith(fence) ? target : null
}

/** 按扩展名给个 content-type（图片就够用；缺省 `application/octet-stream`） */
function contentTypeOf(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#14161a',
    title: 'OpenBaz',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (DEV_URL) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }
  return win
}

// `app://` 必须是 standard scheme，`<img src>` 才认；`stream` 让大图也能直接走
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

app.whenReady().then(async () => {
  await seedData()

  protocol.handle('app', async (request) => {
    const file = packsFileOf(request.url)
    if (file === null) return new Response('forbidden', { status: 403 })
    try {
      const data = await fsp.readFile(file)
      return new Response(data, { headers: { 'content-type': contentTypeOf(file) } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  ipcMain.handle('packs:load', async () => loadPacksAt(dataRoots().packs))
  ipcMain.handle('decks:list', async () => listDecksAt(dataRoots().decks))
  ipcMain.handle('decks:save', async (_event, name, text) => {
    if (typeof name !== 'string' || typeof text !== 'string') throw new Error('decks:save 参数不合法')
    return saveDeckAt(dataRoots().decks, name, text)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
