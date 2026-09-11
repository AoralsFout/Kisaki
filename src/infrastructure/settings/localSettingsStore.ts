import { publishSettingsChange } from '../../application/settings/settingsChangeStream'
import type { SettingsStoragePort } from '../../application/settings/settingsStorage'

/** localStorage 适配器；存储不可用（隐私模式等）时读写均安全降级。 */
export const localSettingsStore: SettingsStoragePort = {
  read(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch { /* 存储不可用时本次运行仍然生效 */ }
  },
}

/**
 * 全应用唯一的跨窗口配置监听：把 storage 事件转成配置变更流。
 * 配置消费者订阅 change stream，不再各自注册 window 监听器。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key) publishSettingsChange([event.key])
  })
}
