// **词表 id → 人话**（《审阅.md》§AG.9 = C）：只在**前端显示**时用。
//
// 口径：CLI 日志与校验报错**保持 id**（好 grep、能指回 YAML 字段）；悬浮窗 / 卡牌库这类
// 玩家向的文本才换成中文说法。所以本模块只被 `client/` 的渲染层调用。
//
// 边界：`self.atk` 这类**引用路径不翻**（用负向断言排除 id 后面跟 `.` 的情况），
// 免得把可机读的路径变成"自身.攻击"。

/** 词表 id → 中文说法（原语 9 / 时机词 17 / 选择器 13 / 常用数值位） */
export const TERM_LABELS: Readonly<Record<string, string>> = {
  // —— 动作原语（9）——
  deal_damage: '造成伤害',
  heal_player: '治疗玩家',
  gain_stat: '属性增减',
  shield: '护盾',
  apply_status: '施加状态',
  charge: '充能',
  destroy: '使失效',
  repair: '修复',
  enchant: '施加附魔',

  // —— 时机词（17）——
  battle_start: '战斗开始',
  battle_end: '战斗结束',
  before_action: '行动前',
  after_action: '行动后',
  on_player_damaged: '玩家受伤',
  on_player_healed: '玩家回血',
  on_shield_gained: '获得护盾时',
  on_shield_broken: '护盾击穿时',
  on_card_destroyed: '卡牌失效时',
  on_card_repaired: '卡牌修复时',
  on_card_frozen: '被冰冻时',
  on_card_hasted: '被加速时',
  on_card_slowed: '被减速时',
  on_card_charged: '被充能时',
  on_burn_tick: '灼烧结算',
  on_poison_tick: '剧毒结算',
  on_regen_tick: '再生结算',

  // —— 选择器缩写（13）——
  self: '自身',
  own_player: '己方玩家',
  enemy_player: '敌方玩家',
  all_players: '全体玩家',
  all_own_cards: '全体友方卡牌',
  all_enemy_cards: '全体敌方卡牌',
  all_cards: '场上所有卡牌',
  event_card: '事件来源卡',
  random_own_card: '随机友方卡牌',
  random_enemy_card: '随机敌方卡牌',
  adjacent_to_self: '与自己相邻的卡牌',
  adjacent_left_self: '自己左侧的卡牌',
  adjacent_right_self: '自己右侧的卡牌',

  // —— 数值位（显示用；与 stats 词表同名）——
  atk: '攻击',
  heal: '治疗',
  burn: '灼烧',
  poison: '剧毒',
  regen: '再生',
  speed: '速度',
  cdp: '冷却系数',
  value: '价值',

  // —— 状态值（`status=haste` 这类参数值）——
  haste: '加速',
  slow: '减速',
  freeze: '冰冻',
}

/** 长的先匹配（`heal_player` 必须先于 `heal`），否则短词会把长词拆掉 */
const KEYS = Object.keys(TERM_LABELS).sort((left, right) => right.length - left.length)

/** 正则转义（词表里目前都是 `[a-z_]`，转义只是为了将来加词时不踩坑） */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 词表 id 的匹配式：两侧不能紧邻 `[A-Za-z0-9_.]`。
 *
 * 两侧都带 `.` 很关键：`self.atk` / `own_player.hp_pct` 是**引用路径**，必须整段保持原样 ——
 * 只排除右侧会得到 `self.攻击`（曾经就是这个 bug）。
 */
const PATTERN = new RegExp(
  `(?<![A-Za-z0-9_.])(?:${KEYS.map(escapeForRegExp).join('|')})(?![A-Za-z0-9_.])`,
  'gu',
)

/**
 * 把一段文本里的词表 id 换成中文说法（未登记的 id 原样保留）。
 *
 * @param text 触发器 / 结果侧的文本（来自 `summaryLines()`）
 * @returns 给人看的文本
 */
export function humanizeTerms(text: string): string {
  return text.replace(PATTERN, (matched: string) => TERM_LABELS[matched] ?? matched)
}
