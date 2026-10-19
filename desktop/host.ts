// 桌面宿主（Electron）的数据层：读包 / 读阵容 / 存阵容三件事的**纯函数**。
//
// 为什么单独一层：`cards/loader.ts` 是 TS（zod + js-yaml），而主进程按 AI.3 用**纯 JS** 写
// ⇒ 这一层由 Vite 打成 CJS（`npm run desktop:host` → `desktop/dist/host.cjs`），主进程 `require` 产物。
// 纪律：这里**不碰 Electron API**（只吃路径、吐数据），便于单测与将来换宿主。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { loadPacks } from '../cards/loader.ts'
import type { LoadResult } from '../cards/types.ts'

/** 阵容文件的形状（与渲染层 `client/data/packSource.ts` 的 `DeckText` 同形） */
export interface DeckText {
  /** 固定写成 `decks/<文件名>`：渲染层按这个前缀剥掉后显示 */
  readonly path: string
  readonly text: string
}

/**
 * 读一个数据根下的全部内容包。
 *
 * @param root `userData/packs`（或 `OPENBAZ_DATA_DIR` 指定的目录）
 * @returns `LoadResult` —— 读取层**从不抛异常**，坏文件只进 `errors`
 */
export async function loadPacksAt(root: string): Promise<LoadResult> {
  return loadPacks(root)
}

/**
 * 列出目录下的阵容文件（`.yml` / `.yaml`，按文件名排序）。
 *
 * @param dir `userData/decks`
 * @returns 每个文件一条；目录不存在 ⇒ 空数组（首次启动还没存过阵容）
 */
export async function listDecksAt(dir: string): Promise<readonly DeckText[]> {
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files = names.filter((name) => /\.ya?ml$/u.test(name)).sort()
  const out: DeckText[] = []
  for (const name of files) {
    out.push({ path: `decks/${name}`, text: await readFile(join(dir, name), 'utf8') })
  }
  return out
}

/**
 * 把一份阵容 YAML 写进目录（同名覆盖）。
 *
 * @param dir `userData/decks`
 * @param name 文件名（渲染层给的 `A_01.yml` 形式）；**只取 basename**，拒绝路径分隔符与非法字符
 * @param text 完整 YAML 原文
 * @returns 写成功后的相对路径（`decks/<文件名>`）
 * @throws 文件名不合法时抛错（由主进程转成 IPC 拒绝）
 */
export async function saveDeckAt(dir: string, name: string, text: string): Promise<{ readonly path: string }> {
  const safe = basename(name)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/u.test(safe)) {
    throw new Error(`非法的阵容文件名：${name}`)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, safe), text, 'utf8')
  return { path: `decks/${safe}` }
}
