// 卡面图片的**通用小件**：给什么 `className` 就用什么样式；**没有图 / 加载失败 ⇒ 画 `fallback`**
// （缺省什么都不画）。

// 五处共用：卡牌库列表缩略图 · 卡牌库详情大图 · 摆盘时的卡面底图 · 回放卡面的卡图 · 卡框材质 ·
// 玩家头像（头像要回落"角色名首字"，所以本件支持传 `fallback`）。
// 为什么单独成组件：失败状态是**每个实例自己的**（`useState`），在列表 / 棋盘这种 `.map` 里
// 没法用父组件的单一状态表达；放这里也免得四处各写一遍 `onError` 回落。
//
// 纪律：本件**只消费 URL**（URL 一律由 `client/data/assets.ts` 拼），不发请求、不判断图片是否存在。
import { useState, type ReactNode } from 'react'

interface CardImageProps {
  /** 图片 URL；`null` = 调用方已经知道没有图（直接画 `fallback`） */
  readonly url: string | null
  readonly className: string
  readonly alt?: string | undefined
  /** 没有图 / 加载失败时画什么；缺省 = 什么都不画 */
  readonly fallback?: ReactNode
}

export function CardImage({ url, className, alt = '', fallback = null }: CardImageProps) {
  const [failed, setFailed] = useState(false)
  if (url === null || failed) return <>{fallback}</>
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      onError={() => {
        setFailed(true)
      }}
    />
  )
}
