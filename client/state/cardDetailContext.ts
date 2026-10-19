// 悬浮细节窗的**控制器接口**（React context）——
// 让卡面（`BattleView` 的卡、`BoardRow` 的卡）不必把三个回调层层往下透传。
//
// 谁提供：`SimulateMode`（它拥有"当前要显示的卡 + 位置 + 是否钉住"这三件事）。
// 谁消费：`BattleCard`（回放态：悬停即显 + **单击钉住**）与 `BoardRow`（编辑态：**只悬停**，
//   因为编辑态单击卡面是"选中挪位"的既有交互，冲突 —— 见 §W.3 的本意：钉住是给回放用的）。

import { createContext, useContext } from 'react'
import type { Card, FrameCard } from '../../engine/types.ts'

/** 光标位置（只用这两个字段，避免把整个 React 事件对象带进状态） */
export interface DetailPointer {
  readonly x: number
  readonly y: number
}

export interface CardDetailApi {
  /** 鼠标移入卡面：悬停即显（含"移入延迟"常量，见 `HOVER_DELAY_MS`）。`enchantId` = 编辑态的当前附魔（回放态省略） */
  enter(card: Card, frame: FrameCard | undefined, pointer: DetailPointer, enchantId?: string): void
  /** 鼠标移出卡面：未钉住则收起 */
  leave(): void
  /** 单击卡面：钉住 / 取消钉住（只有回放态用；内容冻结在钉住那一刻的帧） */
  togglePin(card: Card, frame: FrameCard | undefined, pointer: DetailPointer, enchantId?: string): void
}

export const CardDetailContext = createContext<CardDetailApi | null>(null)

/** 取控制器；没有提供者（例如卡牌库）时返回 `null` —— 调用方据此不挂事件 */
export function useCardDetailApi(): CardDetailApi | null {
  return useContext(CardDetailContext)
}
