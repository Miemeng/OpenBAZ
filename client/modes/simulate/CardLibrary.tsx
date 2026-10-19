// 卡牌库：列表 + 筛选 + 搜索（+ 卡图缩略图）
//
// 纪律：组件**不实现战斗规则**，也不发请求；数据与筛选逻辑都由 props / `state/` 提供。
// 这里读注册表的 `summary()`（与 CLI 的"加载回显"同一个函数）来显示效果，避免在表现层另写一份描述。
// 卡图 URL 一律走 `data/assets.ts`（唯一拼 URL 的地方），缺图 / 加载失败只当没有图（不阻塞）。
import { useMemo, useState } from 'react'
import type { CardRegistry } from '../../../cards/registry.ts'
import type { LoadedPack } from '../../../cards/types.ts'
import { CardImage } from '../../components/CardImage.tsx'
import { EffectLines } from '../../components/EffectLine.tsx'
import { EmptyState } from '../../components/EmptyState.tsx'
import { t } from '../../i18n/index.ts'
import { buildAssetIndex } from '../../data/assets.ts'
import { applyFilter, EMPTY_FILTER, facetsOf, toggleValue, type CardRow, type LibraryFilter } from '../../state/cardLibrary.ts'

interface CardLibraryProps {
  readonly registry: CardRegistry
  readonly rows: readonly CardRow[]
  /** 已加载的包（只为拼卡图路径；缺图不报错） */
  readonly packs: readonly LoadedPack[]
}

/** 小工具：卡面的"小 / 中 / 大 + 占格数"（占格数来自引擎契约，不在前端推 size→格数） */
function sizeLabel(row: CardRow): string {
  const key =
    row.card.size === 'small' ? 'card.sizeSmall' : row.card.size === 'medium' ? 'card.sizeMedium' : 'card.sizeLarge'
  const slots = row.card.slots ?? (row.card.size === 'small' ? 1 : row.card.size === 'medium' ? 2 : 3)
  return `${t(key)}/${String(slots)}格`
}

/** 卡图类名后缀：按卡面真实比例（小 1:2 / 中 1:1 / 大 3:2）—— 列表缩略与详情大图共用 */
function artSizeOf(size: CardRow['card']['size']): string {
  return size === 'small' ? 'small' : size === 'medium' ? 'medium' : 'large'
}

export function CardLibrary({ registry, rows, packs }: CardLibraryProps) {
  const [filter, setFilter] = useState<LibraryFilter>(EMPTY_FILTER)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const assets = useMemo(() => buildAssetIndex(packs), [packs])
  const facets = useMemo(() => facetsOf(rows), [rows])
  const visible = useMemo(() => applyFilter(rows, filter), [rows, filter])
  const selected = selectedId === null ? undefined : rows.find((row) => row.card.id === selectedId)

  return (
    <section className="library">
      <header className="library-head">
        <input
          className="search"
          type="search"
          placeholder={t('library.search')}
          value={filter.query}
          onChange={(event) => {
            setFilter({ ...filter, query: event.target.value })
          }}
        />
        <span className="count">
          {t('library.count', { visible: visible.length, total: rows.length })}
        </span>
      </header>

      <div className="facets">
        <div className="facet-row">
          <span className="facet-label">{t('library.facetRarity')}</span>
          {facets.rarities.map((rarity) => {
            const active = filter.rarities.includes(rarity.id)
            return (
              <button
                key={rarity.id}
                type="button"
                className={active ? 'chip chip-on' : 'chip'}
                onClick={() => {
                  setFilter({ ...filter, rarities: toggleValue(filter.rarities, rarity.id) })
                }}
              >
                <i className="dot" style={{ background: rarity.color }} />
                {rarity.name}
              </button>
            )
          })}
        </div>

        {facets.tags.length > 0 && (
          <div className="facet-row">
            <span className="facet-label">{t('library.facetTags')}</span>
            {facets.tags.map((tag) => {
              const active = filter.tags.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className={active ? 'chip chip-on' : 'chip'}
                  onClick={() => {
                    setFilter({ ...filter, tags: toggleValue(filter.tags, tag) })
                  }}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        )}

        <div className="facet-row">
          <span className="facet-label">{t('library.facetPacks')}</span>
          {facets.packs.map((pack) => {
            const active = filter.packIds.includes(pack.id)
            return (
              <button
                key={pack.id}
                type="button"
                className={active ? 'chip chip-on' : 'chip'}
                onClick={() => {
                  setFilter({ ...filter, packIds: toggleValue(filter.packIds, pack.id) })
                }}
              >
                {pack.name}
              </button>
            )
          })}
          {(filter.rarities.length > 0 || filter.tags.length > 0 || filter.packIds.length > 0 || filter.query !== '') && (
            <button type="button" className="chip chip-clear" onClick={() => { setFilter(EMPTY_FILTER) }}>
               {t('library.clearFilter')}
            </button>
          )}
        </div>
      </div>

      <div className="library-body">
        <ul className="card-list">
          {visible.map((row) => (
            <li key={`${row.packId}/${row.card.id}`}>
              <button
                type="button"
                className={row.card.id === selectedId ? 'card-row card-row-on' : 'card-row'}
                onClick={() => {
                  setSelectedId(row.card.id === selectedId ? null : row.card.id)
                }}
              >
                <i className="bar" style={{ background: row.rarity.color }} />
                <CardImage url={assets.cardArt(row.card.id)} className={`card-thumb card-thumb-${artSizeOf(row.card.size)}`} />
                <span className="card-name">{row.card.name}</span>
                <span className="card-id">{row.card.id}</span>
                <span className="card-meta">
                  {sizeLabel(row)}
                  {row.card.stats.atk === undefined ? '' : ` · atk ${String(row.card.stats.atk)}`}
                  {row.card.cooldown === -1 ? '' : ` · cd ${String(row.card.cooldown)}cs`}
                </span>
                <span className="card-pack">{row.packName}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li>
              <EmptyState main={t('library.empty')} hint={t('library.emptyHint')} />
            </li>
          )}
        </ul>

        <aside className="detail">
          {selected === undefined ? (
            <p className="hint">{t('library.pickHint')}</p>
          ) : (
            <>
              <h3>
                <i className="dot" style={{ background: selected.rarity.color }} />
                {selected.card.name}
              </h3>
              <CardImage
                url={assets.cardArt(selected.card.id)}
                className={`card-art card-art-${artSizeOf(selected.card.size)}`}
              />
              <p className="detail-meta">
                {t('library.meta', {
                  rarity: selected.rarity.name,
                  size: sizeLabel(selected),
                  version: selected.card.version,
                  pack: selected.packName,
                })}
              </p>
              <EffectLines lines={registry.summaryLines(selected.card.id)} values={selected.card.stats} />
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
