// 编辑态左栏**下半段**的编辑面板（附魔可编辑 + 属性只读）。
//
// 位置（《审阅》§AF = A）：左栏竖分两段 —— 卡牌栏吃满剩余高度，本面板**固定 260px** 钉在底部；
// 栏头右边一个 ▾ 可把它收成 **32px 标题条**（AF.6 = A），收起态只留"编辑栏 + 当前卡名"一行。
//
// 交互：**即时生效** —— 选中就回调，没有"应用"按钮；主入口是"点棋盘上的卡"（那里会自动展开本面板）。
// 数据：附魔目录取 `Card.enchantments`（卡面只写目录），当前生效值来自草稿的 `DraftPlacement.enchant`。
// 本组件**不含任何战斗规则**，只画草稿里的字段。
import { slotsForCard } from '../../../engine/board.ts'
import type { Card, EnchantDef } from '../../../engine/types.ts'
import { ENCHANT_FALLBACK_COLOR } from '../../theme/colors.ts'
import { t } from '../../i18n/index.ts'

/** 一件附魔的一行摘要（`stats` / `aura` / `actions` 各一句，尽量短） */
function summaryOf(enchant: EnchantDef): string {
  const parts: string[] = []
  for (const [stat, value] of Object.entries(enchant.stats ?? {})) {
    parts.push(`${stat} ${value >= 0 ? '+' : ''}${String(value)}`)
  }
  if (enchant.aura !== undefined) parts.push('光环')
  if (enchant.actions !== undefined && enchant.actions.length > 0) {
    parts.push(`动作 ×${String(enchant.actions.length)}`)
  }
  return parts.join(' · ')
}

function colorOf(enchant: EnchantDef): string {
  return enchant.color ?? ENCHANT_FALLBACK_COLOR
}

export interface EditPanelProps {
  /** 选中的那张卡（`undefined` = 未选卡 ⇒ 空态） */
  readonly card: Card | undefined
  /** 选中那处摆盘的当前附魔 id（`undefined` = 无附魔） */
  readonly current: string | undefined
  /** 即时生效：选一件（`undefined` = 清除）；未选卡时不会被调用 */
  readonly onPick: (enchantId: string | undefined) => void
  /** 外部校验错误（来自 `validateDeck`，可选；正常情况为空） */
  readonly problemText?: string
  /** 卡面属性（**只读基准**：输入框留空时就用它） */
  readonly stats?: Readonly<Record<string, number>> | undefined
  /** 该处摆盘的**覆盖数值**（C5；`undefined` 的键 = 不覆盖） */
  readonly overrides?: Readonly<Record<string, number>> | undefined
  /** 改一项覆盖数值（`undefined` = 撤掉这一项） */
  readonly onStat: (stat: string, value: number | undefined) => void
  /** 展开 / 收起（收起态只剩 32px 栏头） */
  readonly open: boolean
  readonly onToggle: () => void
}

/** 编辑器里**不给入口**的数值键：速度只有状态系数、`cdp` 是行动周期参数（阵容覆盖会让周期漂移） */
const HIDDEN_STAT_KEYS: ReadonlySet<string> = new Set(['speed', 'cdp'])

export function EditPanel({
  card,
  current,
  onPick,
  problemText,
  stats,
  overrides,
  onStat,
  open,
  onToggle,
}: EditPanelProps) {
  /** 属性行 = 卡面键 ∪ 已有的覆盖键，去掉不给入口的两个（排序后展示，顺序稳定） */
  const statKeys = [
    ...new Set([...Object.keys(stats ?? {}), ...Object.keys(overrides ?? {})]),
  ]
    .filter((key) => !HIDDEN_STAT_KEYS.has(key))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  return (
    <section className={open ? 'ep' : 'ep ep-closed'} aria-label={t('edit.title')}>
      <header className="ep-head">
        <b className="ep-title">{t('edit.title')}</b>
        <span className="ep-card">
          {card === undefined ? t('edit.noCard') : `${card.name} · ${String(slotsForCard(card))} 格`}
        </span>
        <button
          type="button"
          className="ep-toggle"
          aria-expanded={open}
          onClick={onToggle}
          title={open ? '收起编辑栏（给卡牌栏让出高度）' : '展开编辑栏'}
        >
          {open ? '▾' : '▸'}
        </button>
      </header>

      {open && (
        <div className="ep-body">
          {card === undefined ? (
            <div className="ep-empty">
              <p>{t('edit.pickHint')}</p>
              <p className="ep-dim">{t('edit.pickSubHint')}</p>
            </div>
          ) : (
            <>
              <p className="ep-group">{t('edit.enchantGroup')}</p>
              {(card.enchantments ?? []).length === 0 ? (
                <p className="ep-none">{t('edit.noCatalog')}</p>
              ) : (
                <ul className="ep-list">
                  <li>
                    <label className={current === undefined ? 'ep-item ep-item-on' : 'ep-item'}>
                      <input
                        type="radio"
                        name="ep-enchant"
                        checked={current === undefined}
                        onChange={() => {
                          onPick(undefined)
                        }}
                      />
                      <span className="ep-txt">
                        <span className="ep-name ep-dim">{t('edit.none')}</span>
                      </span>
                    </label>
                  </li>
                  {(card.enchantments ?? []).map((enchant) => (
                    <li key={enchant.id}>
                      <label className={current === enchant.id ? 'ep-item ep-item-on' : 'ep-item'}>
                        <input
                          type="radio"
                          name="ep-enchant"
                          checked={current === enchant.id}
                          onChange={() => {
                            onPick(enchant.id)
                          }}
                        />
                        <i className="ep-dot" style={{ background: colorOf(enchant) }} />
                        <span className="ep-txt">
                          <span className="ep-name" style={{ color: colorOf(enchant) }}>
                            {enchant.name ?? enchant.id}
                          </span>
                          <em className="ep-sum">{summaryOf(enchant)}</em>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              {problemText !== undefined && problemText.length > 0 && (
                <p className="ep-problem">{problemText}</p>
              )}

              {statKeys.length > 0 && (
                <>
                  <p className="ep-group">
                    {t('edit.stats')} <span className="ep-dim">{t('edit.statsHint')}</span>
                  </p>
                  <ul className="ep-stats">
                    {statKeys.map((stat) => {
                      const overridden = overrides?.[stat]
                      return (
                        <li key={stat} className="ep-statrow">
                          <span className="ep-statkey">{stat}</span>
                          <input
                            className="ep-statin"
                            type="number"
                            step="any"
                            value={overridden === undefined ? '' : String(overridden)}
                            placeholder={String(stats?.[stat] ?? 0)}
                            title={`卡面值 ${String(stats?.[stat] ?? 0)}；留空 = 不覆盖`}
                            onChange={(event) => {
                              const text = event.target.value
                              if (text.trim() === '') {
                                onStat(stat, undefined)
                                return
                              }
                              const parsed = Number(text)
                              if (Number.isFinite(parsed)) onStat(stat, parsed)
                            }}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
