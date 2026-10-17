// 技能位**共用表现层**：编辑态（可点、可移除）与回放态（只读 + 触发高亮 + 计数）是同一个组件。

// 为什么合并（《前端设计.md》§6.3 / §6.5）：同一件东西在两处各写一份，改一处忘一处；
// 两种模式只差三件事 —— 能不能点、显示几个位、有没有"本帧触发次数"。

// 图标口径（v0.13，《[审阅.md](../../../docs/审阅.md)》§U）：
//   · **有图用图、没图回落技能名首字** —— 图来自 `packs/<包>/images/skills/<skill_id>.png`
//     （文件名约定，技能**不写** `icon` 字段）；缺图 / 加载失败**不阻塞**（与卡图同一套回落）；
//   · 用户自定义的图**尺寸不限** ⇒ 用 `object-fit: cover`（按比例放大铺满、超出的裁掉、**不拉变形**），
//     再靠 `border-radius: 50%` 裁成圆形（RW：「各种尺寸的图…做一下拉伸然后再裁剪」）。
//
// 版式（v0.17，《[审阅.md](../../../docs/审阅.md)》§V.1 = A）：技能位是**一行横向滚动窗口** ——
//   **不换行、不折叠「+n」**（技能再多也只是多滚一点）；编辑态在**末尾固定一个「+」位**开选择浮层；
//   滚动条不显示（纯 CSS，见 `styles.css` 的 `.skill-slots`）。
import { useEffect, useRef } from 'react'
import type { Skill } from '../../../engine/types.ts'
import { CardImage } from '../../components/CardImage.tsx'

interface SkillSlotsProps {
  /** `edit` = 可点（空位开选择浮层、已选点了移除）；`replay` = 只读 */
  readonly mode: 'edit' | 'replay'
  /** 已选技能（顺序即显示顺序） */
  readonly chosen: readonly Skill[]
  /**
   * 显示多少个**位**。
   * - **编辑态**：传「已选数 + 1」⇒ 末尾固定一个**「+」位**（点它开选择浮层）；
   * - **回放态**：不传 ⇒ 只画已选的（横向滚动、个数不限）。
   */
  readonly capacity?: number | undefined
  /** 回放态：技能 id → 本帧触发次数（> 0 就描边 + 右下角计数） */
  readonly counts?: ReadonlyMap<string, number> | undefined
  /** 图标 URL（`images/skills/<skill_id>.png`）；`null` = 没有图 ⇒ 回落技能名首字 */
  readonly iconUrlOf: (skillId: string) => string | null
  /** 编辑态：点空位（开选择浮层） */
  readonly onOpenPicker?: (() => void) | undefined
  /** 编辑态：点已选技能（移除） */
  readonly onRemove?: ((skillId: string) => void) | undefined
}

export function SkillSlots({ mode, chosen, capacity, counts, iconUrlOf, onOpenPicker, onRemove }: SkillSlotsProps) {
  const strip = useRef<HTMLDivElement | null>(null)
  const filled = capacity === undefined ? chosen : chosen.slice(0, capacity)
  const slotCount = capacity === undefined ? filled.length : capacity

  // **编辑态**在技能增删后把窗口**滚到末尾**：滚动条是隐藏的（§V.1 的 ★默认），不自动跟过去的话
  // 末尾那个「+」位与刚加的技能会在视野外、用户不知道要往右滚。
  // 回放态**不自动滚**（技能是整局的，从头看起才对）。
  useEffect(() => {
    if (mode !== 'edit') return
    const element = strip.current
    if (element === null) return
    element.scrollLeft = element.scrollWidth
  }, [mode, slotCount])

  // 回放态且一个技能都没带 ⇒ 什么都不画（不留一个空 div 占位）
  if (slotCount === 0) return null

  return (
    <div ref={strip} className={mode === 'replay' ? 'skill-slots skill-slots-replay' : 'skill-slots'}>
      {Array.from({ length: slotCount }, (_, at) => {
        const skill = filled[at]

        // 空位：只有编辑态会走到这里（回放态的 slotCount === 已选数）
        // 编辑态的**末尾固定位**（RW §V.1 = A）：文案就是「+」，点它开选择浮层
        if (skill === undefined) {
          return (
            <button
              key={`empty-${String(at)}`}
              type="button"
              className="skill-slot skill-slot-add"
              title="点这里选技能"
              onClick={() => {
                onOpenPicker?.()
              }}
            >
              <span className="skill-slot-letter">+</span>
            </button>
          )
        }

        // 图标（有图用图、缺图 / 失败回落首字）；**图标本身不变形**，圆形裁切由 CSS 做
        const icon = <CardImage url={iconUrlOf(skill.id)} className="skill-icon" fallback={<span className="skill-slot-letter">{skill.name.slice(0, 1)}</span>} />
        const times = counts?.get(skill.id) ?? 0

        if (mode === 'replay') {
          return (
            <span
              key={skill.id}
              className={times > 0 ? 'skill-slot skill-slot-on' : 'skill-slot'}
              title={`${skill.name}${times > 0 ? `（本帧触发 ${String(times)} 次）` : ''}`}
            >
              {icon}
              {times > 0 && <i className="skill-slot-count">{String(times)}</i>}
            </span>
          )
        }

        return (
          <button
            key={skill.id}
            type="button"
            className="skill-slot skill-slot-on"
            title={`${skill.name}（点击移除）`}
            onClick={() => {
              onRemove?.(skill.id)
            }}
          >
            {icon}
          </button>
        )
      })}
    </div>
  )
}
