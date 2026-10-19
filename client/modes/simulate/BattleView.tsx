// 回放画面**表现层**：按一份 `FrameSnapshot` 画双方（血量 / 护盾 / 持续效果 / 行动条 / 状态 / 失效）。

// 纪律：
//   · **只消费**帧快照与帧事件 —— 不重算任何数值、不按 `cooldown` 自己推周期（黄金法则 3）；
//   · 行动条分母 = 引擎给的 `FrameCard.periodCs`，`null` 的两种含义由 `state/replay.ts` 的
//     `gaugeViewOf()` 分辨（纯被动卡不画条 / 冰冻沿用上一帧周期）；
//   · 飘字与高亮**贴在锚点内部**（玩家头像 / 卡面各自 `position: relative`），不做坐标换算；
//   · 卡面名字、品阶色与**卡图**来自**跑那一局时的阵容快照**（`cardOf` 按"方 + 格号"建表），
//     所以跑完之后再改草稿也不会让回放变样。

// **尺寸口径（RW 定：小卡 高4宽2 / 中卡 高4宽4 / 大卡 高4宽6）** 见 `client/state/boardUnits.ts`：
//   一行 10 格 = **20 个单位列 × 4 个单位行**（1 格 = 2 列），小 / 中 / 大卡占 2 / 4 / 6 列、**都占满 4 行**；
//   行高由 `aspect-ratio: 20 / 4` 跟着宽度走 ⇒ 单位格是正方形，卡面比例正好是
//   2:4 / 4:4 / 6:4（= 《卡面表现设计.md》§2 的三尺寸 200×400 / 400×400 / 600×400）。
import { useMemo } from 'react'
import type { MouseEvent } from 'react'
import { ROW_SLOTS, slotsForCard } from '../../../engine/board.ts'
import { csToSeconds } from '../../../engine/state.ts'
import type { Card, FrameCard, FrameSnapshot, PlayerId, Skill } from '../../../engine/types.ts'
import { CardImage } from '../../components/CardImage.tsx'
import { unitColumns } from '../../state/boardUnits.ts'
import {
  buildFloaters,
  buildHighlights,
  cardsOfSide,
  gaugeRatioAt,
  gaugeViewOf,
  lerp,
  REPLAY_ANIM,
  shieldShownAt,
  type Floater,
  type FrameHighlights,
} from '../../state/replay.ts'
import { DOT_LOOK, STAT_ROW, STATUS_LOOK } from '../../theme/colors.ts'
import { EventFloaters } from './EventFloaters.tsx'
import { SkillSlots } from './SkillSlots.tsx'
import { useCardDetailApi } from '../../state/cardDetailContext.ts'

/**
 * **卡框绘制总开关**（RW §Z.4：「先留接口吧，先不做这个部分了……预留位置吧，
 * 我们先往下推进，先用侧边稀有度显示」）。
 *
 * `false` = **不画卡框**（也不去请求素材 URL）：顶端数值行现在会被框压住，且"框比卡略大"
 * 需要先给内容留一圈内边距（`styles.css` 的 `.battle-card` 上那个 `--bc-frame-inset`）。
 * **接口全部保留**：`frameUrlOf` 入参、`assets.rarityFrame()`、`.bc-frame` 样式都还在。
 *
 * 启用卡框 = ① 这里改成 `true`；② `.battle-card` 的 `--bc-frame-inset` 设成素材厚度（建议 6px）。
 */
const CARD_FRAME_ENABLED: boolean = false

/** 头像闪烁的档位：**受伤红 / 治疗绿 / 其它琥珀**（把"这一帧是好事还是坏事"一眼分开） */
function hitToneOf(floaters: readonly Floater[]): 'damage' | 'heal' | 'other' {
  if (floaters.some((floater) => floater.tone === 'damage' || floater.tone === 'shieldBreak')) return 'damage'
  if (floaters.some((floater) => floater.tone === 'heal')) return 'heal'
  return 'other'
}

/** 一方在回放里要显示的静态信息（**来自阵容快照 + 引擎产物**，不是当前草稿） */
export interface BattleSideLook {
  /** 玩家名（`FramePlayer` 只有 `id` 与读数、没有名字 ⇒ 由调用方从 `state.players[].name` 取） */
  readonly name: string
  /** 角色名；没选到角色时 `null`（不显示这一项，头像回落首字色块） */
  readonly heroName: string | null
  /** 角色头像 URL（`images/heroes/<hero_id>/avatar.png`）；`null` = 没有角色 */
  readonly avatarUrl: string | null
  /** 本局携带的技能（技能位 + 触发高亮） */
  readonly skills: readonly Skill[]
}

interface BattleViewProps {
  readonly frames: readonly FrameSnapshot[]
  /** 当前帧下标（`frames[index]`） */
  readonly index: number
  /**
   * **补帧系数**（0–1）：`0` = 画面严格等于当前帧快照，趋近 `1` = 快走到下一帧。
   * 播放中由 `SimulateMode` 按"帧内余量 ÷ 一帧时长"给；**暂停 / 步进时恒为 0**。
   */
  readonly fraction: number
  readonly sides: Readonly<Record<PlayerId, BattleSideLook>>
  /** 按「归属方 + 起始格号」取卡面定义（同一方内起始格号必不重复，故是可靠键） */
  readonly cardOf: (owner: PlayerId, slot: number) => Card | undefined
  readonly rarityColorOf: (card: Card) => string
  /** 卡图 URL（`images/cards/<card_id>.png`）；`null` = 没有图（不画，回落品阶色） */
  readonly cardArtUrlOf: (card: Card) => string | null
  /** 卡框材质 URL（品阶 `frame` → `images/frames/<frame>/card_frame.png`）；`null` = 该品阶没写 `frame` */
  readonly frameUrlOf: (card: Card) => string | null
  /** 技能图标 URL（`images/skills/<skill_id>.png`）；`null` = 没有图（回落技能名首字） */
  readonly skillIconUrlOf: (skillId: string) => string | null
}

/** 0–100 的百分比（分母非法时给 0，不抛错） */
function percentOf(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0
  return Math.min(100, Math.max(0, (value / max) * 100))
}

/** 剩余时长文案：省略 = 常驻（见 `FrameDot.remainingCs`） */
function remainingText(remainingCs: number | undefined): string {
  return remainingCs === undefined ? '常驻' : `${csToSeconds(remainingCs).toFixed(1)}s`
}

/**
 * 卡面数值行（按 `STAT_ROW` 的固定顺序）。
 *
 * **显示条件 = 该词条在 `FrameCard.stats` 里存在**（值为 0 也显示）—— 与"值 > 0"无关；
 * 候选清单由 `STAT_ROW` 决定（不含 `speed`，速度不再显示）。
 */
function statRowsOf(card: FrameCard): readonly { readonly stat: string; readonly label: string; readonly color: string; readonly value: number }[] {
  const rows: { stat: string; label: string; color: string; value: number }[] = []
  for (const item of STAT_ROW) {
    const found = card.stats.find((stat) => stat.stat === item.stat)
    if (found === undefined) continue
    rows.push({ ...item, value: found.value })
  }
  return rows
}

export function BattleView({
  frames,
  index,
  fraction,
  sides,
  cardOf,
  rarityColorOf,
  cardArtUrlOf,
  frameUrlOf,
  skillIconUrlOf,
}: BattleViewProps) {
  const frame = frames[index]
  const next = frames[index + 1]
  const floaters = useMemo(() => (frame === undefined ? [] : buildFloaters(frame.events)), [frame])
  const highlights = useMemo(() => (frame === undefined ? null : buildHighlights(frame.events)), [frame])

  if (frame === undefined || highlights === null) {
    return <p className="hint">这一局没有帧快照（引擎侧未开启 captureFrames，或帧数组为空）</p>
  }

  return (
    <section className="battle">
      <BattlePlayer
        side={1}
        frame={frame}
        next={next}
        fraction={fraction}
        shield={shieldShownAt(frames, index, 1, fraction)}
        look={sides[1]}
        highlights={highlights}
        skillIconUrlOf={skillIconUrlOf}
        floaters={floaters.filter((floater) => floater.targetKey === 'player:1')}
      />
      <FrameBoard
        side={1}
        frame={frame}
        frameIndex={index}
        frames={frames}
        fraction={fraction}
        cardOf={cardOf}
        rarityColorOf={rarityColorOf}
        cardArtUrlOf={cardArtUrlOf}
        frameUrlOf={frameUrlOf}
        highlights={highlights}
        floaters={floaters}
      />
      <FrameBoard
        side={2}
        frame={frame}
        frameIndex={index}
        frames={frames}
        fraction={fraction}
        cardOf={cardOf}
        rarityColorOf={rarityColorOf}
        cardArtUrlOf={cardArtUrlOf}
        frameUrlOf={frameUrlOf}
        highlights={highlights}
        floaters={floaters}
      />
      <BattlePlayer
        side={2}
        frame={frame}
        next={next}
        fraction={fraction}
        shield={shieldShownAt(frames, index, 2, fraction)}
        look={sides[2]}
        highlights={highlights}
        skillIconUrlOf={skillIconUrlOf}
        floaters={floaters.filter((floater) => floater.targetKey === 'player:2')}
      />
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * 玩家面板（头像 + 名字 + 血条 / 护盾 + 持续效果 + 技能位）
 * ------------------------------------------------------------------ */

interface BattlePlayerProps {
  readonly side: PlayerId
  readonly frame: FrameSnapshot
  /** 下一帧（用于补帧）；末帧时 `undefined` */
  readonly next: FrameSnapshot | undefined
  readonly fraction: number
  /**
   * **本拍应当显示的护盾值**（由 `shieldShownAt` 按帧内事件重放算出，父组件给）。
   * 护盾是**存量**：同一 0.2s 帧内可以"先 +60 再被打空"，只按端点插值会一直是 0。
   */
  readonly shield: number
  readonly look: BattleSideLook
  readonly highlights: FrameHighlights
  readonly skillIconUrlOf: (skillId: string) => string | null
  readonly floaters: readonly Floater[]
}

function BattlePlayer({
  side,
  frame,
  next,
  fraction,
  shield,
  look,
  highlights,
  skillIconUrlOf,
  floaters,
}: BattlePlayerProps) {
  const player = frame.players.find((item) => item.id === side)
  if (player === undefined) return null

  // **补帧**：血按"本帧 → 下一帧"线性插值（条宽与数字一起走，暂停时 fraction = 0 ⇒ 原值）；
  // 盾不走插值 —— 由父组件用 `shieldShownAt` 按帧内事件（获得 / 消耗 / 击穿）重放，
  // 否则"同一帧里先 +60 再被打空"会被端点吃掉（RW 实测的"有跳字没盾条"）。
  const nextPlayer = next?.players.find((item) => item.id === side)
  const hp = nextPlayer === undefined ? player.hp : lerp(player.hp, nextPlayer.hp, fraction)

  const hits = highlights.players.get(String(side)) ?? 0
  const dots = player.dots.filter((dot) => dot.stacks > 0)
  const letter = look.heroName === null ? (side === 1 ? 'A' : 'B') : look.heroName.slice(0, 1)
  const tone = hits > 0 ? hitToneOf(floaters) : null
  const avatarClass =
    tone === null
      ? 'bp-avatar'
      : tone === 'other'
        ? 'bp-avatar bp-avatar-hit'
        : `bp-avatar bp-avatar-hit bp-avatar-hit-${tone}`

  return (
    <div className="bp" data-side={side === 1 ? 'A' : 'B'}>
      <EventFloaters floaters={floaters} />

      {/* **受伤 / 治疗 / 跳变的闪烁只落在这里**（整条面板闪会晃眼 —— RW 指示）；时长由 `REPLAY_ANIM` 给 */}
      <div
        className={avatarClass}
        style={tone === null ? undefined : { animationDuration: `${String(REPLAY_ANIM.highlightMs)}ms` }}
        title={look.heroName === null ? '没有角色（首字色块）' : look.heroName}
      >
        <CardImage
          url={look.avatarUrl}
          className="bp-avatar-img"
          alt={look.heroName ?? ''}
          fallback={<span className="bp-avatar-letter">{letter}</span>}
        />
      </div>

      <div className="bp-head">
        <span className="bp-tag">{side === 1 ? 'A' : 'B'}方</span>
        <b className="bp-name">{look.name}</b>
        {look.heroName !== null && <span className="bp-hero">{look.heroName}</span>}
      </div>

      <div className="bp-bars">
        <div className="bar-track" title={`血量 ${String(player.hp)} / ${String(player.maxHp)}`}>
          <div className="bar-fill bar-hp" style={{ width: `${String(percentOf(hp, player.maxHp))}%` }} />
          <span className="bar-text">
            {String(Math.round(hp))} / {String(player.maxHp)}
          </span>
        </div>
        <div className="bar-track bar-track-thin" title={`护盾 ${String(Math.round(shield))}`}>
          <div className="bar-fill bar-shield" style={{ width: `${String(percentOf(shield, player.maxHp))}%` }} />
          <span className="bar-text">{shield > 0.5 ? `盾 ${String(Math.round(shield))}` : '无盾'}</span>
        </div>

        {/* 持续效果（灼 / 毒 / 生）**独占盾条下面一行、且位置恒预留**（RW 指示）：
            这样它们出现 / 消失时不会去挤上面的血条与盾条（旧版把这一行放在右侧，一出现就换行顶高整条面板）。 */}
        <ul className="dot-row">
          {dots.map((dot) => {
            const look2 = DOT_LOOK[dot.kind]
            const ticks = highlights.dots.get(`${String(side)}:${dot.kind}`) ?? 0
            return (
              <li
                key={dot.kind}
                className={ticks > 0 ? 'dot-badge dot-badge-on' : 'dot-badge'}
                style={{ color: look2.color }}
                title={`${look2.label}：${String(dot.stacks)} 层（${remainingText(dot.remainingCs)}）`}
              >
                <b>{look2.label}</b>
                <span>{String(dot.stacks)}</span>
                <em>{remainingText(dot.remainingCs)}</em>
              </li>
            )
          })}
        </ul>
      </div>

      <SkillSlots mode="replay" chosen={look.skills} counts={highlights.skills} iconUrlOf={skillIconUrlOf} />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 战场一行（10 格 = 20 个单位列 × 4 个单位行 + 叠在上面的卡）
 * ------------------------------------------------------------------ */

interface FrameBoardProps {
  readonly side: PlayerId
  readonly frame: FrameSnapshot
  readonly frameIndex: number
  readonly frames: readonly FrameSnapshot[]
  /** 补帧系数（0 = 该帧原值） */
  readonly fraction: number
  readonly cardOf: (owner: PlayerId, slot: number) => Card | undefined
  readonly rarityColorOf: (card: Card) => string
  readonly cardArtUrlOf: (card: Card) => string | null
  readonly frameUrlOf: (card: Card) => string | null
  readonly highlights: FrameHighlights
  readonly floaters: readonly Floater[]
}

function FrameBoard({
  side,
  frame,
  frameIndex,
  frames,
  fraction,
  cardOf,
  rarityColorOf,
  cardArtUrlOf,
  frameUrlOf,
  highlights,
  floaters,
}: FrameBoardProps) {
  const cards = cardsOfSide(frame, side)
  return (
    <div className="battle-board" data-side={side === 1 ? 'A' : 'B'}>
      <ol className="board-scale" aria-hidden="true">
        {Array.from({ length: ROW_SLOTS }, (_, at) => (
          <li key={at}>{String(at + 1)}</li>
        ))}
      </ol>
      <div className="board-row board-row-static">
        {/* 格位跨度也**显式写死**：否则会被"显式列"的卡牌挤走（与摆盘同一个坑） */}
        {Array.from({ length: ROW_SLOTS }, (_, at) => (
          <span
            key={`slot-${String(at)}`}
            className="board-slot-static"
            style={{ gridColumn: unitColumns(at + 1, 1), gridRow: '1 / -1' }}
          />
        ))}
        {cards.map((card) => (
          <BattleCard
            key={card.instanceId}
            card={card}
            frames={frames}
            frameIndex={frameIndex}
            fraction={fraction}
            def={cardOf(card.owner, card.slot)}
            rarityColorOf={rarityColorOf}
            cardArtUrlOf={cardArtUrlOf}
            frameUrlOf={frameUrlOf}
            highlights={highlights}
            floaters={floaters.filter((floater) => floater.targetKey === `card:${card.instanceId}`)}
          />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 一张卡（叠层结构，自上而下 / 自下而上的顺序见每段注释）
 *   ① 置顶**属性通栏**：每个属性一格，底色 = 该属性的颜色、字 = 白字（黑描边）
 *   ② **整块卡面 = 进度条**（属性条以下）：**从下往上**填充，填充渐变透明、只留一条较明显的边界线
 *      —— 与卡面外框一起构成"**日**"字形（上格 = 属性，中横 = 进度边界，下格 = 已填充区）
 *   ③ 底部一行：卡名（左）/ 角标（中右）/ 百分比（右）
 *   ④ 最上层：**品阶卡框材质**（`images/frames/<frame>/card_frame.png`，九宫格 `border-image`）
 * 卡图铺满整卡、压在最底（`z-index: 0`）；飘字层在最上（`z-index: 6`，见 `styles.css`）。
 * ------------------------------------------------------------------ */

interface BattleCardProps {
  readonly card: FrameCard
  readonly frames: readonly FrameSnapshot[]
  readonly frameIndex: number
  /** 补帧系数（0 = 该帧原值） */
  readonly fraction: number
  readonly def: Card | undefined
  readonly rarityColorOf: (card: Card) => string
  readonly cardArtUrlOf: (card: Card) => string | null
  readonly frameUrlOf: (card: Card) => string | null
  readonly highlights: FrameHighlights
  readonly floaters: readonly Floater[]
}

function BattleCard({
  card,
  frames,
  frameIndex,
  fraction,
  def,
  rarityColorOf,
  cardArtUrlOf,
  frameUrlOf,
  highlights,
  floaters,
}: BattleCardProps) {
  const gauge = gaugeViewOf(frames, frameIndex, card)
  // **补帧**：行动条按"这一 cs 走到哪"给 —— 归零前按速率走满、归零那一刻归 0、之后重新走
  const ratio = gaugeRatioAt(frames, frameIndex, card, fraction)
  const triggered = highlights.cards.get(card.instanceId) ?? 0
  const name = def === undefined ? card.instanceId : def.name
  const span = def === undefined ? 1 : slotsForCard(def)
  const percent = ratio === null ? null : Math.round(ratio * 100)
  // 一格宽（小卡）放不下「攻 5」，只显示数字；属性条也留出更多格
  const compact = span <= 1
  const stats = statRowsOf(card)

  const classes = ['battle-card']

  // 悬浮细节窗（§4）：**悬停即显 + 单击钉住**（回放态；`def` 拿不到时不挂事件）
  // ⚠️ 把 `detailApi` / `def` 先收进**const** 再进闭包 —— TS 不会把"参数/可能为 null"的收窄带进回调里
  const detailApi = useCardDetailApi()
  const detailHandlers = (() => {
    if (detailApi === null || def === undefined) return {}
    const api = detailApi
    const cardDef = def
    return {
      onMouseEnter: (event: MouseEvent<HTMLDivElement>) => {
        api.enter(cardDef, card, { x: event.clientX, y: event.clientY })
      },
      onMouseLeave: () => {
        api.leave()
      },
      onClick: (event: MouseEvent<HTMLDivElement>) => {
        // 卡面单击 = 钉住 / 取消钉住；**阻止冒泡**，否则 SimulateMode 的"点窗口外关闭"会立刻把它收掉
        event.stopPropagation()
        api.togglePin(cardDef, card, { x: event.clientX, y: event.clientY })
      },
    }
  })()
  if (card.destroyed) classes.push('battle-card-dead')
  if (triggered > 0) classes.push('battle-card-on')
  if (floaters.length > 0) classes.push('battle-card-hit')
  if (stats.length === 0) classes.push('battle-card-nostats')
  if (compact) classes.push('battle-card-compact')
  const colored = triggered > 0 || floaters.length > 0

  const artUrl = def === undefined ? null : cardArtUrlOf(def)
  const frameUrl = def === undefined ? null : frameUrlOf(def)

  return (
    <div
      className={classes.join(' ')}
      style={{
        gridColumn: unitColumns(card.slot, span),
        gridRow: '1 / -1',
        ...(def === undefined ? {} : { borderLeftColor: rarityColorOf(def) }),
        ...(colored ? { animationDuration: `${String(REPLAY_ANIM.highlightMs)}ms` } : {}),
      }}
      data-board-slot={card.slot}
      {...detailHandlers}
    >
      <EventFloaters floaters={floaters} />

      {/* z0 卡图：`packs/<包>/images/cards/<card_id>.png`（文件名 = 注册 id，不写字段）；
          没有图 / 加载失败 ⇒ 什么都不画（回落品阶色 + 深色底），**不阻塞** */}
      <CardImage url={artUrl} className="bc-art" />

      {/* z2 **置顶属性通栏**：底色 = 该属性的颜色、白字（黑描边保证亮色底上也读得清） */}
      <div className="bc-stats">
        {stats.map((item) => (
          <span
            key={item.stat}
            className="bc-stat"
            style={{ background: item.color }}
            title={`${item.label} ${String(item.value)}`}
          >
            {compact ? String(item.value) : `${item.label} ${String(item.value)}`}
          </span>
        ))}
      </div>

      {/* z1 **进度区 = 整块卡面**（属性条以下）：从下往上填充；`ratio === null` = 纯被动卡不画。
          填充层**完全透明**，只留一条**白线** + 白线下方一点点**蓝色拖尾**（RW 指示）。 */}
      <div className="bc-body">
        {ratio !== null && (
          <div
            className="bc-fill"
            style={{ height: `${String(ratio * 100)}%` }}
            title={`行动条 ${String(percent ?? 0)}%（周期 ${csToSeconds(gauge.periodCs ?? 0).toFixed(2)}s）`}
          />
        )}

        {/* z2 底部一行：卡名 / 角标 / 百分比 */}
        <div className="bc-foot">
          <span className="bc-name">{name}</span>
          <span className="bc-badges">
            {gauge.ready && <span className="bc-badge bc-badge-ready">就绪</span>}
            {card.statuses.map((status) => (
              <span
                key={status.kind}
                className="bc-badge"
                style={{ color: STATUS_LOOK[status.kind].color }}
                title={`${STATUS_LOOK[status.kind].label}：剩 ${csToSeconds(status.remainingCs).toFixed(1)}s`}
              >
                {STATUS_LOOK[status.kind].label}
                {compact ? '' : `${csToSeconds(status.remainingCs).toFixed(1)}s`}
              </span>
            ))}
            {card.actionCount > 0 && <span className="bc-badge">×{String(card.actionCount)}</span>}
            {card.destroyed && <span className="bc-badge bc-badge-dead">失效</span>}
          </span>
          {percent !== null && <span className="bc-pct">{compact ? `${String(percent)}%` : `行动 ${String(percent)}%`}</span>}
        </div>
      </div>

      {/* z3 **卡框材质（最上层；v0.19 起默认不画）**：品阶 `frame` → `images/frames/<frame>/card_frame.png`。
          画法 = **九宫格**（CSS `border-image`，切片 24px —— 角不拉伸、边单向拉伸、**中间不画**）。
          ⏸ **暂时关掉**（`CARD_FRAME_ENABLED = false`）：素材一上来会盖住顶端数值行（框压在卡内侧），
          而且"框比卡略大"这件事要先靠 `--bc-frame-inset` 给内容留一圈内边距才能做（RW §Z.4）。
          ⇒ **接口保留**（`frameUrlOf` / `assets.rarityFrame()` / `.bc-frame` 都在），
          启用 = ① 本文件把 `CARD_FRAME_ENABLED` 改成 `true`；② `styles.css` 的 `.battle-card`
          把 `--bc-frame-inset` 设成素材厚度（建议 6px）。稀有度这期间用**侧边品阶色条**（`.battle-card` 的 `border-left`）。 */}
      {CARD_FRAME_ENABLED && frameUrl !== null && (
        <div className="bc-frame" style={{ borderImageSource: `url("${frameUrl}")` }} />
      )}
    </div>
  )
}
