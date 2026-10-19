// 统一空态（3.2 步 · F6）：一行主文案 + 可选一行灰字解释，三处（卡牌库 / 回放日志 / 阵容清单）共用。
//
// 纪律：只渲染文案，不做判断、不取数据；文案由调用方从 `t()` 里取（`client/i18n`）。

interface EmptyStateProps {
  /** 主行：说明"这里为什么是空的" */
  readonly main: string
  /** 副行（可选）：告诉用户下一步能做什么 */
  readonly hint?: string
}

/** 空态块（居中、两行；样式见 `styles.css` 的 `.empty-state`） */
export function EmptyState({ main, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state-main">{main}</p>
      {hint !== undefined && <p className="empty-state-hint">{hint}</p>}
    </div>
  )
}
