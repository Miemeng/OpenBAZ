// 玩家面板**表现层**。

// 三件事：
//   ① **角色**：下拉（来源 = 各包已注册的角色）+ 头像 —— 头像是**文件名约定**，
//      读取层**不校验图片** ⇒ 必须有缺省头像（首字色块 + 头像加载失败即回落）；
//   ② **血量**：`hp` / `maxHp` 两个覆盖输入框（留空 = 用角色默认；三级优先由 `cards/deck.ts` 算，
//      面板只**显示**它算出来的生效值 —— 前端不复刻优先级规则）；
//   ③ **技能**：紧跟头像右侧的**一行横向滚动窗口**（不换行、不折叠「+n」），末尾固定一个「+」位开选择浮层；
//      点已选技能即移除。**数量不限**。技能位本体是共用组件 `SkillSlots`（回放态同一份，见 §6.3 / §6.5）。
import { useMemo, useState } from 'react'
import type { LoadedPack } from '../../../cards/types.ts'
import type { CardRegistry } from '../../../cards/registry.ts'
import { CardImage } from '../../components/CardImage.tsx'
import { buildAssetIndex } from '../../data/assets.ts'
import type { SideDraft, SideValidation } from '../../state/simulateDraft.ts'
import { SkillSlots } from './SkillSlots.tsx'

interface PlayerPanelProps {
  readonly side: 'A' | 'B'
  readonly name: string
  readonly draft: SideDraft
  readonly packs: readonly LoadedPack[]
  readonly registry: CardRegistry
  readonly validation: SideValidation
  readonly onHero: (heroId: string | null) => void
  readonly onHp: (hpText: string, maxHpText: string) => void
  readonly onToggleSkill: (skillId: string) => void
}

export function PlayerPanel({
  side,
  name,
  draft,
  packs,
  registry,
  validation,
  onHero,
  onHp,
  onToggleSkill,
}: PlayerPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const assets = useMemo(() => buildAssetIndex(packs), [packs])

  const heroes = packs.flatMap((pack) => pack.heroes)
  const skills = packs.flatMap((pack) => pack.skills)
  const hero = draft.heroId === null ? undefined : registry.getHero(draft.heroId)
  const chosen = draft.skills
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is (typeof skills)[number] => skill !== undefined)

  /** 头像 URL（`null` = 没选角色 / 找不到包 ⇒ 首字色块回落） */
  const avatarUrl = hero === undefined ? null : assets.heroAvatar(hero.id)
  /** 技能图标（`images/skills/<skill_id>.png`；缺图回落技能名首字） */
  const skillIconUrlOf = (skillId: string): string | null => assets.skillIcon(skillId)

  return (
    <section className="panel">
      <header className="panel-head">
        <h3>
          玩家{side} <span className="panel-name">{name}</span>
        </h3>
        <select
          className="hero-select"
          value={draft.heroId ?? ''}
          onChange={(event) => {
            onHero(event.target.value === '' ? null : event.target.value)
          }}
        >
          <option value="">（未选角色）</option>
          {heroes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}（{item.id}）
            </option>
          ))}
        </select>
      </header>

      {/* **一行**：头像 + 血量（左）→ 技能横向滚动窗口（右）。
          RW §V.1 = A：不再"左侧一列 / 右侧一列"，也**不再折叠「+n」** —— 技能多了就在窗口里横向滚。 */}
      <div className="panel-body">
        <div className="avatar-wrap">
          <CardImage
            url={avatarUrl}
            className="avatar"
            alt={hero === undefined ? '' : hero.name}
            fallback={
              <div className="avatar avatar-fallback" title={hero === undefined ? '未选角色' : '缺省头像（图片缺失）'}>
                {hero === undefined ? '?' : hero.name.slice(0, 1)}
              </div>
            }
          />
          <div className="hp-row">
            <label>
              血量
              <input
                className="hp-input"
                inputMode="numeric"
                placeholder={hero === undefined ? '角色默认' : String(hero.initHp)}
                value={draft.hpText}
                onChange={(event) => {
                  onHp(event.target.value, draft.maxHpText)
                }}
              />
            </label>
            <label>
              上限
              <input
                className="hp-input"
                inputMode="numeric"
                placeholder={hero === undefined ? '角色默认' : String(hero.initMaxHp)}
                value={draft.maxHpText}
                onChange={(event) => {
                  onHp(draft.hpText, event.target.value)
                }}
              />
            </label>
          </div>
          <p className="hp-effective">
            生效：{validation.resolved === undefined ? '—' : `${String(validation.resolved.hp)} / ${String(validation.resolved.maxHp)}`}
          </p>
        </div>

        {/* 技能：紧跟头像右侧的**横向滚动窗口**，末尾固定一个「+」位（点它开选择浮层）。
            技能再多也只是多滚一点 —— **不换行、不折叠**（RW §V.1 = A）。 */}
        <SkillSlots
          mode="edit"
          chosen={chosen}
          capacity={chosen.length + 1}
          iconUrlOf={skillIconUrlOf}
          onOpenPicker={() => {
            setPickerOpen(true)
          }}
          onRemove={onToggleSkill}
        />
      </div>

      {pickerOpen && (
        <div className="skill-picker">
          <p className="skill-picker-title">选技能（可多选，点已选技能移除）</p>
          <ul className="skill-picker-list">
            {skills.map((skill) => (
              <li key={skill.id}>
                {/* U.6 = 不上图标，**写技能名 + 效果**（RW：「写技能名加效果即可」） */}
                <button
                  type="button"
                  className={draft.skills.includes(skill.id) ? 'skill-picker-item skill-picker-item-on' : 'skill-picker-item'}
                  onClick={() => {
                    onToggleSkill(skill.id)
                  }}
                >
                  <b>{skill.name}</b>
                  <span>{skill.description ?? '（这条技能没写 description）'}</span>
                </button>
              </li>
            ))}
            {skills.length === 0 && <li className="hint">没有已注册的技能</li>}
          </ul>
          <button
            type="button"
            className="chip chip-clear"
            onClick={() => {
              setPickerOpen(false)
            }}
          >
            完成
          </button>
        </div>
      )}

      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <ul className="panel-issues">
          {validation.errors.map((issue, index) => (
            <li key={`e-${String(index)}`} className="issue-error">
              {issue.message}
            </li>
          ))}
          {validation.warnings.map((issue, index) => (
            <li key={`w-${String(index)}`} className="issue-warn">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
