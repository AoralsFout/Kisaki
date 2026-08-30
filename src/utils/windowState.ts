/**
 * 窗口位置 / 大小持久化
 *
 * 记住各窗口（主窗口 / 设置 / 日志）最后所在的位置与大小，下次启动时恢复，
 * 让桌宠「回到它上次待的位置」。实现要点：
 *   - 以 localStorage 保存（各窗口共享同源存储，物理像素坐标）。
 *   - 恢复时用 availableMonitors() 做「越界钳制」：若保存位置的中心点已不在
 *     任何当前显示器内（典型：外接屏拔掉、分辨率变更），则不应用、退回系统默认
 *     位置，避免窗口被丢到看不见的屏幕外。
 *   - 通过 onMoved / onResized 监听（防抖）持续记录，窗口关闭后位置即已落盘。
 *   - 全程 try/catch 降级：非 Tauri 环境（浏览器调试）或权限不足时静默 no-op。
 */
import { getCurrentWindow, availableMonitors } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { createLogger } from './logger'

const log = createLogger('WindowState')

/** localStorage key 前缀 */
const KEY_PREFIX = 'deskpet-window-state-'

/** 移动 / 缩放后的防抖落盘间隔（毫秒） */
const SAVE_DEBOUNCE_MS = 300

/** 持久化的窗口状态（物理像素） */
export interface PersistedWindowState {
  x: number
  y: number
  width: number
  height: number
}

export interface InitWindowStateOptions {
  /** 恢复完成后再显示预先以 visible:false 创建的窗口。 */
  showAfterRestore?: boolean
}

/** 读取保存的状态；无或非法返回 null */
function readState(key: string): PersistedWindowState | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<PersistedWindowState>
    if (
      typeof s.x === 'number' &&
      typeof s.y === 'number' &&
      typeof s.width === 'number' &&
      typeof s.height === 'number' &&
      s.width > 0 &&
      s.height > 0
    ) {
      return { x: s.x, y: s.y, width: s.width, height: s.height }
    }
  } catch { /* ignore */ }
  return null
}

/** 写入状态（失败静默，不因存储配额问题打断窗口逻辑） */
function writeState(key: string, state: PersistedWindowState): void {
  try {
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify(state))
  } catch { /* ignore */ }
}

/**
 * 判断保存的窗口矩形是否仍「可见」：其中心点是否落在任一当前显示器内。
 * 不可见（显示器已移除等）返回 null，由调用方放弃恢复。
 */
async function clampToVisible(state: PersistedWindowState): Promise<PersistedWindowState | null> {
  let monitors
  try {
    monitors = await availableMonitors()
  } catch {
    // 无法枚举显示器（浏览器 / 权限）→ 原样返回，信任保存值
    return state
  }
  if (!monitors || monitors.length === 0) return state

  const cx = state.x + state.width / 2
  const cy = state.y + state.height / 2
  for (const m of monitors) {
    const left = m.position.x
    const top = m.position.y
    const right = left + m.size.width
    const bottom = top + m.size.height
    if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
      return state
    }
  }
  return null
}

/**
 * 初始化某窗口的状态持久化：恢复保存的位置/大小并开始跟踪后续移动/缩放。
 * 应在窗口对应的 Vue 组件 onMounted 中调用一次。
 *
 * @param key 唯一标识该窗口，如 'main' | 'settings' | 'logs'
 */
export async function initWindowState(
  key: string,
  options: InitWindowStateOptions = {},
): Promise<void> {
  const win = getCurrentWindow()

  // ── 恢复 ──
  const saved = readState(key)
  if (saved) {
    const visible = await clampToVisible(saved)
    if (visible) {
      try {
        await win.setPosition(new PhysicalPosition(visible.x, visible.y))
        await win.setSize(new PhysicalSize(visible.width, visible.height))
      } catch (e) {
        // 缺少 set-position/set-size 权限时静默降级，不影响主流程
        log.warn('恢复窗口位置/大小失败（可能缺少权限）: %s', (e as Error)?.message || String(e))
      }
    } else {
      log.info('窗口状态越界（显示器已变更），跳过恢复: %s', key)
    }
  }

  // 窗口以 hidden 状态创建：必须等位置/大小恢复后再显示，
  // 避免默认位置的白色 WebView 闪现后瞬移。恢复失败也要显示，不能留下隐形窗口。
  if (options.showAfterRestore) {
    try {
      await win.show()
    } catch (e) {
      log.warn('恢复后显示窗口失败: %s', (e as Error)?.message || String(e))
    }
  }

  // ── 跟踪 ──
  const persist = async () => {
    try {
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      writeState(key, { x: pos.x, y: pos.y, width: size.width, height: size.height })
    } catch { /* ignore */ }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
  }

  try {
    await win.onMoved(schedule)
    await win.onResized(schedule)
  } catch (e) {
    log.warn('监听窗口移动/缩放失败（非 Tauri 环境?）: %s', (e as Error)?.message || String(e))
    return
  }

  // 立即落盘一次（捕获当前值；含「无保存状态」的首次启动默认值）
  void persist()
}
