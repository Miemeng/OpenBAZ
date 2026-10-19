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
import { EmptyState } from '../../components/EmptyState.tsx'
import { buildAssetIndex } from '../../data/assets.ts'
import { isSideModified, type SideDraft, type SideValidation } from '../../state/simulateDraft.ts'
import type { DeckText } from '../../data/packSource.ts'
import { t } from '../../i18n/index.ts'
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
  /** 该侧可导入的**阵容文件清单**（当前 = `decks/` 下的全部文件 + 本次会话刚保存的） */
  readonly deckFiles: readonly DeckText[]
  /** 点清单里的一行 ⇒ 导入到**本侧** */
  readonly onImport: (deck: DeckText) => void
  /** 保存本侧：导出 YAML（下载）+ 复制到剪贴板，并把产物加进清单 */
  readonly onSave: () => void
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
  deckFiles,
  onImport,
  onSave,
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
          {/* 导入来源 + 是否已修改（「导入 = 拷贝」：编辑只改草稿，绝不回写文件） */}
          {draft.sourcePath !== undefined && (
            <span
              className="panel-source"
              title={isSideModified(draft) ? `来源：${draft.sourcePath}（已修改，不会写回原文件）` : `来源：${draft.sourcePath}`}
              style={{ marginLeft: 6, fontSize: 11, opacity: 0.75 }}
            >
              {isSideModified(draft) ? `${draft.sourcePath} · 已修改` : draft.sourcePath}
            </span>
          )}
        </h3>
        <select
          className="hero-select"
          value={draft.heroId ?? ''}
          onChange={(event) => {
            onHero(event.target.value === '' ? null : event.target.value)
          }}
        >
              <option value="">{t('panel.noHero')}</option>
          {heroes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}（{item.id}）
            </option>
          ))}
        </select>
      </header>

      {/* 阵容文件列表（**每侧一个**；临时形态 —— 上线后再考虑按二级菜单分类）：
          点一行 = 导入到**本侧**；「保存」= 导出本侧 YAML + 复制到剪贴板，并把产物加进清单 */}
      <div className="deck-files">
        <div className="deck-files-head">
          <span className="facet-label">
            {t('panel.deckFiles')} {String(deckFiles.length)}
          </span>
          <button type="button" className="chip" title={t('panel.saveTitle')} onClick={onSave}>
            {t('panel.save')}
          </button>
        </div>
        <ul className="deck-list">
          {deckFiles.length === 0 && (
            <li>
              <EmptyState main={t('panel.emptyDeckList')} />
            </li>
          )}
          {deckFiles.map((deck) => {
            const current = draft.sourcePath === deck.path
            return (
              <li key={deck.path}>
                <button
                  type="button"
                  className={current ? 'deck-item deck-item-current' : 'deck-item'}
                  title={
                    current
                      ? t('panel.currentDeckTitle', { path: deck.path })
                      : t('panel.importDeckTitle', { side, path: deck.path })
                  }
                  onClick={() => {
                    onImport(deck)
                  }}
                >
                  {deck.path.replace(/^decks\//u, '')}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

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
              {t('panel.hp')}
              <input
                className="hp-input"
                inputMode="numeric"
                placeholder={hero === undefined ? t('panel.heroDefault') : String(hero.initHp)}
                value={draft.hpText}
                onChange={(event) => {
                  onHp(event.target.value, draft.maxHpText)
                }}
              />
            </label>
            <label>
              {t('panel.maxHp')}
              <input
                className="hp-input"
                inputMode="numeric"
                placeholder={hero === undefined ? t('panel.heroDefault') : String(hero.initMaxHp)}
                value={draft.maxHpText}
                onChange={(event) => {
                  onHp(draft.hpText, event.target.value)
                }}
              />
            </label>
          </div>
          <p className="hp-effective">
            {t('panel.effective')}：{validation.resolved === undefined ? '—' : `${String(validation.resolved.hp)} / ${String(validation.resolved.maxHp)}`}
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
          <p className="skill-picker-title">{t('panel.skillPicker')}</p>
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
                  <span>{skill.description ?? t('panel.skillNoDesc')}</span>
                </button>
              </li>
            ))}
            {skills.length === 0 && <li className="hint">{t('panel.noSkills')}</li>}
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
