// 卡牌库：列表 + 筛选 + 搜索（+ 卡图缩略图）
//
// 纪律：组件**不实现战斗规则**，也不发请求；数据与筛选逻辑都由 props / `state/` 提供。
// 这里读注册表的 `summary()`（与 CLI 的"加载回显"同一个函数）来显示效果，避免在表现层另写一份描述。
// 卡图 URL 一律走 `data/assets.ts`（唯一拼 URL 的地方），缺图 / 加载失败只当没有图（不阻塞）。
import { useMemo, useState } from 'react'
import type { CardRegistry } from '../../../cards/registry.ts'
import type { LoadedPack } from '../../../cards/types.ts'
import { CardImage } from '../../components/CardImage.tsx'
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
  const size = row.card.size === 'small' ? '小' : row.card.size === 'medium' ? '中' : '大'
  const slots = row.card.slots ?? (row.card.size === 'small' ? 1 : row.card.size === 'medium' ? 2 : 3)
  return `${size}/${String(slots)}格`
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
          placeholder="搜索卡名 / id / 卡包"
          value={filter.query}
          onChange={(event) => {
            setFilter({ ...filter, query: event.target.value })
          }}
        />
        <span className="count">
          {String(visible.length)} / {String(rows.length)} 张
        </span>
      </header>

      <div className="facets">
        <div className="facet-row">
          <span className="facet-label">品阶</span>
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
            <span className="facet-label">标签</span>
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
          <span className="facet-label">卡包</span>
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
              清空筛选
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
                <CardImage url={assets.cardArt(row.card.id)} className="card-thumb" />
                <span className="card-name">{row.card.name}</span>
                <span className="card-id">{row.card.id}</span>
                <span className="card-meta">
                  {sizeLabel(row)} · atk {String(row.card.stats.atk ?? 0)} · cd {String(row.card.cooldown)}cs
                </span>
                <span className="card-pack">{row.packName}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="empty">没有符合条件的卡牌</li>}
        </ul>

        <aside className="detail">
          {selected === undefined ? (
            <p className="hint">点左侧任意一张卡，看它的效果回显（与 CLI 的 `sim:validate` 同一套描述）</p>
          ) : (
            <>
              <h3>
                <i className="dot" style={{ background: selected.rarity.color }} />
                {selected.card.name}
              </h3>
              <CardImage url={assets.cardArt(selected.card.id)} className="card-art" />
              <p className="detail-meta">
                {selected.rarity.name} · {sizeLabel(selected)} · 版本 v{String(selected.card.version)} · 来源 {selected.packName}
              </p>
              <pre className="echo">{registry.summary(selected.card.id).join('\n')}</pre>
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
