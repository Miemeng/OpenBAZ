// 客户端外壳 —— 取数 / 注册 / 制表在这里；**宿主取数只在这里**（`runBattle` 在模拟模式的事件处理里）。

// 三条纪律：
//   ① **只有这里调用宿主取数 + 注册表**（`packSource.load()` 与 `registry.replaceAll()`）；
//      组件树其余部分只消费结果 —— 将来换宿主只改 `client/data/` 这一层；
//   ② 取数放 `useEffect` 是对的（它是"与外部世界同步"）；而 **`runBattle` 这类引擎调用只允许出现在
//      事件处理里** —— 两者别混为一谈；
//   ③ **加载失败与校验错误都不阻塞 UI**：`errors` 直接进状态栏清单；"失败不覆盖旧版本"
//      是读取层已保证的行为。

// 编辑态草稿放在**本组件**（不在 `SimulateBoard` 里）：切 tab 不该丢摆盘（草稿只活在内存里）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CardRegistry } from '../cards/registry.ts'
import type { LoadResult, ValidationError } from '../cards/types.ts'
import { ENGINE_VERSION } from '../engine/version.ts'
import { isDesktopHost, packSource } from './data/packSource.ts'
import { t } from './i18n/index.ts'
import { CardLibrary } from './modes/simulate/CardLibrary.tsx'
import { SimulateMode } from './modes/simulate/SimulateMode.tsx'
import { buildRows } from './state/cardLibrary.ts'
import { EMPTY_DRAFT, type SimulateDraft } from './state/simulateDraft.ts'

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly result: LoadResult }
  | { readonly status: 'failed'; readonly message: string }

type Tab = 'library' | 'board'

/** 一条校验问题的单行文本（与 CLI 的 `formatIssue` 同口径：级别 / 码 / 文件:行 / 文案） */
function issueText(issue: ValidationError): string {
  const where =
    issue.file === undefined ? '' : `${issue.file}${issue.line === undefined ? '' : `:${String(issue.line)}`}`
  const severity = issue.severity ?? 'error'
  return `[${severity}] ${issue.code}${where === '' ? '' : `  ${where}`}  ${issue.message}`
}

export function App() {
  const registry = useMemo(() => new CardRegistry(), [])
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [tab, setTab] = useState<Tab>('library')
  const [draft, setDraft] = useState<SimulateDraft>(EMPTY_DRAFT)

  // "模组 → 重载"按钮的落点：`loadPacks` 无内部状态、可重复调用（本轮不接 fs.watch）
  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      const result = await packSource.load()
      registry.replaceAll(result.packs)
      setState({ status: 'ready', result })
    } catch (error) {
      setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [registry])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => (state.status === 'ready' ? buildRows(state.result.packs) : []), [state])
  const errors = state.status === 'ready' ? state.result.errors : []

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="./logo-mark.svg" alt="" width={26} height={37} />
          <div>
            <h1>{t('app.title')}</h1>
            <p className="subtitle">{t('app.subtitle', { version: ENGINE_VERSION })}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="tabs">
            <button
              type="button"
              className={tab === 'library' ? 'tab tab-on' : 'tab'}
              onClick={() => {
                setTab('library')
              }}
            >
              {t('app.tabLibrary')}
            </button>
            <button
              type="button"
              className={tab === 'board' ? 'tab tab-on' : 'tab'}
              onClick={() => {
                setTab('board')
              }}
            >
              {t('app.tabBoard')}
            </button>
          </nav>
          <button
            type="button"
            className="reload"
            onClick={() => {
              void load()
            }}
            disabled={state.status === 'loading'}
          >
            {state.status === 'loading' ? t('app.reloading') : t('app.reload')}
          </button>
        </div>
      </header>

      {state.status === 'ready' && (
        <p className="summary">
          {t('app.summary', {
            packs: state.result.packs.length,
            cards: rows.length,
            skills: state.result.packs.reduce((sum, pack) => sum + pack.skills.length, 0),
            issues: errors.length,
          })}
        </p>
      )}

      {errors.length > 0 && (
        <ul className="issues">
          {errors.map((issue, index) => (
            <li key={`${issue.code}-${String(index)}`}>{issueText(issue)}</li>
          ))}
        </ul>
      )}

      {/* 桌面版首次启动只有 `packs/base`（它没有卡）⇒ 空列表时明确告诉玩家把包放哪儿 */}
      {state.status === 'ready' && isDesktopHost && rows.length === 0 && (
        <p className="hint no-cards">{t('app.noCards', { path: '%APPDATA%\\OpenBaz\\packs' })}</p>
      )}

      {state.status === 'loading' && <p className="hint">{t('app.loadingHint')}</p>}
      {state.status === 'failed' && (
        <p className="failure">{t('app.loadError', { detail: state.message })}</p>
      )}

      {state.status === 'ready' && tab === 'library' && (
        <CardLibrary registry={registry} rows={rows} packs={state.result.packs} />
      )}
      {state.status === 'ready' && tab === 'board' && (
        <SimulateMode draft={draft} onChange={setDraft} packs={state.result.packs} registry={registry} />
      )}

      <footer className="footer">
        当前可用：卡牌库取数 · 摆盘（选卡 → 点格子）· <code>runBattle()</code> 同步结算 ·
        逐帧回放（播放 / 步进 / 跳转 / 倍速 + 血量 / 护盾 / 持续效果 / 行动条 / 飘字 / 触发高亮）。
        种子留空则用 <code>crypto.getRandomValues</code> 生成一次并回显。
      </footer>
    </div>
  )
}
