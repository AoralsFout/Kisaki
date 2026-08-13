/**
 * 桌面通知封装
 *
 * 为 AI 提醒 / 命令完成等提供系统级通知出口（穿透态下气泡不可见）。
 * - 首次会向系统申请通知权限（macOS 弹权限框，Windows/Linux 无需）。
 * - 全程 try/catch：非 Tauri 环境或权限被拒时静默返回 false，不抛错。
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { createLogger } from './logger'

const log = createLogger('Notify')

/**
 * 发送一条系统通知。返回是否成功发出。
 * 未授权会尝试申请一次；仍被拒则放弃并返回 false。
 */
export async function notify(title: string, body: string): Promise<boolean> {
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      const permission = await requestPermission()
      granted = permission === 'granted'
    }
    if (!granted) {
      log.info('通知权限未授予，跳过系统通知')
      return false
    }
    sendNotification({ title, body })
    return true
  } catch (e) {
    log.warn('发送系统通知失败（非 Tauri 环境或插件不可用）: %s', (e as Error)?.message || String(e))
    return false
  }
}
