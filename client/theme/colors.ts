// 表现层配色表 —— **引擎永不产 ANSI / 颜色**，着色一律在这里（《前端设计.md》§7.4）。

// 五张表各自对应一个引擎词表 / 回放色调，键名与来源一致：
//   · `FLOATER_LOOK` = 回放的飘字色调（由时机词归并而来，见 `state/replay.ts`）；
//   · `EVENT_LOOK`   = 时机词 → 短标签（只用于飘字明细里给人看的那几个字）；
//   · `DOT_LOOK`     = 玩家侧持续效果 `DotKind`；
//   · `STATUS_LOOK`  = 卡牌状态 `CardStatusKind`；
//   · `STAT_ROW`     = 卡面数值行的**固定顺序与配色**（权威 = 《卡牌设计细化.md》§5）。
import type { CardStatusKind, DotKind } from '../../engine/types.ts'
import type { FloaterTone } from '../state/replay.ts'

/** 一个色调的显示口径 */
export interface ToneLook {
  readonly label: string
  readonly color: string
}

/**
 * 附魔的**内置回落色**（C4d）：附魔可以在卡面目录里写 `color: '#rrggbb'` 自定义；
 * 没写就用这个。**只用于表现层**，引擎判定不读任何颜色。
 */
export const ENCHANT_FALLBACK_COLOR = '#b197fc'

/** 飘字色调 → 标签 + 颜色 */
export const FLOATER_LOOK: Readonly<Record<FloaterTone, ToneLook>> = {
  damage: { label: '伤', color: '#ff6b6b' },
  heal: { label: '疗', color: '#69db7c' },
  shield: { label: '盾', color: '#4dabf7' },
  shieldBreak: { label: '破盾', color: '#ffa94d' },
  status: { label: '状态', color: '#ffd43b' },
  destroy: { label: '失效', color: '#adb5bd' },
  repair: { label: '修复', color: '#63e6be' },
}

/** 时机词 → 短标签（飘字明细里显示"这几点是哪来的"） */
export const EVENT_LOOK: Readonly<Record<string, string>> = {
  on_player_damaged: '直伤',
  on_player_healed: '治疗',
  on_shield_gained: '护盾',
  on_shield_broken: '破盾',
  on_burn_tick: '灼烧',
  on_poison_tick: '剧毒',
  on_regen_tick: '再生',
  on_card_frozen: '冰冻',
  on_card_hasted: '加速',
  on_card_slowed: '减速',
  on_card_charged: '充能',
  on_card_destroyed: '失效',
  on_card_repaired: '修复',
}

/** 持续效果 → 角标文字 + 颜色 */
export const DOT_LOOK: Readonly<Record<DotKind, ToneLook>> = {
  burn: { label: '灼', color: '#ff922b' },
  poison: { label: '毒', color: '#37b24d' },
  regen: { label: '生', color: '#8ce99a' },
}

/** 卡牌状态 → 角标文字 + 颜色 */
export const STATUS_LOOK: Readonly<Record<CardStatusKind, ToneLook>> = {
  haste: { label: '加', color: '#4dabf7' },
  slow: { label: '减', color: '#9775fa' },
  freeze: { label: '冻', color: '#74c0fc' },
}

/** 卡面数值行的一项：键名 / 显示名 / 颜色 */
export interface StatRowLook {
  readonly stat: string
  readonly label: string
  readonly color: string
}

/**
 * 卡面数值行的**固定顺序**：攻击 → 护盾 → 治疗 → 灼烧 → 剧毒 → 再生。
 *
 * **显示条件 = 该词条在 `FrameCard.stats` 里存在**（值为 0 也显示），不做数值判断；
 * **候选清单就是本表** —— 不在表里的键（`speed` / `haste` / `slow` / `freeze` / `charge` / `cdp`）
 * 一律不进数值行：速度是**状态读数**（有效倍率），交给底部状态角标与进度条，不再显示。
 */
export const STAT_ROW: readonly StatRowLook[] = [
  { stat: 'atk', label: '攻', color: '#c92a2a' },
  { stat: 'shield', label: '盾', color: '#ffd43b' },
  { stat: 'heal', label: '疗', color: '#69db7c' },
  { stat: 'burn', label: '灼', color: '#e8590c' },
  { stat: 'poison', label: '毒', color: '#2b8a3e' },
  { stat: 'regen', label: '生', color: '#8ce99a' },
]
