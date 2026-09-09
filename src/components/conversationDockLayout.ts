export interface ConversationDockMetrics {
  containerHeight: number
  beforeHeight: number
  afterHeight: number
  inputHeight: number
  latestMessageHeight: number
  expanded: boolean
}

export interface ConversationDockLayout {
  inputDrop: number
  historyHeight: number
  expandedHistoryHeight: number
  collapsedHistoryHeight: number
  latestOverflowing: boolean
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * 统一计算底部交互区的最终几何。
 *
 * 展开时输入框留在窗口内；收起时内容轨道增加一个输入框高度，弹性占位会吸收
 * 多余空间，使工具栏保持原位、输入框自然落到窗口裁剪区之外。
 */
export function calculateConversationDockLayout(
  metrics: ConversationDockMetrics,
): ConversationDockLayout {
  const containerHeight = nonNegative(metrics.containerHeight)
  const beforeHeight = nonNegative(metrics.beforeHeight)
  const afterHeight = nonNegative(metrics.afterHeight)
  const inputHeight = nonNegative(metrics.inputHeight)
  const latestMessageHeight = nonNegative(metrics.latestMessageHeight)
  const fixedHeight = beforeHeight + afterHeight
  const expandedHistoryHeight = Math.max(0, containerHeight - fixedHeight - inputHeight)
  const collapsedAvailableHeight = Math.max(0, containerHeight - fixedHeight)
  const collapsedHistoryHeight = Math.min(latestMessageHeight, collapsedAvailableHeight)

  return {
    inputDrop: metrics.expanded ? 0 : inputHeight,
    historyHeight: metrics.expanded ? expandedHistoryHeight : collapsedHistoryHeight,
    expandedHistoryHeight,
    collapsedHistoryHeight,
    latestOverflowing: latestMessageHeight > collapsedAvailableHeight,
  }
}
