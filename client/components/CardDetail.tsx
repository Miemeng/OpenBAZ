// 悬浮细节窗（《卡面表现设计.md》§4）：固定宽 360px，四区自上而下
//   **数值行 → 行动条读数条 → 效果区（主动在上、被动在下）→ 底部信息条**
//
// 本组件只渲染数据层（`state/cardDetail.ts`）算好的视图 —— 不含任何战斗规则、不解析引擎文本。

import type { CardDetailView } from '../state/cardDetail.ts'

interface CardDetailProps {
  readonly view: CardDetailView
  /** 视口坐标（贴边翻转已在数据层算好，见 `placeDetail`） */
  readonly left: number
  readonly top: number
  /** 已钉住（回放态单击卡面）：窗口描边高亮，内容**冻结在钉住那一刻** */
  readonly pinned: boolean
}

/** 秒数显示：最多两位小数、去掉末尾的 0（`3` / `1.5` / `0.25`） */
function secondsText(seconds: number): string {
  return seconds.toFixed(2).replace(/\.?0+$/, '')
}

export function CardDetail({ view, left, top, pinned }: CardDetailProps) {
  const tags = view.foot.tags.join(' · ')
  const footLeft = [tags, view.foot.multicast === null ? '' : `多重触发 ${String(view.foot.multicast)}`]
    .filter((part) => part.length > 0)
    .join(' · ')

  return (
    <aside
      className={pinned ? 'cd cd-pinned' : 'cd'}
      style={{ left, top }}
      role="dialog"
      aria-label={`${view.title} 详情`}
    >
      {/* C4a：**卡名上方只放附魔名**（具体效果在下面效果区，行首标 `[附魔]`） */}
      {view.enchant !== null && (
        <div
          className="cd-enchant"
          style={{ color: view.enchant.color, fontSize: 11, fontWeight: 600, padding: '0 10px 2px' }}
        >
          {view.enchant.name}
        </div>
      )}

      <header className="cd-head">
        <span className="cd-title">{view.title}</span>
        <span className="cd-rarity" style={{ background: view.rarity.color }}>
          {view.rarity.name}
        </span>
      </header>

      {view.description !== null && <p className="cd-desc">{view.description}</p>}

      <div className="cd-body">
        {/* ② 数值行（§5）：候选清单已固定，**词条存在即显示** */}
        {view.stats.length === 0 ? (
          <p className="cd-hint">没有可显示的数值</p>
        ) : (
          <div className="cd-stats">
            {view.stats.map((row) => (
              <span key={row.stat} className="cd-stat" style={{ background: row.color }}>
                {row.label} {String(row.value)}
              </span>
            ))}
          </div>
        )}

        {/* ③ 行动条读数条（§6）：纯被动卡没有这一条 */}
        {view.gauge !== null && (
          <div className={view.gauge.ready ? 'cd-gauge cd-gauge-ready' : 'cd-gauge'}>
            <span className="cd-gauge-period">行动条 {secondsText(view.gauge.periodSeconds)}s</span>
            <span className="cd-gauge-now">
              {view.gauge.frozen
                ? '❄ 冰冻'
                : view.gauge.ready
                  ? '就绪'
                  : view.gauge.percent === null
                    ? '未开始'
                    : `当前 ${String(view.gauge.percent)}%`}
            </span>
          </div>
        )}

        {/* ④ 效果区（§4.3：主动在上、被动在下；文本来自读取层的加载回显） */}
        {view.effects.length > 0 && (
          <div className="cd-effects">
            {view.effects.map((effect, at) => (
              <div
                key={`${effect.kind}-${String(at)}`}
                className={`cd-effect cd-effect-${effect.kind}`}
                style={
                  effect.kind === 'enchant' && view.enchant !== null ? { color: view.enchant.color } : undefined
                }
              >
                {effect.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ⑤ 底部信息条（§4.3：标签 / 归属 / 占格 / 版本；无归属不渲染那一格） */}
      <footer className="cd-foot">
        <span className="cd-foot-left">{footLeft}</span>
        <span className="cd-foot-right">
          {view.foot.owner === null ? '' : `${view.foot.owner} · `}占用 {String(view.foot.span)} 格 · v
          {String(view.foot.version)}
        </span>
      </footer>
    </aside>
  )
}
