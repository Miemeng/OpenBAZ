// 回放控制条**表现层**：播放 / 暂停 / 步进 / 跳转 / 倍速 + 帧号与时刻。

// 纯受控组件：游标与播放状态都在 `SimulateMode`（游标逻辑是纯函数，见 `state/replay.ts`）——
// 本组件不持有状态、不碰计时器，只把用户动作往上抛。
import { TRIGGER_FRAME_SECONDS, csToSeconds } from '../../../engine/state.ts'
import { REPLAY_ANIM, type ReplaySpeed } from '../../state/replay.ts'

interface ReplayBarProps {
  readonly index: number
  readonly total: number
  readonly playing: boolean
  readonly speed: ReplaySpeed
  /** 当前帧的触发帧序号（= `frames[index].triggerFrame`） */
  readonly triggerFrame: number
  /** 当前帧的全局帧数（cs） */
  readonly timeCs: number
  /** 走到末帧时显示的结算语（`玩家A 获胜（血量归零）`） */
  readonly outcomeNote: string
  readonly onTogglePlay: () => void
  readonly onStep: (delta: number) => void
  readonly onSeek: (index: number) => void
  readonly onSpeed: (speed: ReplaySpeed) => void
  readonly onExit: () => void
}

export function ReplayBar({
  index,
  total,
  playing,
  speed,
  triggerFrame,
  timeCs,
  outcomeNote,
  onTogglePlay,
  onStep,
  onSeek,
  onSpeed,
  onExit,
}: ReplayBarProps) {
  const last = Math.max(0, total - 1)
  const atEnd = index >= last

  return (
    <div className="replay-bar">
      <div className="rb-controls">
        <button
          type="button"
          className="chip"
          title="回到开局"
          onClick={() => {
            onSeek(0)
          }}
        >
          ⏮
        </button>
        <button
          type="button"
          className="chip"
          title="上一帧（←）"
          disabled={index <= 0}
          onClick={() => {
            onStep(-1)
          }}
        >
          ◀
        </button>
        <button type="button" className="run-button rb-play" title={playing ? '暂停（空格）' : '播放（空格）'} onClick={onTogglePlay}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button
          type="button"
          className="chip"
          title="下一帧（→）"
          disabled={atEnd}
          onClick={() => {
            onStep(1)
          }}
        >
          ▶
        </button>
        <button
          type="button"
          className="chip"
          title="跳到末帧"
          onClick={() => {
            onSeek(last)
          }}
        >
          ⏭
        </button>
      </div>

      <input
        className="rb-range"
        type="range"
        min={0}
        max={last}
        step={1}
        value={index}
        title="拖动跳转"
        onChange={(event) => {
          onSeek(Number(event.target.value))
        }}
      />

      <div className="rb-readout">
        <span className="facet-label">帧</span>
        <code>
          {String(index)} / {String(last)}
        </code>
        <span className="facet-label">时刻</span>
        <code>{csToSeconds(timeCs).toFixed(2)}s</code>
        <span className="hint">
          （触发帧 {String(triggerFrame)} · 一帧 = {TRIGGER_FRAME_SECONDS.toFixed(1)}s）
        </span>
      </div>

      <div className="rb-speeds">
        {REPLAY_ANIM.speeds.map((item) => (
          <button
            key={String(item)}
            type="button"
            className={item === speed ? 'chip chip-on' : 'chip'}
            title={`${String(item)} 倍速（只影响播放间隔）`}
            onClick={() => {
              onSpeed(item)
            }}
          >
            {String(item)}×
          </button>
        ))}
      </div>

      {atEnd && <span className="rb-outcome">{outcomeNote}</span>}

      <button type="button" className="chip chip-clear rb-exit" onClick={onExit} title="看终局读数与完整日志">
        查看结算
      </button>
    </div>
  )
}
