// 编辑态的**附魔侧边栏**（C4c-2，纯展示 + 回调；不含任何战斗规则）
//
// 位置（RW 定稿）：卡牌列表**下面**，高度给列表让出空间（约 200px，内部滚动）。
// 交互（RW 定稿）：**即时生效** —— 选中就回调，没有"应用"按钮；主入口只有"点摆盘上的卡"。
// 数据：卡面目录用 `Card.enchantments`（卡面只写目录），当前生效值来自草稿的 `DraftPlacement.enchant`。

import type { Card, EnchantDef } from '../../../engine/types.ts'
import { ENCHANT_FALLBACK_COLOR } from '../../theme/colors.ts'

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

export interface EnchantSidebarProps {
  /** 选中的那张卡（`undefined` = 未选卡 ⇒ 空态） */
  readonly card: Card | undefined
  /** 选中那处摆盘的当前附魔 id（`undefined` = 无附魔） */
  readonly current: string | undefined
  /** 即时生效：选一件（`undefined` = 清除）；未选卡时不会被调用 */
  readonly onPick: (enchantId: string | undefined) => void
  /** 外部校验错误（来自 `validateDeck`，可选；正常情况为空） */
  readonly problemText?: string
}

export function EnchantSidebar({ card, current, onPick, problemText }: EnchantSidebarProps) {
  return (
    <section className="es" aria-label="附魔">
      <h3 className="es-title">附魔</h3>

      {card === undefined ? (
        <p className="es-hint">
          点场上的一张卡来编辑它的附魔
          <br />
          <span className="es-dim">附魔写在阵容里（局外养成），不改卡牌文件</span>
        </p>
      ) : (
        <>
          <p className="es-card">
            {card.name}
            <span className="es-dim"> · {card.size}</span>
          </p>
          {(card.enchantments ?? []).length === 0 ? (
            <p className="es-hint es-dim">这张卡没有附魔目录（卡面未写 enchantments）</p>
          ) : (
            <ul className="es-list">
              <li>
                <label className="es-item">
                  <input
                    type="radio"
                    name="es-enchant"
                    checked={current === undefined}
                    onChange={() => {
                      onPick(undefined)
                    }}
                  />
                  <span className="es-dim">— 无 —</span>
                </label>
              </li>
              {(card.enchantments ?? []).map((enchant) => (
                <li key={enchant.id}>
                  <label className="es-item">
                    <input
                      type="radio"
                      name="es-enchant"
                      checked={current === enchant.id}
                      onChange={() => {
                        onPick(enchant.id)
                      }}
                    />
                    <span className="es-dot" style={{ background: colorOf(enchant) }} />
                    <span className="es-name" style={{ color: colorOf(enchant) }}>
                      {enchant.name ?? enchant.id}
                    </span>
                    <span className="es-sum">{summaryOf(enchant)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {problemText !== undefined && problemText.length > 0 && <p className="es-problem">{problemText}</p>}
    </section>
  )
}
