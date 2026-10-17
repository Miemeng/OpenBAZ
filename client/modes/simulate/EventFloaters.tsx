// 飘字层**表现层**：把"这一帧发生了什么"画在**锚点内部**。

// 三条口径：
//   · 数据 = `state/replay.ts` 的 `buildFloaters()`（同帧同目标同色调已合并，明细在 `parts` 里）；
//   · **贴在锚点内部**（玩家面板 / 卡面各自 `position: relative`）—— 不做坐标换算、不测量 rect，
//     锚点滚到哪它就跟到哪；
//   · 节点 key 只由「锚点 + 色调 + 发生时刻」决定 ⇒ 同一帧重渲染**不重播动画**，
//     只有游标真的前进时才挂新节点（"同一局重复播放逐帧相同"靠它成立）。
//     动画时长来自 `REPLAY_ANIM`；位移与缓动在 `client/styles.css` 的 `.floater` 关键帧里。
import { REPLAY_ANIM, type Floater } from '../../state/replay.ts'
import { DOT_LOOK, EVENT_LOOK, FLOATER_LOOK } from '../../theme/colors.ts'

interface EventFloatersProps {
  /** 只属于**这一个锚点**的飘字（调用方已按 `targetKey` 过滤） */
  readonly floaters: readonly Floater[]
}

/** 一条飘字的主文（金额 / 时长；状态类显示秒） */
function mainText(floater: Floater): string {
  const last = floater.parts[floater.parts.length - 1]
  const word = last === undefined ? '' : (EVENT_LOOK[last.event] ?? last.event)
  switch (floater.tone) {
    case 'damage':
      return `-${String(floater.total)}`
    case 'heal':
      return `+${String(floater.total)}`
    case 'shield':
      return `+${String(floater.total)}`
    case 'shieldBreak':
      // `overflow` = 护盾被打空时**溢出到血量**的那部分伤害
      return `破盾 ${String(floater.total)}`
    case 'status':
      return `${word} ${floater.total.toFixed(2)}s`
    case 'destroy':
    case 'repair':
      return word
  }
}

/** 一条飘字的悬停说明：把合并进来的每个分量都列清楚 */
function tipText(floater: Floater): string {
  const head = FLOATER_LOOK[floater.tone].label
  const parts = floater.parts.map((part) => `${EVENT_LOOK[part.event] ?? part.event} ${String(part.amount)}`)
  return parts.length <= 1 ? head : `${head}：${parts.join(' + ')}`
}

export function EventFloaters({ floaters }: EventFloatersProps) {
  if (floaters.length === 0) return null
  return (
    <div className="floaters" aria-hidden="true">
      {floaters.map((floater) => (
        <span
          key={`${floater.targetKey}|${floater.tone}|${String(floater.cs)}`}
          className={`floater floater-${floater.tone}`}
          style={{
            color: FLOATER_LOOK[floater.tone].color,
            animationDuration: `${String(REPLAY_ANIM.floaterMs)}ms`,
          }}
          title={tipText(floater)}
        >
          <b>{mainText(floater)}</b>
          {floater.parts.length > 1 && (
            <i className="floater-parts">
              {floater.parts
                .slice(0, REPLAY_ANIM.maxParts)
                .map((part, at) => (
                  <span
                    key={`${part.event}-${String(at)}`}
                    style={part.dot === undefined ? undefined : { color: DOT_LOOK[part.dot].color }}
                  >
                    {EVENT_LOOK[part.event] ?? part.event} {String(part.amount)}
                  </span>
                ))}
            </i>
          )}
        </span>
      ))}
    </div>
  )
}
