// 效果行自然句的单元测试（F9 = A）：钉住"九条原语各说成什么"、"目标怎么叫"、以及表达不了时**回落 null**。
//
// 这里只测**显示层**：同一份动作在 CLI 侧仍打参数式文本（`SummaryLine.text`），本文件不涉及。

import { describe, expect, it } from 'vitest'

import type { ActionSpec } from '../../engine/types.ts'
import { resolveStatRefs } from '../state/effectLine.ts'
import { amountText, naturalAction, naturalActions, naturalTriggerText, targetText } from './effectText.ts'
import { humanizeTerms } from './terms.ts'

describe('naturalActions（动作 → 自然句）', () => {
  it('九条原语各一句（目标 / 数值 / 时长 / 附魔都写进去）', () => {
    expect(naturalAction({ do: 'deal_damage', target: 'enemy_player', amount: 8 })).toBe('对 敌方玩家 造成 8 点伤害')
    expect(naturalAction({ do: 'heal_player', target: 'own_player', amount: 5 })).toBe('为 己方玩家 回复 5 点生命')
    expect(naturalAction({ do: 'shield', target: 'all_own_cards', amount: 4 })).toBe('为 全体友方卡牌 施加 4 点护盾')
    expect(naturalAction({ do: 'gain_stat', target: 'self', stat: 'atk', amount: 2 })).toBe('使 自身 的 攻击 增加 2')
    expect(naturalAction({ do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', seconds: 2 })).toBe(
      '对 全体敌方卡牌 施加 冰冻 2 秒',
    )
    expect(naturalAction({ do: 'charge', target: 'self', seconds: 3 })).toBe('为 自身 推进 3 秒行动条')
    expect(naturalAction({ do: 'destroy', target: 'random_enemy_card' })).toBe('使 随机敌方卡牌 失效')
    expect(naturalAction({ do: 'repair', target: 'all_own_cards' })).toBe('修复 全体友方卡牌')
    expect(naturalAction({ do: 'enchant', target: 'self', enchant: 'sunfire' })).toBe('对 自身 施加附魔「sunfire」')
  })

  it('属性负值写成"减少"，没写的时长不硬编一句', () => {
    expect(naturalAction({ do: 'gain_stat', target: 'self', stat: 'atk', amount: -2 })).toBe('使 自身 的 攻击 减少 2')
    expect(naturalAction({ do: 'apply_status', target: 'self', status: 'haste' })).toBe('对 自身 施加 加速')
  })

  it('13 条选择器缩写都有中文说法', () => {
    const expected: Readonly<Record<string, string>> = {
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
    }
    for (const [selector, label] of Object.entries(expected)) {
      expect(targetText(selector)).toBe(label)
    }
  })

  it('查询对象（高级写法）回落成「符合『…』的目标」，不显示成空白', () => {
    expect(naturalAction({ do: 'deal_damage', target: { side: 'enemy', zone: 'cards' }, amount: 3 })).toBe(
      '对 符合「{side=enemy, zone=cards}」的目标 造成 3 点伤害',
    )
  })

  it('数值引用原样写 self.<stat>，由 resolveStatRefs 在渲染前换成数字', () => {
    const text = naturalActions([{ do: 'deal_damage', target: 'enemy_player', amount: { ref: 'self.atk' } }])
    expect(text).toBe('对 敌方玩家 造成 self.atk 点伤害')
    expect(resolveStatRefs(text ?? '', { atk: 8 })).toBe('对 敌方玩家 造成 8 点伤害')
    // 同上：时长引用（`self.freeze` / `self.slow`）也要换成数字 —— hover 窗必须给**全部**数值，不只是数值行那六项
    const frozen = naturalActions([
      { do: 'apply_status', target: 'all_enemy_cards', status: 'freeze', seconds: { ref: 'self.freeze' } },
    ])
    expect(resolveStatRefs(frozen ?? '', { freeze: 3 })).toBe('对 全体敌方卡牌 施加 冰冻 3 秒')
  })

  it('触发器的条件表达式翻成人话（$引用 / count(…) / 比较符）', () => {
    expect(
      humanizeTerms(
        naturalTriggerText('时机 on_player_damaged，条件（$player == enemy_player 或 count(all_enemy_cards) > 1）'),
      ),
    ).toBe('时机 玩家受伤，条件（事件玩家 是 敌方玩家 或 全体敌方卡牌 的数量 > 1）')
    expect(naturalTriggerText('$card hp_pct <= 50 且 $player != own_player')).toBe(
      '事件卡牌 hp_pct ≤ 50 且 事件玩家 不是 own_player',
    )
    // 未登记的引用名不吞掉，写成"事件参数 x"
    expect(naturalTriggerText('$unknown_thing >= 2')).toBe('事件参数 unknown_thing ≥ 2')
  })

  it('多条动作用「；」并列；表达不了（未知原语 / 空数组）返回 null 交给调用方回落', () => {
    expect(
      naturalActions([
        { do: 'deal_damage', target: 'enemy_player', amount: 8 },
        { do: 'apply_status', target: 'enemy_player', status: 'slow', seconds: 2 },
      ]),
    ).toBe('对 敌方玩家 造成 8 点伤害；对 敌方玩家 施加 减速 2 秒')
    expect(naturalActions([])).toBeNull()
    const unknown = { do: 'future_primitive' } as unknown as ActionSpec
    expect(naturalAction(unknown)).toBeNull()
    expect(naturalActions([unknown])).toBeNull()
  })

  it('四则 / 计数这类表达式也能读（不崩、不出现 undefined）', () => {
    expect(amountText({ add: [3, 2] })).toBe('3 + 2')
    expect(amountText({ sub: [8, 2] })).toBe('8 − 2')
    expect(amountText({ count: 'all_enemy_cards' })).toBe('全体敌方卡牌 的数量')
    expect(amountText(undefined)).toBeNull()
  })
})
