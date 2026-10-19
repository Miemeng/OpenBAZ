// 词表 id → 人话的单元测试：钉住"该翻的翻、不该翻的不动"。

import { describe, expect, it } from 'vitest'

import { humanizeTerms, TERM_LABELS } from './terms.ts'

describe('humanizeTerms（词表 id → 人话）', () => {
  it('原语 / 时机词 / 选择器都能翻', () => {
    expect(humanizeTerms('时机 on_player_damaged')).toBe('时机 玩家受伤')
    expect(humanizeTerms('deal_damage 作用于 all_enemy_cards')).toBe('造成伤害 作用于 全体敌方卡牌')
    expect(humanizeTerms('apply_status')).toBe('施加状态')
  })

  it('长词优先：heal_player 不会被 heal 拆坏', () => {
    expect(humanizeTerms('heal_player')).toBe('治疗玩家')
    expect(humanizeTerms('heal')).toBe('治疗')
  })

  it('引用路径不翻（id 后面跟点号）', () => {
    expect(humanizeTerms('数额=self.atk')).toBe('数额=self.atk')
    expect(humanizeTerms('own_player.hp_pct')).toBe('own_player.hp_pct')
  })

  it('参数值里的状态名也能翻（status=haste ⇒ status=加速）', () => {
    expect(humanizeTerms('status=haste')).toBe('status=加速')
    expect(humanizeTerms('status=freeze')).toBe('status=冰冻')
  })

  it('自定义 id / 未登记词原样保留（不会误伤 my_deal_damage）', () => {
    expect(humanizeTerms('my_deal_damage')).toBe('my_deal_damage')
    expect(humanizeTerms('some_unknown_thing')).toBe('some_unknown_thing')
  })

  it('词表内部自洽：没有把同一个中文说法挂在两个不同 id 上（除已知同义）', () => {
    const labels = Object.values(TERM_LABELS)
    expect(labels.length).toBeGreaterThan(30)
    // shield（护盾）同时是原语与数值位 —— 允许重复，其余一律唯一
    const duplicated = labels.filter((label, at) => labels.indexOf(label) !== at)
    expect(duplicated.every((label) => label === '护盾' || label === '灼烧' || label === '剧毒' || label === '再生')).toBe(true)
  })
})
