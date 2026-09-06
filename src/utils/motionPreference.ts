import {
  CHANNEL_DESKPET_REDUCED_MOTION,
  STORAGE_REDUCED_MOTION,
} from '../constants'

const REDUCED_MOTION_ATTRIBUTE = 'data-reduced-motion'

function readStoredPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_REDUCED_MOTION) === '1'
  } catch {
    return false
  }
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

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_REDUCED_MOTION) applyPreference(event.newValue === '1')
  })
}

/** 持久化偏好、立即更新当前窗口，并广播到其它已打开窗口。 */
export function setReducedMotionEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_REDUCED_MOTION, enabled ? '1' : '0')
  } catch {
    // 存储不可用时仍允许本次运行生效。
  }
  applyPreference(enabled)
  motionChannel?.postMessage({ enabled })
}

// 在 Vue 挂载和首帧动画前应用已保存的偏好。
applyPreference(readStoredPreference())
