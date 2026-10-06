// 硬编码示例卡组（**临时**，仅用于 P0.6 最小可跑版）
//
// 为什么会有这个文件（RW 指示，逐条落实）：
// 1. "硬编码暂时留着，注释明确，把主流程测试结束后，马上着手进行 yaml 读取的部分" ——
//    故本文件顶部即声明它是临时产物；YAML 读取（P0.6-E / P0.6-C）落地后**整体删除**，
//    卡牌一律从 `packs/<pack_id>/cards/*.yml` 读取。
// 2. "core 卡包仅作示例，后续基础卡包内不含" —— 下面 5 张卡是**示例卡**，
//    将来基础卡包（正式发布的基础内容）中**不包含**这些卡。
// 3. 数值全部标【平衡待定】：AGENT.md §9 第 5 条——只实现机制、不填平衡数值。
//
// 这 5 张卡同时是**机制覆盖样例**：用它跑一局，8 个动作原语与 3 类持续效果全部会出现在日志里，
// 便于一次肉眼验证整条链路：
//   deal_damage（主动/被动）  heal_player（field_medic）  shield（iron_guard）  gain_stat（ember_priest 的 burn/poison）
//   apply_status（ash_runner 的 haste）  charge（bastion_smith）  destroy（bastion_smith 被动）+ repair（field_medic 被动）
// 位置：每张卡都写明 `slot`（左端所在格，1–10），占格数由 size 推导（小 1 / 中 2 / 大 3）。
import type { Card, Skill } from '../engine/types.ts'
import type { Placement } from '../engine/board.ts'

const CINDER_WOLF: Card = {
  id: 'cinder_wolf',
  name: '灰烬狼',
  version: 1,
  size: 'small',
  cooldown: 100, // 【平衡待定】1.00s → 100cs（引擎内部时间量一律为整数 cs）
  rarity: 'bronze',
  description: '示例卡：最快的攻击手，用来观察行动条节奏',
  stats: { atk: 40 }, // 【平衡待定】
  tags: [],
  // 规则 §1：卡牌**没有内置普攻**，`stats.atk` 只是一个可被 buff 的数值，
  // 想把它打成伤害必须由卡面显式写一条 deal_damage（此前靠引擎自动拼接，已移除）。
  abilities: [
    {
      id: 1,
      kind: 'active',
      actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
    },
  ],
}

const IRON_GUARD: Card = {
  id: 'iron_guard',
  name: '铁卫',
  version: 1,
  size: 'large', // 大卡：占连续 3 格
  cooldown: 250, // 【平衡待定】2.50s → 250cs
  rarity: 'silver',
  description: '示例卡：大体积慢速，每次行动造成伤害，每 3 次主动行动给自己套护盾',
  stats: { atk: 80, shd: 120 }, // 【平衡待定】
  tags: [],
  abilities: [
    {
      id: 1,
      kind: 'active',
      actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
    },
    {
      // 与 id 1 共用同一行动条与同一 actionCount：第 3、6、9… 次行动额外套盾
      id: 2,
      kind: 'active',
      every_n: 3,
      actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shd' } }],
    },
  ],
}

const ASH_RUNNER: Card = {
  id: 'ash_runner',
  name: '踏灰者',
  version: 1,
  size: 'small',
  cooldown: 150, // 【平衡待定】1.50s → 150cs
  rarity: 'bronze',
  description: '示例卡：造成伤害 + 给自己加速',
  stats: { atk: 6, has: 3 }, // 【平衡待定】has 是卡牌自带数值（作为 apply_status 的 duration 使用时按**秒**解释）
  tags: [],
  abilities: [
    {
      id: 1,
      kind: 'active',
      actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
    },
    {
      id: 2,
      kind: 'active',
      actions: [{ do: 'apply_status', target: 'self', status: 'haste', duration: { ref: 'self.has' } }],
    },
  ],
}

const EMBER_PRIEST: Card = {
  id: 'ember_priest',
  name: '余烬祭司',
  version: 1,
  size: 'medium', // 中卡：占连续 2 格
  cooldown: 200, // 【平衡待定】2.00s → 200cs
  rarity: 'gold',
  description: '示例卡：造成伤害，给敌方玩家施加剧毒和灼烧',
  stats: { atk: 30, bur: 4, poi: 5 }, // 【平衡待定】
  tags: [],
  abilities: [
    {
      id: 1,
      kind: 'active',
      actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
    },
    {
      id: 2,
      kind: 'active',
      actions: [
        { do: 'gain_stat', stat: 'poison', amount: { ref: 'self.poi' }, target: 'enemy_player' },
        { do: 'gain_stat', stat: 'burn', amount: { ref: 'self.bur' }, target: 'enemy_player' },
      ],
    },
  ],
}

const FIELD_MEDIC: Card = {
  id: 'field_medic',
  name: '战地医师',
  version: 1,
  size: 'medium',
  // 纯被动物品（规则 §5）：无行动条、无主动行动。数值必须是 -1 —— 此前误写为 200，
  // 在没有"缺主动效果"校验时它会每天真地被判满条并空转一次行动。
  cooldown: -1,
  rarity: 'silver',
  description: '示例卡：纯被动（cooldown = -1），本方玩家受伤时治疗本方玩家',
  stats: { hel: 14, reg: 3 }, // 【平衡待定】
  abilities: [
    {
      id: 1,
      kind: 'passive',
      priority: 6, // 数值大者优先；缺省 5
      trigger: { event: 'on_player_damaged' },
      condition: { cmp: 'lt', left: { ref: 'own_player.hp_pct' }, right: 1 },
      actions: [
        { do: 'heal_player', target: 'own_player', amount: { ref: 'self.hel' } },
        { do: 'gain_stat', stat: 'regen', amount: { ref: 'self.reg' }, target: 'own_player' },
        // 同时修复相邻卡：让 repair 原语也能被跑到（被 destroy 的相邻卡恢复）
        { do: 'repair', target: 'adjacent_to_self' },
      ],
    },
  ],
}

const BASTION_SMITH: Card = {
  id: 'bastion_smith',
  name: '壁垒工匠',
  version: 1,
  size: 'medium',
  cooldown: 300, // 【平衡待定】3.00s → 300cs
  rarity: 'diamond',
  description: '示例卡：造成伤害并给相邻卡充能、给自己套盾；敌方受伤时失效敌方最左卡',
  stats: { atk: 5, shd: 6 }, // 【平衡待定】
  tags: [],
  abilities: [
    {
      id: 1,
      kind: 'active',
      actions: [{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }],
    },
    {
      id: 2,
      kind: 'active',
      actions: [
        { do: 'charge', target: 'adjacent_to_self', seconds: 0.5 },
        { do: 'shield', target: 'own_player', amount: { ref: 'self.shd' } },
      ],
    },
    {
      id: 3,
      kind: 'passive',
      priority: 4, // 低于 field_medic 的 6：验证"数值大者优先"
      trigger: { event: 'on_player_damaged' },
      actions: [{ do: 'destroy', target: 'random_enemy_card' }],
    },
  ],
}

// —— 摆盘（含位置）——
// A 方：1 灰烬狼 / 3–5 铁卫（大卡 3 格）/ 7–8 余烬祭司（中卡 2 格）
// B 方：2 踏灰者 / 4–5 战地医师（中卡 2 格）/ 7–9 壁垒工匠（中卡 2 格 → 占 7、8）
const DECK_A: readonly Placement[] = [
  { card: CINDER_WOLF, slot: 1 },
  { card: IRON_GUARD, slot: 3 },
  { card: EMBER_PRIEST, slot: 7 },
]
const DECK_B: readonly Placement[] = [
  { card: ASH_RUNNER, slot: 2 },
  { card: FIELD_MEDIC, slot: 4 },
  { card: BASTION_SMITH, slot: 7 },
]

// 技能样例：三条技能，priority 与时机词都不同，验证"同优先级时技能后于卡牌被动结算"
// 以及"技能只在 trigger 命中的触发帧结算"。
//
// 【平衡待定】stats 数值仅用于观察链路：`ember_oath` 给敌方玩家叠 3 点灼烧（`gain_stat` 走
// `applyDot` 叠加），`second_wind`/`grave_pact` 各给本方玩家 +20 护盾。绑上 trigger 后
// 三者都只在 battle_start 结算一次，不再每帧反复结算。
const SKILLS_A: readonly Skill[] = [
  {
    id: 'ember_oath',
    name: '余烬誓约',
    version: 1,
    priority: 5,
    description: '示例技能：开局给敌方玩家叠灼烧',
    trigger: { event: 'battle_start' },
    stats: { bur: 3 },
    actions: [{ do: 'gain_stat', stat: 'burn', amount: { ref: 'self.bur' }, target: 'enemy_player' }],
  },
  {
    id: 'second_wind',
    name: '再起之风',
    version: 1,
    priority: 7,
    description: '示例技能：开局给本方玩家护盾',
    trigger: { event: 'battle_start' },
    stats: { shd: 20 },
    actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shd' } }],
  },
]
const SKILLS_B: readonly Skill[] = [
  {
    id: 'grave_pact',
    name: '墓约',
    version: 1,
    priority: 7,
    description: '示例技能：开局给本方玩家护盾',
    trigger: { event: 'battle_start' },
    stats: { shd: 20 },
    actions: [{ do: 'shield', target: 'own_player', amount: { ref: 'self.shd' } }],
  },
]

export { DECK_A, DECK_B, SKILLS_A, SKILLS_B }
