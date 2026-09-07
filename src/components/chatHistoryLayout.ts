export interface CollapsedScrollMetrics {
  scrollHeight: number
  currentScrollTop: number
  listTop: number
  itemTop: number
  itemHeight: number
  viewportHeight: number
}

/**
 * 折叠态最新消息的滚动目标：短消息保持底部对齐，长消息改为顶部对齐。
 * 短消息返回 scrollHeight，让浏览器按实际 clientHeight 自动钳制到底部。
 */
export function collapsedLatestScrollTop(metrics: CollapsedScrollMetrics): number {
  if (metrics.itemHeight <= metrics.viewportHeight) return metrics.scrollHeight

  const topInScrollContent = metrics.itemTop - metrics.listTop + metrics.currentScrollTop
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.viewportHeight)
  return Math.min(Math.max(0, topInScrollContent), maxScrollTop)
}
