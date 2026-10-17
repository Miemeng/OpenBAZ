// 战场与摆盘

// 已定规则（不得自行改动）：
// - 双方**各一行 10 格**；"相邻" = 同侧格子索引相邻（无行列几何问题）
// - 卡牌占位按 size 推导：small 1 格 / medium 2 格 / large 3 格，可被卡面 `slots` 覆盖
// - 摆盘合法性：目标**连续**格全部为空且不越界；模拟模式只校验几何，不校验强度
// - 同名卡允许多张，生成不同 instanceId

// 因此"位置"是卡牌的**一等字段**：不仅用于渲染（哪一格放哪张卡），
// 也用于行动顺序（同优先级下按加载顺序，而加载顺序 = 先本方后敌方、各自从左到右）
// 与将来的相邻类选择器（adjacent_to_self / adjacent_left_self / adjacent_right_self）。
import type { BoardCard, Card, CardSize, PlayerId } from './types.ts'

/** 每行格子数 */
export const ROW_SLOTS = 10

/** size → 占格数（可被卡面 `slots` 覆盖） */
export function slotsForCard(card: Card): number {
  if (card.slots !== undefined) return card.slots
  switch (card.size) {
    case 'small':
      return 1
    case 'medium':
      return 2
    case 'large':
      return 3
  }
}

/**
 * 卡牌占用的格子索引区间（1 基，闭区间）。
 * 例：slot=3、占 2 格 → { from: 3, to: 4 }
 */
export function slotRange(boardCard: BoardCard): { readonly from: number; readonly to: number } {
  const slots = slotsForCard(boardCard.card)
  return { from: boardCard.slot, to: boardCard.slot + slots - 1 }
}

/** 场上卡牌的占格数（便捷转发，避免各处重复解 size） */
export function slotsOfBoardCard(boardCard: BoardCard): number {
  return slotsForCard(boardCard.card)
}

/** 摆盘校验错误码 */
export type BoardErrorCode = 'E_SLOT' | 'E_CARD_REF'

export interface BoardError {
  readonly code: BoardErrorCode
  /** 出错方 */
  readonly side: PlayerId
  /** 相关卡牌 id（无法定位到具体卡时为 undefined） */
  readonly cardId?: string
  readonly message: string
}

export interface Placement {
  readonly card: Card
  /** 左端所在格，1–10 */
  readonly slot: number
  /**
   * 开局时这张卡的**当前生效附魔 id**（选填；C4e / 《审阅.md》§AE = A）。
   *
   * 这是**玩家配装**带来的"出厂自带"（局外养成）—— 卡牌文件里**仍然禁止**写 `enchant`（AD.6 = B）。
   * 合法性由阵容校验负责（`cards/deck.ts`：该卡 `enchantments` 目录里必须有这个 id）。
   */
  readonly enchant?: string
}

/**
 * 校验单方摆盘。返回**全部**错误（不是遇到第一个就停），便于 CLI 一次性报告。
 *
 * 校验项：格号越界 / 占格越界 / 格子重叠。
 * 引用完整性（卡牌 id 是否已注册）不在本函数职责内——它需要注册表，见 。
 */
export function validatePlacements(side: PlayerId, placements: readonly Placement[]): BoardError[] {
  const errors: BoardError[] = []
  const taken = new Map<number, string>() // 格号 → 已占用它的卡牌 id

  for (const placement of placements) {
    const cardId = placement.card.id
    const slots = slotsForCard(placement.card)
    const to = placement.slot + slots - 1

    if (!Number.isInteger(placement.slot) || placement.slot < 1 || placement.slot > ROW_SLOTS) {
      errors.push({
        code: 'E_SLOT',
        side,
        cardId,
        message: `${cardId} 的 slot=${String(placement.slot)} 越界（合法范围 1–${String(ROW_SLOTS)}）`,
      })
      continue
    }
    if (to > ROW_SLOTS) {
      errors.push({
        code: 'E_SLOT',
        side,
        cardId,
        message: `${cardId} 占 ${String(slots)} 格、起点 ${String(placement.slot)}，右端 ${String(to)} 超出 ${String(ROW_SLOTS)} 格`,
      })
      continue
    }

    for (let slot = placement.slot; slot <= to; slot += 1) {
      const owner = taken.get(slot)
      if (owner !== undefined) {
        errors.push({
          code: 'E_SLOT',
          side,
          cardId,
          message: `${cardId} 与 ${owner} 在第 ${String(slot)} 格重叠`,
        })
      } else {
        taken.set(slot, cardId)
      }
    }
  }

  return errors
}

/**
 * 把摆盘转成按"加载顺序"排好的场上卡牌列表。
 *
 * 加载顺序：战斗开始时，**先本方后敌方、各自从左到右**。
 * 这里只处理**单方**：按 slot 升序即为该方的加载顺序；跨方的先后由战斗状态里的
 * `loadOrder` 全局序号保证（见 state.ts）。同名卡按传入顺序区分 instanceId。
 *
 * @param side 归属方
 * @param placements 该方摆盘（顺序任意，函数内部按 slot 排序）
 * @returns 按 slot 升序的 BoardCard 列表
 */
export function buildBoardCards(side: PlayerId, placements: readonly Placement[]): BoardCard[] {
  const ordered = [...placements].sort((a, b) => a.slot - b.slot)
  return ordered.map((placement, index): BoardCard => ({
    card: placement.card,
    owner: side,
    slot: placement.slot,
    // 单方内的序号（0 基）；跨方全局序号由 createBattleState 赋值
    loadOrder: index,
    instanceId: `${side}-${placement.card.id}-${String(placement.slot)}`,
    gaugeCs: 0,
    actionCount: 0,
    destroyed: false,
    stats: [],
    statuses: [],
    ...(placement.enchant === undefined ? {} : { enchant: placement.enchant }),
  }))
}

/**
 * 渲染一行 10 格的战场（CLI 用）。
 *
 * 输出示例（`·` = 空格，双向箭头标出占多格的卡）：
 *   ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
 *   │ 1  │ 2  │ 3  │ 4  │ 5  │ 6  │ 7  │ 8  │ 9  │10  │
 *   ├────┼────┼────┼────┼────┼────┼────┼────┼────┼────┤
 *   │wolf│  ← iron→   │  · │  · │  · │  · │  · │  · │
 *   └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
 *
 * @param board 该方场上的卡（顺序任意）
 * @param label 该方名称（渲染在左侧）
 */
export function renderRow(board: readonly BoardCard[], label: string): string[] {
  const cells: string[] = Array.from({ length: ROW_SLOTS }, (_unused, index) => `${String(index + 1)}`)
  const lines: string[] = []

  const ruler = (values: readonly string[]): string =>
    `│${values.map((value) => ` ${value.padEnd(4, ' ')}│`).join('')}`

  lines.push(`${label}`)
  lines.push(`┌${'────┬'.repeat(ROW_SLOTS - 1)}────┐`)
  lines.push(ruler(cells))
  lines.push(`├${'────┼'.repeat(ROW_SLOTS - 1)}────┤`)

  const row: string[] = Array.from({ length: ROW_SLOTS }, () => '·')
  for (const boardCard of [...board].sort((a, b) => a.slot - b.slot)) {
    const { from, to } = slotRange(boardCard)
    const label = boardCard.destroyed ? `${boardCard.card.id}(失效)` : boardCard.card.id
    if (from === to) {
      row[from - 1] = label.length > 4 ? label.slice(0, 4) : label
    } else {
      // 多格卡：左端写名字、右端写箭头、中间写横线，肉眼可见占了几格
      for (let slot = from; slot <= to; slot += 1) {
        if (slot === from) row[slot - 1] = label.length > 4 ? label.slice(0, 4) : label
        else if (slot === to) row[slot - 1] = '→'
        else row[slot - 1] = '—'
      }
    }
  }
  lines.push(ruler(row))
  lines.push(`└${'────┴'.repeat(ROW_SLOTS - 1)}────┘`)
  return lines
}

/** 某方场上"还活着（未失效）"的卡，按 slot 升序 */
export function activeCards(board: readonly BoardCard[]): BoardCard[] {
  return board.filter((boardCard) => !boardCard.destroyed).sort((a, b) => a.slot - b.slot)
}

/** size 的中文名（日志用） */
export function sizeLabel(size: CardSize): string {
  switch (size) {
    case 'small':
      return '小'
    case 'medium':
      return '中'
    case 'large':
      return '大'
  }
}
