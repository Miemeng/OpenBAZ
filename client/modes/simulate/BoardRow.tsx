// 摆盘：一方的一行 10 格**表现层**：不算占格、不判合法性。

// 占格数直接问引擎的 `slotsForCard()`（`engine/board.ts` 的纯函数，浏览器侧可用）
// 前端**不复制**"小 1 / 中 2 / 大 3 + 卡面 slots 覆盖"这条规则；
// "格 → 单位列"的换算走 `state/boardUnits.ts`（与回放态**同一份口径**：1 格 = 2 列、一行 4 行高）。

// 交互（改为"选卡 → 点格子"，不再跟随指针拖拽）：
//   · 每一格都是一个按钮，带 `data-board-slot` / `data-side`；点它把格号回传给容器（`onSlotClick`）；
//   · 鼠标进出某格只回传 `onSlotHover`，容器据此画落点预览 —— 本组件不持有任何手持 / 拖拽状态；
//   · 已放置的卡：点一下 = 选中它准备挪位（由容器管），右键或 ✕ = 移回列表。
import { ROW_SLOTS, slotsForCard } from '../../../engine/board.ts'
import type { Card } from '../../../engine/types.ts'
import { CardImage } from '../../components/CardImage.tsx'
import { useCardDetailApi } from '../../state/cardDetailContext.ts'
import { unitColumns } from '../../state/boardUnits.ts'
import type { DraftPlacement } from '../../state/simulateDraft.ts'
import { ENCHANT_FALLBACK_COLOR } from '../../theme/colors.ts'

/** 落点预览：把某张卡放在某一行某一格合不合法（`ok` = 引擎判零几何错误） */
export interface BoardPreview {
  readonly side: 'A' | 'B'
  readonly slot: number
  /** 手持的卡 id（预览里要显示它的名字与占格数） */
  readonly cardId: string
  readonly ok: boolean
}

interface BoardRowProps {
  readonly side: 'A' | 'B'
  readonly placements: readonly DraftPlacement[]
  readonly cardOf: (cardId: string) => Card | undefined
  /** 卡图 URL（`images/cards/<card_id>.png`）；`null` = 没有图（不画） */
  readonly cardArtUrlOf: (cardId: string) => string | null
  readonly preview?: BoardPreview | undefined
  /** 有几何错误的卡下标（逐格高亮红框用） */
  readonly errorIndexes: ReadonlySet<number>
  /** 手持中的那一处（同方挪位时高亮）；`null` = 本行没有手持的卡 */
  readonly armedIndex: number | null
  readonly onSlotClick: (slot: number) => void
  /** 鼠标进出某一格（`null` = 离开本行）；只影响预览，不改任何状态 */
  readonly onSlotHover: (slot: number | null) => void
  /** 点已放置的卡（选中它准备挪位；再点一次由容器取消） */
  readonly onCardClick: (index: number) => void
  readonly onRemove: (index: number) => void
}

export function BoardRow({
  side,
  placements,
  cardOf,
  cardArtUrlOf,
  preview,
  errorIndexes,
  armedIndex,
  onSlotClick,
  onSlotHover,
  onCardClick,
  onRemove,
}: BoardRowProps) {
  const previewCard = preview === undefined ? undefined : cardOf(preview.cardId)
  // 悬浮细节窗（§4）：编辑态**只悬停**（单击卡面是"选中挪位"的既有交互，不抢）
  const detailApi = useCardDetailApi()
  // 预览**只在本行放得下时才画**：越界的预览会被 grid 甩到隐式行、把整行顶高（表现为棋盘抖动）
  const previewFits =
    preview !== undefined &&
    previewCard !== undefined &&
    preview.slot + slotsForCard(previewCard) - 1 <= ROW_SLOTS

  return (
    <div className="board">
      <ol className="board-scale" aria-hidden="true">
        {Array.from({ length: ROW_SLOTS }, (_, index) => (
          <li key={index}>{String(index + 1)}</li>
        ))}
      </ol>

      {/* 10 个格位 + 叠在上面的卡：用 CSS grid 的 `grid-column: 起点 / span 占格` 摆位，
          所以"卡占了几格"这件事**只由 `slotsForCard` 决定**，样式里不再写第二份。
          单位网格见 `state/boardUnits.ts`：一格 = 2 列、一行 = 4 行高。 */}
      <div
        className="board-row"
        data-side={side}
        onMouseLeave={() => {
          onSlotHover(null)
        }}
      >
        {Array.from({ length: ROW_SLOTS }, (_, index) => (
          <button
            key={index}
            type="button"
            className="board-slot"
            // ⚠️ **列号必须显式写**（行号在 CSS 的 `.board-slot` 里）：格位若靠 grid 自动排布，
            //    会被"显式指定列"的卡牌先占格、格位再跳过已占格落位 ⇒ 放上卡之后格位整体左移
            //    （点第 8 格拿到的是"格位 5"），预览出现 / 消失时还会让整行格位跳动。
            style={{ gridColumn: unitColumns(index + 1, 1), gridRow: '1 / -1' }}
            data-board-slot={index + 1}
            data-side={side}
            title={`第 ${String(index + 1)} 格`}
            onClick={() => {
              onSlotClick(index + 1)
            }}
            onMouseEnter={() => {
              onSlotHover(index + 1)
            }}
          />
        ))}

        {preview !== undefined && preview.side === side && previewCard !== undefined && previewFits && (
          <div
            className={preview.ok ? 'board-ghost board-ghost-ok' : 'board-ghost board-ghost-bad'}
            style={{
              gridColumn: unitColumns(preview.slot, slotsForCard(previewCard)),
              gridRow: '1 / -1',
            }}
          >
            {previewCard.name}
          </div>
        )}

        {placements.map((placement, index) => {
          const card = cardOf(placement.cardId)
          if (card === undefined) return null
          const classes = ['board-card']
          if (errorIndexes.has(index)) classes.push('board-card-bad')
          if (armedIndex === index) classes.push('board-card-on')
          return (
            <div
              key={placement.uid}
              className={classes.join(' ')}
              style={{
                gridColumn: unitColumns(placement.slot, slotsForCard(card)),
                gridRow: '1 / -1',
              }}
              data-board-slot={placement.slot}
              data-side={side}
              role="button"
              tabIndex={0}
              onMouseEnter={(event) => {
                // 编辑态没有帧快照 ⇒ 把**草稿里这一处的附魔**带过去，悬浮窗才显示"附魔：壁垒"
                detailApi?.enter(card, undefined, { x: event.clientX, y: event.clientY }, placement.enchant)
              }}
              onMouseLeave={() => {
                detailApi?.leave()
              }}
              title={`${card.name} —— 点一下选中它，再点目标格挪位 / 右键移回列表`}
              onClick={() => {
                onCardClick(index)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                onRemove(index)
              }}
            >
              {/* 卡图当底（有图就画、缺图不画）；名字 / 格号 / ✕ 都压在它上面 */}
              <CardImage url={cardArtUrlOf(card.id)} className="board-card-art" />
              <span className="board-card-name">{card.name}</span>
              <span className="board-card-slot">{String(placement.slot)}</span>
              {/* C4b：有附魔时右上角一个小圆点（颜色 = 该附魔的 color，缺省回落内置附魔色） */}
              {(() => {
                const enchant = (card.enchantments ?? []).find((item) => item.id === placement.enchant)
                if (enchant === undefined) return null
                return (
                  <span
                    className="board-card-enchant"
                    title={`附魔：${enchant.name ?? enchant.id}`}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: enchant.color ?? ENCHANT_FALLBACK_COLOR,
                      boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.55)',
                    }}
                  />
                )
              })()}
              <button
                type="button"
                className="board-card-remove"
                title="移回列表"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(index)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
