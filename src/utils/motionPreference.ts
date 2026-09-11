import {
  CHANNEL_DESKPET_REDUCED_MOTION,
  STORAGE_REDUCED_MOTION,
} from '../constants'
import { subscribeSettingsChange } from '../application/settings/settingsChangeStream'
import { localSettingsStore } from '../infrastructure/settings/localSettingsStore'

const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion'

function readStoredPreference(): boolean {
  return localSettingsStore.read(STORAGE_REDUCED_MOTION) === '1'
}

function applyPreference(enabled: boolean): void {
  if (typeof document === 'undefined') return
  if (enabled) document.documentElement.setAttribute(REDUCED_MOTION_ATTRIBUTE, 'true')
  else document.documentElement.removeAttribute(REDUCED_MOTION_ATTRIBUTE)
}

/** 用户是否主动开启了“降低动画效果”。 */
export function isReducedMotionEnabled(): boolean {
  return readStoredPreference()
}

/** 用户偏好或操作系统偏好任一要求降低动画时返回 true。 */
export function shouldReduceMotion(): boolean {
  if (readStoredPreference()) return true
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

let motionChannel: BroadcastChannel | null = null
try {
  motionChannel = new BroadcastChannel(CHANNEL_DESKPET_REDUCED_MOTION)
  motionChannel.onmessage = event => {
    if (typeof event.data?.enabled === 'boolean') applyPreference(event.data.enabled)
  }
} catch {
  // 不支持 BroadcastChannel 时仍在当前窗口立即生效，并由 storage 事件跨窗口兜底。
}

// 跨窗口同步：只订阅统一配置变更流，不再自行注册 window 监听。
subscribeSettingsChange(changedKeys => {
  if (changedKeys.includes(STORAGE_REDUCED_MOTION)) applyPreference(readStoredPreference())
})

/** 持久化偏好、立即更新当前窗口，并广播到其它已打开窗口。 */
export function setReducedMotionEnabled(enabled: boolean): void {
  localSettingsStore.write(STORAGE_REDUCED_MOTION, enabled ? '1' : '0')
  applyPreference(enabled)
  motionChannel?.postMessage({ enabled })
}

// 在 Vue 挂载和首帧动画前应用已保存的偏好。
applyPreference(readStoredPreference())
