import { describe, expect, it } from 'vitest'
import { calculateConversationDockLayout } from './conversationDockLayout'

const base = {
  containerHeight: 700,
  beforeHeight: 40,
  afterHeight: 60,
  inputHeight: 200,
  latestMessageHeight: 120,
}

describe('calculateConversationDockLayout', () => {
  it('展开时为输入框和固定控制区预留空间', () => {
    expect(calculateConversationDockLayout({ ...base, expanded: true })).toEqual({
      inputDrop: 0,
      historyHeight: 400,
      expandedHistoryHeight: 400,
      collapsedHistoryHeight: 120,
      latestOverflowing: false,
    })
  })

  it('收起时保持工具栏位置并仅展示最新消息高度', () => {
    expect(calculateConversationDockLayout({ ...base, expanded: false })).toEqual({
      inputDrop: 200,
      historyHeight: 120,
      expandedHistoryHeight: 400,
      collapsedHistoryHeight: 120,
      latestOverflowing: false,
    })
  })

  it('超长消息按剩余空间钳制并报告溢出', () => {
    expect(calculateConversationDockLayout({
      ...base,
      latestMessageHeight: 800,
      expanded: false,
    })).toEqual({
      inputDrop: 200,
      historyHeight: 600,
      expandedHistoryHeight: 400,
      collapsedHistoryHeight: 600,
      latestOverflowing: true,
    })
  })

  it('固定内容超过窗口时不会产生负高度或无效数值', () => {
    expect(calculateConversationDockLayout({
      containerHeight: Number.NaN,
      beforeHeight: 500,
      afterHeight: 300,
      inputHeight: -20,
      latestMessageHeight: Number.POSITIVE_INFINITY,
      expanded: true,
    })).toEqual({
      inputDrop: 0,
      historyHeight: 0,
      expandedHistoryHeight: 0,
      collapsedHistoryHeight: 0,
      latestOverflowing: false,
    })
  })
})
