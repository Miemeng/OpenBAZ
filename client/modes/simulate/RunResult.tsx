// 跑一局的结果面板（结算）：终局结算读数 + 完整日志 + 进回放的入口。

// 纪律：**只消费引擎产物** —— 不重算任何数值、**不解析文本日志**（`lines` 原样逐行展示，
// 唯一的处理是把箭头字形换成三角形 `▶`，见 `state/effectLine.ts` 的 `arrowToTri`）；
// 本组件也**不 import `engine/tick.ts`**：跑对局的唯一入口在 `SimulateMode.tsx` 的 `startBattle`。
import { MAX_TIME_SECONDS, csToSeconds } from '../../../engine/state.ts'
import { arrowToTri } from '../../state/effectLine.ts'
import { t } from '../../i18n/index.ts'

/** 一方的终局读数（= `PlayerState` 的子集；表现层只声明"我要显示什么"） */
export interface RunPlayer {
  readonly name: string
  readonly hp: number
  readonly maxHp: number
  readonly shield: number
}

interface RunResultProps {
  /** 本局实际使用的种子（跑完回显在输入框里，这里再显示一次便于对照） */
  readonly seed: number
  readonly victory: 'hp' | 'timeout' | 'none'
  readonly winnerName: string
  readonly players: readonly RunPlayer[]
  readonly triggerFrame: number
  readonly timeCs: number
  readonly messageCount: number
  readonly frameCount: number
  /** 引擎渲染好的文本行（原样展示） */
  readonly lines: readonly string[]
  /** 有帧快照时给"回放这一局"的入口；`undefined` = 没有可回放的帧（按钮不出现） */
  readonly onReplay?: (() => void) | undefined
  readonly onClose: () => void
}

export function RunResult({
  seed,
  victory,
  winnerName,
  players,
  triggerFrame,
  timeCs,
  messageCount,
  frameCount,
  lines,
  onReplay,
  onClose,
}: RunResultProps) {
  const reason =
    victory === 'timeout'
      ? `到达 MAX_TIME = ${MAX_TIME_SECONDS.toFixed(2)}s（超时判平局，平局判发起方获胜）`
      : victory === 'hp'
        ? '血量归零'
        : '未判定'

  return (
    <section className="run-result">
      <header className="run-result-head">
        <h3>{winnerName} 获胜</h3>
        <span className="hint">{reason}</span>
        <div className="run-result-actions">
          {onReplay !== undefined && (
            <button type="button" className="run-button run-button-replay" onClick={onReplay}>
              ▶ 回放这一局
            </button>
          )}
          <button
            type="button"
            className="chip"
            onClick={() => {
              onClose()
            }}
          >
            {t('result.collapse')}
          </button>
        </div>
      </header>

      <ul className="run-readout">
        <li>
          <span className="facet-label">{t('result.seed')}</span>
          <code>{String(seed)}</code>
          <span className="hint">{t('result.seedHint')}</span>
        </li>
        <li>
          <span className="facet-label">{t('result.time')}</span>
          触发帧 {String(triggerFrame)} · 全局帧 {String(timeCs)}（{csToSeconds(timeCs).toFixed(2)}s）
        </li>
        {players.map((player) => (
          <li key={player.name}>
            <span className="facet-label">{player.name}</span>
            {t('result.playerLine', { hp: player.hp, maxHp: player.maxHp, shield: player.shield })}
          </li>
        ))}
        <li>
          <span className="facet-label">{t('result.artifacts')}</span>
          {t('result.logCount', { lines: lines.length, messages: messageCount, frames: frameCount })}
          {onReplay === undefined ? t('result.noFrames') : t('result.replayHint')}
        </li>
      </ul>

      <div className="run-log">
        {lines.map((line, index) => (
          <div key={`line-${String(index)}`} className="run-log-line">
            {arrowToTri(line)}
          </div>
        ))}
      </div>
    </section>
  )
}
