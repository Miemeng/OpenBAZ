// 模拟模式 · 摆盘容器 —— 本文件是摆盘的"大脑"：
//   · 拥有**手持状态**（先选一张卡 → 再点格子放下）；`BoardRow` / `PlayerPanel` 都是纯表现层；
//   · 落点 = 被点的那一格（`BoardRow` 把格号回传上来），不做 rect 数学、不跟随指针；
//   · 合法性判定 = 把"候选摆盘"交给引擎的 `validatePlacements()` 看是否零错误（**不自己算占格**）；
//   · 草稿本身在 `App` 里（切 tab 不丢），本组件只发 updater。

// ⚠️ S4 起"开始对局"**已接线**：本组件只负责"校验 + 定种子 + 回显"，然后把**装配好的双方阵容**
//    交给 `SimulateMode` 的 `onStart()` —— **跑对局与结果归属都在外壳里**（三态机在 SimulateMode）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ResolvedDeck } from '../../../cards/deck.ts'
import { validatePlacements, type Placement } from '../../../engine/board.ts'
import type { CardRegistry } from '../../../cards/registry.ts'
import type { LoadedPack, ValidationError } from '../../../cards/types.ts'
import type { Card } from '../../../engine/types.ts'
import { buildAssetIndex } from '../../data/assets.ts'
import { packSource, type DeckText } from '../../data/packSource.ts'
import { buildRows } from '../../state/cardLibrary.ts'
import { t } from '../../i18n/index.ts'
import {
  addPlacement,
  draftFromDeckText,
  removePlacementAt,
  toggleSkill,
  validateSideDraft,
  withHero,
  withHpText,
  withPlacementEnchant,
  withPlacementStat,
  sideToDeckDto,
  type SideDraft,
  type SimulateDraft,
} from '../../state/simulateDraft.ts'
import { deckToYaml, nextDeckFileName } from '../../state/deckYaml.ts'
import { newSeed, parseSeedText } from '../../state/simulateRun.ts'
import { BoardRow, type BoardPreview } from './BoardRow.tsx'
import { EditPanel } from './EditPanel.tsx'
import { PlayerPanel } from './PlayerPanel.tsx'

type SideKey = 'A' | 'B'

/** 当前**手持**的卡：从左侧列表选的（还没有位置），或从棋盘上选中要挪位的已放置卡 */
interface HeldCard {
  readonly cardId: string
  /** 来自棋盘上的第几处（`undefined` = 从左侧列表选的） */
  readonly fromIndex?: number | undefined
  readonly fromSide?: SideKey | undefined
}

/** 鼠标压在哪一格（只为预览，不写进草稿） */
interface HoverSlot {
  readonly side: SideKey
  readonly slot: number
}

/** 交给外壳去跑的一局：**双方已装配阵容** + 本局种子（本组件不组装 `BattleOptions`） */
export interface RunRequest {
  readonly seed: number
  readonly sideA: ResolvedDeck
  readonly sideB: ResolvedDeck
}

interface SimulateBoardProps {
  readonly draft: SimulateDraft
  readonly onChange: (updater: (draft: SimulateDraft) => SimulateDraft) => void
  readonly packs: readonly LoadedPack[]
  readonly registry: CardRegistry
  /** 已经跑过至少一局（只影响按钮文案：开始对局 / 重新对局） */
  readonly hasRun: boolean
  /** 校验通过时往上抛一局（**跑对局的唯一入口在外壳的 `onStart` 里**） */
  readonly onStart: (request: RunRequest) => void
}

/** 草稿里的两侧按键取值 / 写回（纯函数，避免在组件里散落三元表达式） */
function sideOf(draft: SimulateDraft, key: SideKey): SideDraft {
  return key === 'A' ? draft.sideA : draft.sideB
}

function withSide(draft: SimulateDraft, key: SideKey, side: SideDraft): SimulateDraft {
  return key === 'A' ? { ...draft, sideA: side } : { ...draft, sideB: side }
}

export function SimulateBoard({ draft, onChange, packs, registry, hasRun, onStart }: SimulateBoardProps) {
  const [held, setHeld] = useState<HeldCard | null>(null)
  /** 正在编辑的那一处摆盘（`null` = 未选卡 ⇒ 编辑栏空态） */
  const [editing, setEditing] = useState<{ side: SideKey; index: number } | null>(null)
  /** 编辑栏展开 / 收起：收起后只剩 32px 栏头，把 228px 还给卡牌栏 */
  const [editOpen, setEditOpen] = useState(true)
  const [hover, setHover] = useState<HoverSlot | null>(null)
  /** 放不下时的一句话说明（没选卡就点格子 / 越界 / 重叠） */
  const [placeNote, setPlaceNote] = useState<string | null>(null)
  /** 开跑前的说明（种子不合法 / 阵容没装配出来）；结果本身归外壳（`SimulateMode`） */
  const [runError, setRunError] = useState<string | null>(null)

  /** 卡图 URL 表（摆盘棋盘上给每张已放置的卡画底图；缺图不画） */
  const assets = useMemo(() => buildAssetIndex(packs), [packs])
  const cardArtUrlOf = useCallback((cardId: string): string | null => assets.cardArt(cardId), [assets])
  const [query, setQuery] = useState('')
  const [decks, setDecks] = useState<readonly DeckText[]>([])
  const [deckError, setDeckError] = useState<string | null>(null)
  const [importIssues, setImportIssues] = useState<readonly ValidationError[]>([])

  // 只读导入的清单：DEV 走中间件真读盘、PROD 走 `decks.json`
  useEffect(() => {
    let alive = true
    packSource
      .loadDecks()
      .then((list) => {
        if (alive) setDecks(list)
      })
      .catch((error: unknown) => {
        if (alive) setDeckError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [])

  const validationA = useMemo(() => validateSideDraft(draft.sideA, registry, 1), [draft.sideA, registry])
  const validationB = useMemo(() => validateSideDraft(draft.sideB, registry, 2), [draft.sideB, registry])

  const sourceRows = useMemo(() => buildRows(packs), [packs])
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (text === '') return sourceRows
    return sourceRows.filter((row) => `${row.card.id} ${row.card.name}`.toLowerCase().includes(text))
  }, [sourceRows, query])

  const cardOf = (cardId: string): Card | undefined => registry.get(cardId)

  /** 有几何错误的卡下标（引擎只给 `cardId`，同名卡多张时按"该 id 的第一处"归属，够用） */
  const errorIndexes = (key: SideKey): ReadonlySet<number> => {
    const validation = key === 'A' ? validationA : validationB
    const side = sideOf(draft, key)
    const indexes = new Set<number>()
    for (const boardError of validation.boardErrors) {
      if (boardError.cardId === undefined) continue
      const at = side.placements.findIndex((placement) => placement.cardId === boardError.cardId)
      if (at >= 0) indexes.add(at)
    }
    return indexes
  }

  /**
   * 把"某张卡放在某一格"的**候选摆盘**交给引擎判合法性。
   *
   * 同方挪位要先把来源那处拿掉（否则会与自己重叠而误判非法）—— 前端**不算占格、不判重叠**，
   * 只负责拼候选。
   */
  function judge(active: HeldCard, side: SideKey, slot: number): BoardPreview | undefined {
    const card = cardOf(active.cardId)
    if (card === undefined) return undefined
    const candidate: Placement[] = []
    sideOf(draft, side).placements.forEach((placement, index) => {
      if (side === active.fromSide && index === active.fromIndex) return
      const found = cardOf(placement.cardId)
      if (found !== undefined) candidate.push({ card: found, slot: placement.slot })
    })
    candidate.push({ card, slot })
    return {
      side,
      slot,
      cardId: active.cardId,
      ok: validatePlacements(side === 'A' ? 1 : 2, candidate).length === 0,
    }
  }

  /* ---------------- 手持 → 点格子 ---------------- */

  /** 悬停预览：手持某张卡时，鼠标压在哪一格就预览"放那里合不合法"（只为好看，不写状态） */
  const preview = held === null || hover === null ? undefined : judge(held, hover.side, hover.slot)

  /** 点左侧列表里的卡：选中它；再点同一张 = 收回手持 */
  function pickSource(cardId: string): void {
    setPlaceNote(null)
    setHeld((current) =>
      current !== null && current.fromIndex === undefined && current.cardId === cardId ? null : { cardId },
    )
  }

  /** 点棋盘上已有的卡：选中它准备挪位；再点同一张 = 收回手持 */
  function pickPlaced(side: SideKey, index: number): void {
    const placement = sideOf(draft, side).placements[index]
    if (placement === undefined) return
    setPlaceNote(null)
    setHeld((current) =>
      current !== null && current.fromSide === side && current.fromIndex === index
        ? null
        : { cardId: placement.cardId, fromIndex: index, fromSide: side },
    )
  }

  /** 点某一格：手持着卡就试着放下；放不下只给一句说明，**不改草稿** */
  function clickSlot(side: SideKey, slot: number): void {
    if (held === null) {
      setPlaceNote('先从左边点一张卡（或点棋盘上已有的卡挪位），再点格子')
      return
    }
    const target = judge(held, side, slot)
    if (target === undefined) return
    if (!target.ok) {
      setPlaceNote('这一格放不下：会超出本行 10 格，或与已有的卡重叠')
      return
    }
    commitPlacement(held, target)
    setHeld(null)
    setHover(null)
    setPlaceNote(null)
  }

  /** 落子（一次 updater 里同时处理"同方挪位"与"跨方搬运"两种来源） */
  function commitPlacement(active: HeldCard, target: BoardPreview): void {
    onChange((current) => {
      const targetSide = sideOf(current, target.side)
      // ⚠️ 挪位 / 跨方搬运走的是"先删后加" ⇒ **附魔要显式带过去**（它挂在"这一处摆盘"上，不挂格号）
      const source =
        active.fromSide === undefined || active.fromIndex === undefined
          ? undefined
          : sideOf(current, active.fromSide).placements[active.fromIndex]
      const keep = source?.enchant
      // ⚠️ 挪位 / 跨方搬运是"先删后加" ⇒ **覆盖数值也要显式带过去**（它挂在"这一处摆盘"上，不挂格号）
      const keepStats = source?.stats
      const sameSide = active.fromSide === target.side && active.fromIndex !== undefined
      if (sameSide) {
        const without = removePlacementAt(targetSide, active.fromIndex ?? 0)
        return withSide(current, target.side, addPlacement(without, active.cardId, target.slot, keep, keepStats))
      }
      let next = current
      if (active.fromSide !== undefined && active.fromIndex !== undefined) {
        next = withSide(next, active.fromSide, removePlacementAt(sideOf(next, active.fromSide), active.fromIndex))
      }
      return withSide(next, target.side, addPlacement(sideOf(next, target.side), active.cardId, target.slot, keep, keepStats))
    })
  }

  /* ---------------- 只读导入 ---------------- */

  function importDeck(deck: DeckText, key: SideKey): void {
    const parsed = draftFromDeckText(deck.text, deck.path, registry)
    setImportIssues(parsed.errors)
    const imported = parsed.side
    if (imported === undefined) return
    onChange((current) => withSide(current, key, imported))
  }

  /* ---------------- 保存 / 导出 ---------------- */

  /**
   * 保存本侧阵容：
   * - **桌面宿主**（`window.host` 存在）⇒ 写进 `userData/decks/<名字>.yml`，并把文件加进清单；
   * - **浏览器** ⇒ 下载 YAML + 复制到剪贴板（没有写盘能力）。
   */
  function saveDeck(key: SideKey): void {
    const built = sideToDeckDto(sideOf(draft, key))
    if (!('dto' in built)) {
      setImportIssues(built.errors)
      return
    }
    const fileName = nextDeckFileName(key, decks.map((deck) => deck.path))
    const text = deckToYaml({ ...built.dto, name: fileName.replace(/\.ya?ml$/u, '') }, fileName)
    setImportIssues([])

    if (packSource.saveDeck !== undefined) {
      void packSource
        .saveDeck(fileName, text)
        .then((saved) => {
          setDecks((current) => [{ path: saved.path, text }, ...current.filter((deck) => deck.path !== saved.path)])
          setDeckError(null)
        })
        .catch((error: unknown) => {
          setDeckError(error instanceof Error ? error.message : String(error))
        })
      return
    }

    // ① 下载：`<a download>` + Blob（不依赖任何宿主能力）
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)

    // ② 复制：剪贴板可能不可用（非安全上下文 / 用户拒绝）⇒ 失败不算错
    void navigator.clipboard?.writeText(text).catch(() => undefined)

    // ③ 进清单（标记为本会话的"本地"文件；`path` 带 `decks/` 前缀以便和真文件同形）
    setDecks((current) => [{ path: `decks/${fileName}`, text }, ...current])
  }

  /* ---------------- 开始对局（交给外壳去跑） ---------------- */

  /**
   * 开跑前的三件事：校验装配结果 → 定种子（空则生成并**回显进输入框**）→ 把双方阵容往上抛。
   *
   * 三条纪律：① 本组件**不调引擎**（`runBattle` 只在 `SimulateMode` 的事件处理里）；
   * ② 摆盘 / 技能 / 血量一律用 `cards/deck.ts` 装配好的 `resolved`，前端不自己攒；
   * ③ 种子一旦生成就写回草稿 ⇒ 用户看得见用的哪个种子，也就能重跑出同一场。
   */
  function startBattle(): void {
    const resolvedA = validationA.resolved
    const resolvedB = validationB.resolved
    if (resolvedA === undefined || resolvedB === undefined) {
      setRunError('双方阵容还没装配成功：先修掉上面的错误')
      return
    }
    const parsed = parseSeedText(draft.seed)
    if (parsed.error !== undefined) {
      setRunError(parsed.error)
      return
    }
    const seed = parsed.seed ?? newSeed()
    if (parsed.seed === undefined) {
      onChange((current) => ({ ...current, seed: String(seed) }))
    }
    setRunError(null)
    onStart({ seed, sideA: resolvedA, sideB: resolvedB })
  }

  const ready =
    validationA.errors.length === 0 &&
    validationB.errors.length === 0 &&
    validationA.boardErrors.length === 0 &&
    validationB.boardErrors.length === 0 &&
    draft.sideA.placements.length > 0 &&
    draft.sideB.placements.length > 0

  /** 编辑栏当前看着的那一处摆盘（未选卡 / 该处已被移除 ⇒ `undefined` = 空态） */
  const editingPlacement =
    editing === null ? undefined : sideOf(draft, editing.side).placements[editing.index]
  const editingCard = editingPlacement === undefined ? undefined : cardOf(editingPlacement.cardId)

  /** 附魔**即时生效**：直接写回草稿里那一处摆盘（不碰引擎、不重算任何规则） */
  function pickEnchant(enchantId: string | undefined): void {
    if (editing === null) return
    const { side: key, index: at } = editing
    onChange((current) => {
      return withSide(current, key, withPlacementEnchant(sideOf(current, key), at, enchantId))
    })
  }

  /** 覆盖数值同样**即时生效**（`undefined` = 撤掉这一项，回到卡面值） */
  function pickStat(stat: string, value: number | undefined): void {
    if (editing === null) return
    const { side: key, index: at } = editing
    onChange((current) => {
      return withSide(current, key, withPlacementStat(sideOf(current, key), at, stat, value))
    })
  }

  return (
    <section
      className="simulate"
      onClick={(event) => {
        // 点**空白区域**才取消"正在编辑的那一处"（RW 口径）：
        //   · 场上格子 / 场上的卡 ⇒ 属于"摆盘 / 挪位"流程，**不**清空；
        //   · 编辑栏自身（`.ep`）⇒ 是在里面操作，**不**清空；
        //   · 卡牌列表项自己会清（它要开始"手持一张卡"），这里不重复处理也不误伤。
        const target = event.target instanceof Element ? event.target : null
        if (target === null) return
        if (target.closest('[data-board-slot]') !== null) return
        if (target.closest('.ep') !== null) return
        setEditing(null)
      }}
    >
      <div className="sim-left">
        <aside className="source">
          <input
            className="search"
            type="search"
            placeholder="搜索卡名 / id"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          <p className="hint">
            {held === null || held.fromIndex !== undefined
              ? '点一张卡选中它，再点棋盘上的格子放下（同名卡可以放多张）'
              : `手持「${cardOf(held.cardId)?.name ?? held.cardId}」—— 点格子放下，再点它一次取消`}
          </p>
          <ul className="source-list">
            {filtered.map((row) => {
              const armed = held !== null && held.fromIndex === undefined && held.cardId === row.card.id
              return (
                <li key={row.card.id}>
                  <button
                    type="button"
                    className={armed ? 'source-item source-item-on' : 'source-item'}
                    onClick={() => {
                      pickSource(row.card.id)
                      // 点卡牌列表 = 开始"手持一张卡去放" ⇒ 编辑栏回空态（RW 口径）
                      setEditing(null)
                    }}
                  >
                    <i className="bar" style={{ background: row.rarity.color }} />
                    <span className="source-name">{row.card.name}</span>
                    <span className="source-meta">
                      {row.rarity.name}
                      {row.card.stats.atk === undefined ? '' : ` · atk ${String(row.card.stats.atk)}`}
                    </span>
                  </button>
                </li>
              )
            })}
            {filtered.length === 0 && <li className="empty">没有匹配的卡</li>}
          </ul>
        </aside>

        {/* 编辑栏（§AF = A）：左栏竖分两段的**下半段** —— 固定 260px，栏头可收成 32px 标题条 */}
        <EditPanel
          card={editingCard}
          current={editingPlacement?.enchant}
          stats={editingCard?.stats}
          overrides={editingPlacement?.stats}
          onStat={pickStat}
          open={editOpen}
          onToggle={() => {
            setEditOpen((was) => !was)
          }}
          onPick={pickEnchant}
        />
      </div>

      {/* `data-held` 只给样式用：手持一张卡时格子换成"可放下"的光标（F4 交互一致性） */}
      <div className="board-area" data-held={held !== null ? 'true' : 'false'}>
        <div className="import-row">
          <span className="facet-label">{t('board.deckFiles')}</span>
          <span className="hint">{t('board.deckFilesHint')}</span>
          {deckError !== null && <span className="issue-error">{t('board.deckListError', { detail: deckError })}</span>}
        </div>

        {importIssues.length > 0 && (
          <ul className="issues">
            {importIssues.map((issue, index) => (
              <li key={`imp-${String(index)}`}>{issue.message}</li>
            ))}
          </ul>
        )}

        <PlayerPanel
          side="A"
          name="A"
          draft={draft.sideA}
          packs={packs}
          registry={registry}
          validation={validationA}
          onHero={(heroId) => {
            onChange((current) => ({ ...current, sideA: withHero(current.sideA, heroId) }))
          }}
          onHp={(hpText, maxHpText) => {
            onChange((current) => ({ ...current, sideA: withHpText(current.sideA, hpText, maxHpText) }))
          }}
          onToggleSkill={(skillId) => {
            onChange((current) => ({ ...current, sideA: toggleSkill(current.sideA, skillId) }))
          }}
          deckFiles={decks}
          onImport={(deck) => {
            importDeck(deck, 'A')
          }}
          onSave={() => {
            saveDeck('A')
          }}
        />
        <BoardRow
          side="A"
          placements={draft.sideA.placements}
          cardOf={cardOf}
          cardArtUrlOf={cardArtUrlOf}
          preview={preview}
          errorIndexes={errorIndexes('A')}
          armedIndex={held !== null && held.fromSide === 'A' ? (held.fromIndex ?? null) : null}
          onSlotClick={(slot) => {
            clickSlot('A', slot)
          }}
          onSlotHover={(slot) => {
            setHover(slot === null ? null : { side: 'A', slot })
          }}
          onCardClick={(index) => {
            pickPlaced('A', index)
            setEditing({ side: 'A', index })
            // 点棋盘上的卡 = 要编辑它 ⇒ 编辑栏自动展开（§AF.6 = A）
            setEditOpen(true)
          }}
          onRemove={(index) => {
            onChange((current) => ({ ...current, sideA: removePlacementAt(current.sideA, index) }))
          }}
        />

        <PlayerPanel
          side="B"
          name="B"
          draft={draft.sideB}
          packs={packs}
          registry={registry}
          validation={validationB}
          onHero={(heroId) => {
            onChange((current) => ({ ...current, sideB: withHero(current.sideB, heroId) }))
          }}
          onHp={(hpText, maxHpText) => {
            onChange((current) => ({ ...current, sideB: withHpText(current.sideB, hpText, maxHpText) }))
          }}
          onToggleSkill={(skillId) => {
            onChange((current) => ({ ...current, sideB: toggleSkill(current.sideB, skillId) }))
          }}
          deckFiles={decks}
          onImport={(deck) => {
            importDeck(deck, 'B')
          }}
          onSave={() => {
            saveDeck('B')
          }}
        />
        <BoardRow
          side="B"
          placements={draft.sideB.placements}
          cardOf={cardOf}
          cardArtUrlOf={cardArtUrlOf}
          preview={preview}
          errorIndexes={errorIndexes('B')}
          armedIndex={held !== null && held.fromSide === 'B' ? (held.fromIndex ?? null) : null}
          onSlotClick={(slot) => {
            clickSlot('B', slot)
          }}
          onSlotHover={(slot) => {
            setHover(slot === null ? null : { side: 'B', slot })
          }}
          onCardClick={(index) => {
            pickPlaced('B', index)
            setEditing({ side: 'B', index })
            // 点棋盘上的卡 = 要编辑它 ⇒ 编辑栏自动展开（§AF.6 = A）
            setEditOpen(true)
          }}
          onRemove={(index) => {
            onChange((current) => ({ ...current, sideB: removePlacementAt(current.sideB, index) }))
          }}
        />

        <div className="run-row">
          <label>
            种子
            <input
              className="seed-input"
              placeholder="留空 = 开始对局时自动生成"
              value={draft.seed}
              onChange={(event) => {
                const seed = event.target.value
                onChange((current) => ({ ...current, seed }))
              }}
            />
          </label>
          <button
            type="button"
            className="run-button"
            disabled={!ready}
            onClick={startBattle}
            title={ready ? '按当前摆盘跑一局（同步结算，毫秒级）' : '双方都摆好卡、选好角色之后才能开跑'}
          >
            {hasRun ? '重新对局' : '开始对局'}
          </button>
          {placeNote !== null && <span className="place-note">{placeNote}</span>}
          {runError !== null && <span className="issue-error">{runError}</span>}
          {!ready && <span className="hint">还差：{readyHint(validationA.errors.length, validationB.errors.length, draft)}</span>}
        </div>
      </div>
    </section>
  )
}

function readyHint(errorsA: number, errorsB: number, draft: SimulateDraft): string {
  const missing: string[] = []
  if (draft.sideA.heroId === null) missing.push('A 方角色')
  if (draft.sideB.heroId === null) missing.push('B 方角色')
  if (draft.sideA.placements.length === 0) missing.push('A 方至少一张卡')
  if (draft.sideB.placements.length === 0) missing.push('B 方至少一张卡')
  if (errorsA + errorsB > 0) missing.push('修掉上面的错误')
  return missing.length === 0 ? '摆盘有几何冲突（红框）' : missing.join(' / ')
}
