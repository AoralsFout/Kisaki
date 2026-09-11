export type SettingsChangeListener = (changedKeys: readonly string[]) => void

const listeners = new Set<SettingsChangeListener>()

/**
 * 唯一的配置变更广播点。
 * 基础设施在收到跨窗口存储事件时调用它，配置消费者只订阅这里，
 * 因此新增一份配置不需要再添加一个 window/event 监听器。
 */
export function publishSettingsChange(changedKeys: readonly string[]): void {
  if (changedKeys.length === 0) return
  for (const listener of [...listeners]) listener(changedKeys)
}

export function subscribeSettingsChange(listener: SettingsChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
