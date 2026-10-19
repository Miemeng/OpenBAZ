// 效果行切分的单元测试：钉住"标签 / 触发器 / 结果"三段的判据（《卡面表现设计.md》§4.3）

import { describe, expect, it } from 'vitest'

import { arrowToTri, parseEffectLine, resolveStatRefs } from './effectLine.ts'

describe('parseEffectLine（效果行三段切分）', () => {
  it('被动：标签 + 时机 → 动作', () => {
    expect(parseEffectLine('  [被动 P10] 时机 on_player_damaged → deal_damage 5')).toEqual({
      tag: '被动 P10',
      trigger: '时机 on_player_damaged',
      result: 'deal_damage 5',
      raw: '[被动 P10] 时机 on_player_damaged → deal_damage 5',
    })
  })

  it('主动：行动条充满时 → 动作，且带 everyN / 条件的部分留在触发器侧', () => {
    const parts = parseEffectLine('[主动] 行动条充满时（每 2 次），条件 self.hp < 50 → shield 12')
    expect(parts.tag).toBe('主动')
    expect(parts.trigger).toBe('行动条充满时（每 2 次），条件 self.hp < 50')
    expect(parts.result).toBe('shield 12')
  })

  it('没有箭头（光圈 / 附魔属性行）：整行正文进 trigger、result 为 null', () => {
    expect(parseEffectLine('  [光环] 作用于 all_own_cards，平铺 atk+3')).toEqual({
      tag: '光环',
      trigger: '作用于 all_own_cards，平铺 atk+3',
      result: null,
      raw: '[光环] 作用于 all_own_cards，平铺 atk+3',
    })
  })

  it('没有标签：不造标签、不丢内容', () => {
    expect(parseEffectLine('deal_damage → own_player')).toEqual({
      tag: null,
      trigger: 'deal_damage',
      result: 'own_player',
      raw: 'deal_damage → own_player',
    })
  })

  it('箭头在行首（动作日志的那种）：触发器侧为空串、不抛异常', () => {
    const parts = parseEffectLine('→ 玩家B，灼烧 3 层')
    expect(parts.tag).toBeNull()
    expect(parts.trigger).toBe('')
    expect(parts.result).toBe('玩家B，灼烧 3 层')
  })

  it('空行：全部为空、不抛异常', () => {
    expect(parseEffectLine('   ')).toEqual({ tag: null, trigger: '', result: null, raw: '' })
  })
})

describe('arrowToTri（渲染期换字形）', () => {
  it('把每个箭头换成三角形，其它字符不动', () => {
    expect(arrowToTri('→ 玩家A → 玩家B')).toBe('▶ 玩家A ▶ 玩家B')
  })

  it('没有箭头时原样返回', () => {
    expect(arrowToTri('本回合无结算')).toBe('本回合无结算')
  })
})

describe('resolveStatRefs（把 self.<stat> 解析成数字）', () => {
  it('已知引用换成数值（编辑态 / 卡牌库没有战斗状态也能显示数字）', () => {
    expect(resolveStatRefs('数额=self.atk，时长=self.haste秒', { atk: 8, haste: 2 })).toBe('数额=8，时长=2秒')
  })

  it('未知引用与其它文本原样保留（技能 stats / 帧里没有的键）', () => {
    expect(resolveStatRefs('数额=self.nope', { atk: 8 })).toBe('数额=self.nope')
    expect(resolveStatRefs('作用于 own_player', {})).toBe('作用于 own_player')
  })
})
