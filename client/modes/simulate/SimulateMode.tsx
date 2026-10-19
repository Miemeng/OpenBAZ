// 模拟模式**三态外壳**（EDIT / RUN / REPLAY）：状态机 + 回放时钟都在这里。

// 三条纪律：
//   · **跑对局的唯一入口**是本文件的 `startBattle()`（事件处理里）—— 其余组件不得 import `runBattle`；
//   · 回放**只消费**跑那一局时的产物 + 阵容快照（`RunRecord` 就是一份 `ReplayInput`），
//     之后改草稿不影响回放，回放也**不二次调引擎**；
//   · 回放时钟 = `requestAnimationFrame` 推进帧游标，游标逻辑全是纯函数（`state/replay.ts`），
//     本文件只负责"喂真实毫秒"与"派发用户动作"。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ResolvedDeck } from '../../../cards/deck.ts'
import type { CardRegistry } from '../../../cards/registry.ts'
import type { LoadedPack } from '../../../cards/types.ts'
import { formatAction } from '../../../engine/log.ts'
import { MAX_TIME_SECONDS } from '../../../engine/state.ts'
import { runBattle } from '../../../engine/tick.ts'
import type { BattleOptions, Card, FrameCard, FrameSnapshot, PlayerId } from '../../../engine/types.ts'
import { CardDetail } from '../../components/CardDetail.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import {
  DETAIL_WINDOW_HEIGHT,
  DETAIL_WINDOW_WIDTH,
  buildCardDetail,
  placeDetail,
  type CardDetailView,
  type Size,
} from '../../state/cardDetail.ts'
import { CardDetailContext, type CardDetailApi } from '../../state/cardDetailContext.ts'
import { arrowToTri } from '../../state/effectLine.ts'
import { t } from '../../i18n/index.ts'
import {
  advanceReplay,
  frameFraction,
  gaugeViewOf,
  replayStart,
  seekReplay,
  setPlayingReplay,
  setSpeedReplay,
  stepReplay,
  type ReplayInput,
  type ReplaySpeed,
} from '../../state/replay.ts'
import type { SimulateDraft } from '../../state/simulateDraft.ts'
import { buildBattleOptions } from '../../state/simulateRun.ts'
import { buildAssetIndex } from '../../data/assets.ts'
import { collectRarities, rarityOf } from '../../theme/rarity.ts'
import { BattleView, type BattleSideLook } from './BattleView.tsx'
import { ReplayBar } from './ReplayBar.tsx'
import { RunResult, type RunPlayer } from './RunResult.tsx'
import { SimulateBoard, type RunRequest } from './SimulateBoard.tsx'

type Phase = 'edit' | 'result' | 'replay'

/** 一局的**不可变**记录：回放只读它（`ReplayInput` + 本局引擎入参，便于"同 seed 重跑"） */
export interface RunRecord extends ReplayInput {
  readonly options: BattleOptions
}

/** 没有帧快照时的稳定空数组（避免每次渲染换引用） */
const EMPTY_FRAMES: readonly FrameSnapshot[] = []

/**
 * 悬停延迟：权威《[卡面表现设计.md](../../../docs/设计/卡面表现设计.md)》§4.1 = **移入即显（无刻意延迟）** ⇒ `0`。
 * （《[审阅.md](../../../docs/审阅.md)》§W 的当期记录写的是"≈300ms" —— 以权威文档为准；要改只动这一个数。）
 */
const HOVER_DELAY_MS = 0

/** 窗口尺寸：宽固定 360px；高是**估算值**（实际高度自适应，贴边翻转与夹取都用它） */
const WINDOW_SIZE: Size = { width: DETAIL_WINDOW_WIDTH, height: DETAIL_WINDOW_HEIGHT }

/** 视口尺寸（只在浏览器侧读） */
function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 当前显示的悬浮窗：**未钉住**时只存"目标 + 位置"，视图每帧重算（§4.1 战斗中实时刷新）；
 *  **钉住**时用 `frozen` 冻结钉住那一刻的视图（§W.3）。 */
interface DetailTarget {
  readonly card: Card
  /** 回放态 = 该卡的实例键（用于按当前帧刷新）；编辑态 = `null` */
  readonly instanceId: string | null
  readonly left: number
  readonly top: number
  readonly pinned: boolean
  readonly frozen: CardDetailView | null
  /** 编辑态的当前附魔 id（回放态为空 —— 那种情况由 `FrameCard.enchant` 给） */
  readonly enchantId?: string
}

interface SimulateModeProps {
  readonly draft: SimulateDraft
  readonly onChange: (updater: (draft: SimulateDraft) => SimulateDraft) => void
  readonly packs: readonly LoadedPack[]
  readonly registry: CardRegistry
}

export function SimulateMode({ draft, onChange, packs, registry }: SimulateModeProps) {
  const [phase, setPhase] = useState<Phase>('edit')
  const [run, setRun] = useState<RunRecord | null>(null)
  const [replay, setReplay] = useState(() => replayStart())

  const frames = run === null ? EMPTY_FRAMES : run.outcome.frames
  const total = frames.length

  /** 品阶显示口径表（颜色 / 名称 / 卡框 id）—— 卡面与悬浮窗都用它 */
  const rarityTable = useMemo(() => collectRarities(packs), [packs])

  /* ---------------- 悬浮细节窗（卡面 §4；触发方式 §W = 悬停即显 + 单击钉住） ---------------- */

  const [detail, setDetail] = useState<DetailTarget | null>(null)
  /** 钉住状态存 ref：`detailApi` 是 memo 的，读不到最新的 `detail` */
  const pinnedRef = useRef(false)
  const hoverTimer = useRef<number | null>(null)

  /** 回放态：按 `instanceId` 取**当前帧**的那张卡（悬停未钉住时窗口要随帧刷新，§4.1） */
  const currentFrameCard = useCallback(
    (instanceId: string | null): FrameCard | undefined => {
      if (instanceId === null) return undefined
      return frames[replay.index]?.cards.find((card) => card.instanceId === instanceId)
    },
    [frames, replay.index],
  )

  /** 组装视图：**四区口径全在 `state/cardDetail.ts`**，这里只负责取数据（品阶名 / 归属 / 效果回显） */
  const detailViewOf = useCallback(
    (card: Card, frame: FrameCard | undefined, enchantId?: string): CardDetailView => {
      const look = rarityOf(rarityTable, card.rarity)
      const ownerId = card.owner
      const ownerLabel =
        ownerId === undefined
          ? null
          : ownerId === 'common'
            ? '通用'
            : (registry.getHero(ownerId)?.name ?? ownerId)
      return buildCardDetail({
        card,
        frame,
        // 编辑态没有帧快照 ⇒ 附魔 id 由调用方（`BoardRow` 的悬停）带过来
        ...(enchantId === undefined ? {} : { enchantId }),
        // 回放态沿用 `replay.ts` 的口径（冰冻向前借周期）；编辑态交给数据层让引擎算基础周期
        gauge: frame === undefined ? undefined : gaugeViewOf(frames, replay.index, frame),
        effectLines: registry.summary(card.id),
        // 结构化行 ⇒ 效果区按 `kind` 分组，不再靠中文前缀（AG.6 = A）
        effects: registry.summaryLines(card.id),
        rarityName: look.name,
        rarityColor: look.color,
        ownerLabel,
      })
    },
    [rarityTable, registry, frames, replay.index],
  )

  const detailApi = useMemo<CardDetailApi>(
    () => ({
      enter(card, frame, pointer, enchantId) {
        if (pinnedRef.current) return // 已钉住 ⇒ 内容冻结（§W.3），悬停不改
        if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
        hoverTimer.current = window.setTimeout(() => {
          hoverTimer.current = null
          setDetail({
            card,
            instanceId: frame === undefined ? null : frame.instanceId,
            ...(enchantId === undefined ? {} : { enchantId }),
            ...placeDetail(pointer, viewportSize(), WINDOW_SIZE),
            pinned: false,
            frozen: null,
          })
        }, HOVER_DELAY_MS)
      },
      leave() {
        if (hoverTimer.current !== null) {
          window.clearTimeout(hoverTimer.current)
          hoverTimer.current = null
        }
        if (pinnedRef.current) return
        setDetail(null)
      },
      togglePin(card, frame, pointer, enchantId) {
        if (pinnedRef.current) {
          pinnedRef.current = false
          setDetail(null)
          return
        }
        pinnedRef.current = true
        setDetail({
          card,
          instanceId: frame === undefined ? null : frame.instanceId,
          ...placeDetail(pointer, viewportSize(), WINDOW_SIZE),
          pinned: true,
          // **钉住即冻结**：内容取钉住那一刻的帧（§W.3），之后回放继续走也不刷新
          frozen: detailViewOf(card, frame, enchantId),
        })
      },
    }),
    [detailViewOf],
  )

  // 钉住时点窗口外关闭。用 `click`（冒泡）+ 卡面 `stopPropagation` ⇒ 不会"关掉又立刻钉住"
  useEffect(() => {
    if (detail === null || !detail.pinned) return undefined
    const onDocumentClick = (event: globalThis.MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.cd') !== null) return
      pinnedRef.current = false
      setDetail(null)
    }
    document.addEventListener('click', onDocumentClick)
    return () => {
      document.removeEventListener('click', onDocumentClick)
    }
  }, [detail])

  const detailNode =
    detail === null ? null : (
      <CardDetail
        view={detail.frozen ?? detailViewOf(detail.card, currentFrameCard(detail.instanceId), detail.enchantId)}
        left={detail.left}
        top={detail.top}
        pinned={detail.pinned}
      />
    )

  /* ---------------- 跑一局（EDIT）→ 战斗界面（REPLAY） ---------------- */

  /**
   * 开始对局：组装 `BattleOptions` → `runBattle()`（同步，毫秒级）→ **直接进战斗界面**（自动开播）。
   *
   * 三条纪律：① **引擎调用只在这里**（事件处理里）；② 种子由 `SimulateBoard` 定好并回显；
   * ③ `captureFrames: true` 是必须的：帧快照是回放的唯一画面数据源。
   */
  const startBattle = useCallback((request: RunRequest): void => {
    const sides: Readonly<Record<PlayerId, ResolvedDeck>> = { 1: request.sideA, 2: request.sideB }
    const options = buildBattleOptions({
      seed: request.seed,
      sideA: request.sideA,
      sideB: request.sideB,
      captureFrames: true,
    })
    const outcome = runBattle(options)
    setRun({ outcome, seed: request.seed, sides, options })
    // 开战即进战斗界面：从第 0 帧自动开播（RW 指示「点开战就应该进战斗界面」）
    setReplay(setPlayingReplay(replayStart(), true, outcome.frames.length))
    setPhase('replay')
  }, [])

  /* ---------------- 回放时钟（rAF） ---------------- */

  useEffect(() => {
    if (phase !== 'replay' || !replay.playing) return undefined
    let handle = 0
    let previous = -1
    const pump = (now: number): void => {
      // 第一拍只记起点（`now - previous` 无意义）；往后每拍的真实毫秒差交给纯逻辑折成帧步长
      const elapsedMs = previous < 0 ? 0 : now - previous
      previous = now
      setReplay((state) => advanceReplay(state, elapsedMs, total))
      handle = requestAnimationFrame(pump)
    }
    handle = requestAnimationFrame(pump)
    return () => {
      cancelAnimationFrame(handle)
    }
  }, [phase, replay.playing, total])

  /* ---------------- 回放操作 ---------------- */

  const openReplay = useCallback((): void => {
    setReplay((state) => setPlayingReplay(replayStart(state.speed), true, total))
    setPhase('replay')
  }, [total])

  /** 战斗界面左上角的「← 回到摆盘」：直接回编辑态（本局产物留着，方便再点一次「查看结算」） */
  const backToEdit = useCallback((): void => {
    setPhase('edit')
  }, [])

  /** 控制条上的「查看结算」：回结算面板（编辑态 + 终局读数） */
  const showResult = useCallback((): void => {
    setPhase('result')
  }, [])

  const togglePlay = useCallback((): void => {
    setReplay((state) => setPlayingReplay(state, !state.playing, total))
  }, [total])

  const stepBy = useCallback(
    (delta: number): void => {
      setReplay((state) => stepReplay(state, delta, total))
    },
    [total],
  )

  const seekTo = useCallback(
    (index: number): void => {
      setReplay((state) => seekReplay(state, index, total))
    },
    [total],
  )

  const pickSpeed = useCallback((speed: ReplaySpeed): void => {
    setReplay((state) => setSpeedReplay(state, speed))
  }, [])

  /** 键盘：空格 = 播放 / 暂停，← → = 逐帧（Shift 加速 ×10），Home / End = 首 / 末帧（输入框 / 下拉里不抢键） */
  useEffect(() => {
    if (phase !== 'replay') return undefined
    const onKey = (event: KeyboardEvent): void => {
      const tag = event.target instanceof HTMLElement ? event.target.tagName : ''
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (event.key === ' ') {
        event.preventDefault()
        togglePlay()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        stepBy(event.shiftKey ? -10 : -1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        stepBy(event.shiftKey ? 10 : 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        seekTo(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        seekTo(total - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, togglePlay, stepBy, seekTo, total])

  /* ---------------- 表现层要的派生数据 ---------------- */

  /** 资源 URL 表（卡图 / 头像；**只拼路径**，有没有图由 `<img>` 的 onError 决定） */
  const assets = useMemo(() => buildAssetIndex(packs), [packs])

  /** 卡面定义表：`<归属方>-<起始格号>` → 卡（**同一方内起始格号必不重复**，故是可靠键） */
  const cardLook = useMemo(() => {
    const map = new Map<string, Card>()
    if (run === null) return map
    for (const side of [1, 2] as const) {
      for (const placement of run.sides[side].placements) {
        map.set(`${String(side)}-${String(placement.slot)}`, placement.card)
      }
    }
    return map
  }, [run])

  const cardOf = useCallback(
    (owner: PlayerId, slot: number): Card | undefined => cardLook.get(`${String(owner)}-${String(slot)}`),
    [cardLook],
  )

  const rarityColorOf = useCallback((card: Card): string => rarityOf(rarityTable, card.rarity).color, [rarityTable])

  const cardArtUrlOf = useCallback((card: Card): string | null => assets.cardArt(card.id), [assets])

  /** 技能图标（`images/skills/<skill_id>.png`；缺图回落技能名首字） */
  const skillIconUrlOf = useCallback((skillId: string): string | null => assets.skillIcon(skillId), [assets])

  /** 卡框材质（**最上层**）：品阶 `frame` → `images/frames/<frame>/card_frame.png`；没写 `frame` ⇒ 没有图 */
  const frameUrlOf = useCallback(
    (card: Card): string | null => {
      const look = rarityOf(rarityTable, card.rarity)
      return look.frame === undefined ? null : assets.rarityFrame(look.frame, look.packId)
    },
    [rarityTable, assets],
  )

  const sideLooks = useMemo((): Readonly<Record<PlayerId, BattleSideLook>> | null => {
    if (run === null) return null
    const build = (side: PlayerId): BattleSideLook => {
      const deck = run.sides[side]
      const hero = registry.getHero(deck.heroId)
      return {
        // 玩家名取引擎产物（`FramePlayer` 不带名字；`buildBattleOptions` 固定为 `玩家A` / `玩家B`）
        name: run.outcome.state.players[side].name,
        heroName: hero === undefined ? deck.heroId : hero.name,
        avatarUrl: assets.heroAvatar(deck.heroId),
        skills: deck.skills,
      }
    }
    return { 1: build(1), 2: build(2) }
  }, [run, registry, assets])

  /** 结算面板的视图数据（把引擎产物摊平成表现层读得懂的字段） */
  const summary = useMemo(() => {
    if (run === null) return null
    const { state, victory, lines, frames: frameList } = run.outcome
    const players: RunPlayer[] = ([1, 2] as const).map((side) => {
      const player = state.players[side]
      return { name: player.name, hp: player.hp, maxHp: player.maxHp, shield: player.shield }
    })
    return {
      seed: run.seed,
      victory,
      winnerName: state.winner === null ? '未判定' : state.players[state.winner].name,
      players,
      triggerFrame: state.triggerFrame,
      timeCs: state.timeCs,
      messageCount: state.messages.length,
      frameCount: frameList.length,
      lines,
    }
  }, [run])

  /** 一句话结算语（控制条走到末帧时显示） */
  const outcomeNote = useMemo((): string => {
    if (summary === null) return ''
    const reason =
      summary.victory === 'timeout'
        ? `到达 MAX_TIME = ${MAX_TIME_SECONDS.toFixed(0)}s 超时（平局判发起方胜）`
        : summary.victory === 'hp'
          ? '血量归零'
          : '未判定'
    return `${summary.winnerName} 获胜（${reason}）`
  }, [summary])

  /** 当前帧的动作日志（用引擎自己的 `formatAction` 渲染 —— 前端不解析文本、不另写文案） */
  const frameLines = useMemo((): readonly string[] => {
    if (run === null) return []
    const frame = frames[replay.index]
    if (frame === undefined) return []
    return run.outcome.log
      .filter((entry) => entry.tick === frame.triggerFrame)
      .flatMap((entry) => formatAction(run.outcome.state, entry))
  }, [run, frames, replay.index])

  /* ---------------- 渲染 ---------------- */

  // **回放 / 结算共用一套版面（3.2 步 · F1 = A）**：左边棋盘 + 控制条，右边**固定宽右栏** ——
  // 回放填"本帧动作日志"、结算填"终局读数 + 完整日志"。左栏（卡源 + 编辑栏）只在摆盘态出现。
  if ((phase === 'replay' || phase === 'result') && run !== null && sideLooks !== null) {
    const lastIndex = Math.max(0, frames.length - 1)
    const index = phase === 'result' ? lastIndex : replay.index
    const frame = frames[index]
    // **补帧系数**：播放中按"帧内余量"插值（画面 60fps 平滑），暂停 / 步进 / 结算时恒为 0
    // ⇒ 停在任意帧时画面严格等于 `frames[i]`（逐帧一致仍可验证）。
    const fraction = phase === 'replay' && replay.playing ? frameFraction(replay) : 0
    return (
      <CardDetailContext.Provider value={detailApi}>
      <section className="replay">
        <header className="replay-head">
          <button type="button" className="replay-back" onClick={backToEdit} title="回到摆盘重新编辑（← 左上角）">
            {t('replay.back')}
          </button>
          <h3>{phase === 'result' ? t('result.title') : t('replay.title')}</h3>
          <span className="hint">
            {t('replay.seed')} <code>{String(run.seed)}</code> · {String(total)} {t('replay.seedSuffix')}
          </span>
          <span className="replay-hint">{t('replay.pinHint')}</span>
        </header>

        <div className="replay-stage">
          <div className="replay-main">
            <BattleView
              frames={frames}
              index={index}
              fraction={fraction}
              sides={sideLooks}
              cardOf={cardOf}
              rarityColorOf={rarityColorOf}
              cardArtUrlOf={cardArtUrlOf}
              frameUrlOf={frameUrlOf}
              skillIconUrlOf={skillIconUrlOf}
            />

            {phase === 'replay' && (
              <ReplayBar
                index={replay.index}
                total={total}
                playing={replay.playing}
                speed={replay.speed}
                triggerFrame={frame === undefined ? 0 : frame.triggerFrame}
                timeCs={frame === undefined ? 0 : frame.timeCs}
                outcomeNote={outcomeNote}
                onTogglePlay={togglePlay}
                onStep={stepBy}
                onSeek={seekTo}
                onSpeed={pickSpeed}
                onExit={showResult}
              />
            )}
          </div>

          <aside className={phase === 'result' ? 'rail rail-result' : 'rail'}>
            {phase === 'result' && summary !== null ? (
              <RunResult
                seed={summary.seed}
                victory={summary.victory}
                winnerName={summary.winnerName}
                players={summary.players}
                triggerFrame={summary.triggerFrame}
                timeCs={summary.timeCs}
                messageCount={summary.messageCount}
                frameCount={summary.frameCount}
                lines={summary.lines}
                onReplay={total > 1 ? openReplay : undefined}
                onClose={backToEdit}
              />
            ) : (
              <>
                <div className="rail-head">
                  <span className="facet-label">{t('replay.logTitle')}</span>
                  <span className="hint">
                    {t('replay.logCount', {
                      frame: frame === undefined ? 0 : frame.triggerFrame,
                      lines: frameLines.length,
                    })}
                  </span>
                </div>
                <div className="rail-body">
                  {frameLines.length === 0 ? (
                    <EmptyState main={t('replay.emptyFrame')} />
                  ) : (
                    <div className="run-log run-log-rail">
                      {frameLines.map((line, at) => (
                        <div key={`frame-line-${String(at)}`} className="run-log-line">
                          {arrowToTri(line)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      </section>
      {detailNode}
      </CardDetailContext.Provider>
    )
  }

  return (
    <CardDetailContext.Provider value={detailApi}>
      <SimulateBoard
        draft={draft}
        onChange={onChange}
        packs={packs}
        registry={registry}
        hasRun={run !== null}
        onStart={startBattle}
      />

      {detailNode}
    </CardDetailContext.Provider>
  )
}
