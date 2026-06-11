/**
 * 结构化日志系统
 *
 * 特性：
 * - 命名空间隔离（每个模块独立 Logger）
 * - 5 级日志 trace / debug / info / warn / error
 * - 彩色控制台输出（namespace 着色 + 级别标签）
 * - 运行时动态调整日志级别（生产/开发环境自适应）
 * - 内存环形缓冲区（保留最近 N 条日志，供崩溃诊断或 UI 查看器使用）
 * - 可扩展：预留 Tauri 文件持久化钩子，无需 Rust 侧配合即开即用
 *
 * 使用示例：
 *   import { createLogger } from '../utils/logger'
 *   const log = createLogger('TTS')
 *   log.info('播报完成')        // → [INF] [TTS] 播报完成
 *   log.warn('连接超时', err)   // → [WRN] [TTS] 连接超时 + Error 对象
 *   log.debug('音频帧尺寸:', buf.byteLength)
 */

// ─── 类型定义 ─────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  namespace: string
  message: string
  args?: unknown[]
  /** 来源窗口标签 */
  source?: string
}

export interface Logger {
  trace: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  /** 本 Logger 的命名空间 */
  ns: string
}

export interface LoggerConfig {
  /** 最低输出级别，低于此级别的不输出到控制台 */
  minLevel: LogLevel
  /** 全局开关 */
  enabled: boolean
  /** 内存环形缓冲区大小，0 表示不缓冲 */
  bufferSize: number
}

// ─── 级别权重 ─────────────────────────────────────────

// ─── 来源窗口 ─────────────────────────────────────────
// 每个 Tauri 窗口有独立 JS 上下文，通过 URL 参数区分窗口来源。

let _windowSource: string | undefined

function detectWindowSource(): string {
  if (_windowSource !== undefined) return _windowSource
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  if (params.has('settings')) _windowSource = '设置'
  else if (params.has('logs')) _windowSource = '日志'
  else if (params.has('dev')) _windowSource = 'Dev'
  else _windowSource = '主窗口'
  // NOTE: 若新增窗口标识，请同步更新 src/constants.ts 中的 QUERY_* 常量
  return _windowSource
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

/** 控制台 CSS 样式 — 用颜色区分级别 */
const LEVEL_STYLES: Record<LogLevel, string> = {
  trace: 'color:#888; font-weight:300;',
  debug: 'color:#4fc3f7; font-weight:400;',   // 浅蓝
  info: 'color:#81c784; font-weight:400;',     // 浅绿
  warn: 'color:#ffb74d; font-weight:500;',     // 橙
  error: 'color:#ef5350; font-weight:600;',    // 红
}

/** 控制台标签缩写，保持对齐 */
const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
}

/** 命名空间调色板 — 自动根据 namespace 哈希分配颜色 */
const NS_COLORS = [
  '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
  '#2196f3', '#00bcd4', '#009688', '#4caf50',
  '#ff5722', '#795548', '#607d8b', '#ff9800',
]

function hashNamespace(ns: string): number {
  let hash = 0
  for (let i = 0; i < ns.length; i++) {
    hash = ((hash << 5) - hash) + ns.charCodeAt(i)
    hash |= 0
  }
  return hash
}

function pickNamespaceColor(ns: string): string {
  return NS_COLORS[Math.abs(hashNamespace(ns)) % NS_COLORS.length]
}

// ─── 全局配置 ────────────────────────────────────────

const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: import.meta.env.PROD ? 'info' : 'debug',
  enabled: true,
  bufferSize: 200,
}

let globalConfig: LoggerConfig = { ...DEFAULT_CONFIG }

/** 环形缓冲区 */
let ringBuffer: LogEntry[] = []
let bufferPos = 0
let bufferFull = false

// ─── UI 查看器订阅 ─────────────────────────────────────

type LogCallback = (entry: LogEntry) => void
let subscribers = new Set<LogCallback>()

/**
 * 订阅所有新日志条目（用于 UI 查看器实时更新）。
 * 返回取消订阅函数。
 */
export function subscribe(cb: LogCallback): () => void {
  subscribers.add(cb)
  return () => { subscribers.delete(cb) }
}

// ─── 跨窗口实时广播（BroadcastChannel） ──────────────
// 各 Tauri webview 的 JS 上下文独立，通过 BroadcastChannel
// 实现跨窗口日志实时同步，让日志查看器窗口能看到其它窗口的日志。

const LOG_CHANNEL = 'deskpet-logs'
// NOTE: 若修改频道名，请同步更新 src/constants.ts 中的 CHANNEL_DESKPET_LOGS
let bc: BroadcastChannel | null = null

// 延迟初始化 BroadcastChannel（避免模块加载时竞态）
function ensureBroadcastChannel() {
  if (bc) return
  try {
    bc = new BroadcastChannel(LOG_CHANNEL)
  } catch {
    // 非浏览器环境忽略
  }
}

/** 订阅跨窗口日志广播（返回取消函数） */
export function subscribeCrossWindow(cb: LogCallback): () => void {
  ensureBroadcastChannel()
  if (!bc) return () => {}

  /** 收到其它窗口广播的日志 → 立即展示 + 写入文件（避免源窗口崩溃丢失） */
  const handler = (event: MessageEvent) => {
    const entry = event.data as LogEntry
    if (entry && entry.timestamp && entry.level && entry.namespace) {
      // 通知 UI 订阅者
      try { cb(entry) } catch { /* ignore */ }

      // 立即写入文件（不等 2 秒节流），确保跨窗口日志不丢失
      enqueueFileWrite(entry)
      flushImmediately()
    }
  }
  bc.addEventListener('message', handler)
  return () => { bc?.removeEventListener('message', handler) }
}

// ─── 日志文件持久化（Tauri） ──────────────────────────
// 模块加载时自动检测 Tauri 环境并启用文件持久化。
// 使用节流批量写入，避免高频日志拖慢 UI 线程。
// 即使 Tauri 端未注册 append_log_entries 命令也能安全降级。

let filePersistenceEnabled = false
let fileWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingFileEntries: LogEntry[] = []

/** 获取今日日志文件名（前端侧计算，与 Rust 侧约定） */
function todayLogFilename(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `app-${y}-${m}-${day}.jsonl`
}

// ─── 内部工具 ─────────────────────────────────────────

function getTimestamp(): string {
  return new Date().toISOString()
}

function meetsLevel(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[globalConfig.minLevel]
}

function pushToBuffer(entry: LogEntry) {
  if (globalConfig.bufferSize <= 0) return
  ringBuffer[bufferPos] = entry
  bufferPos = (bufferPos + 1) % globalConfig.bufferSize
  if (bufferPos === 0) bufferFull = true
}

/** 获取当前缓冲的所有日志（按时间正序） */
export function getBuffer(): LogEntry[] {
  if (!bufferFull) return ringBuffer.slice(0, bufferPos)
  return [...ringBuffer.slice(bufferPos), ...ringBuffer.slice(0, bufferPos)]
}

/** 清空缓冲区 */
export function clearBuffer() {
  ringBuffer = []
  bufferPos = 0
  bufferFull = false
}

/** 展开 printf 风格格式占位符（%s / %d / %o / %O / %f） */
function formatMessage(template: string, args?: unknown[]): string {
  if (!args || args.length === 0) return template
  let argIndex = 0
  return template.replace(/%[sdfoO]/g, (match) => {
    if (argIndex >= args.length) return match
    const val = args[argIndex++]
    switch (match) {
      case '%s': return String(val)
      case '%d':
      case '%f': return String(Number(val) || 0)
      case '%o':
      case '%O': {
        try { return JSON.stringify(val, null, 0) } catch { return String(val) }
      }
      default: return match
    }
  })
}

/** 获取结构的消息文本（含展开后的参数），用于文件持久化 */
function formattedMessage(entry: LogEntry): string {
  if (entry.args && entry.args.length > 0) {
    return formatMessage(entry.message, entry.args)
  }
  return entry.message
}

// ─── 文件持久化 ──────────────────────────────────────

async function flushFileEntries() {
  if (pendingFileEntries.length === 0) return
  const batch = pendingFileEntries.splice(0)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('append_log_entries', {
      filename: todayLogFilename(),
      entries: batch.map(e => ({
        timestamp: e.timestamp,
        level: e.level,
        namespace: e.namespace,
        message: formattedMessage(e),
        source: e.source || '',
      })),
    })
  } catch {
    // 文件写入静默失败：Tauri 命令未注册或非 Tauri 环境
    filePersistenceEnabled = false
  }
}

function scheduleFileFlush() {
  if (!filePersistenceEnabled) return
  if (fileWriteTimer) return
  fileWriteTimer = setTimeout(() => {
    fileWriteTimer = null
    flushFileEntries()
  }, 2000)
}

/** 立即刷新待写入日志到文件（不等 2 秒节流） */
function flushImmediately() {
  if (!filePersistenceEnabled) return
  if (fileWriteTimer) {
    clearTimeout(fileWriteTimer)
    fileWriteTimer = null
  }
  flushFileEntries()
}

/** 添加日志条目到待写入队列 */
function enqueueFileWrite(entry: LogEntry) {
  if (!filePersistenceEnabled) return
  pendingFileEntries.push(entry)
}

/**
 * 启用 Tauri 文件持久化。
 * 日志会以 2 秒为间隔批量写入 Tauri 后端日志文件。
 * 若 Rust 端未实现 append_log_entries 命令，自动静默降级。
 *
 * 模块初始化时会自动检测 Tauri 环境并调用此方法。
 */
export async function enableFilePersistence() {
  if (filePersistenceEnabled) return
  filePersistenceEnabled = true
  // 立即刷新一次已有缓冲
  scheduleFileFlush()
}

/** Tauri 全局 API（通过 window.__TAURI_INTERNALS__ 或 window.__TAURI__ 检测） */
interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: Record<string, unknown>
  __TAURI__?: Record<string, unknown>
}

/** 检测是否运行在 Tauri 环境中（Tauri v2 使用 __TAURI_INTERNALS__） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    (window as TauriWindow).__TAURI_INTERNALS__ !== undefined ||
    (window as TauriWindow).__TAURI__ !== undefined
  )
}

// 模块加载时自动检测并启用文件持久化
if (typeof window !== 'undefined') {
  // 延迟到微任务队列，等 import 链稳定后再检测
  queueMicrotask(() => {
    if (isTauri()) {
      enableFilePersistence()
    }
  })
}

/** 关闭文件持久化 */
export function disableFilePersistence() {
  filePersistenceEnabled = false
  if (fileWriteTimer) {
    clearTimeout(fileWriteTimer)
    fileWriteTimer = null
  }
}

// ─── 全局配置 API ─────────────────────────────────────

/** 设置全局最低日志级别 */
export function setLogLevel(level: LogLevel) {
  globalConfig.minLevel = level
}

/** 获取当前全局日志级别 */
export function getLogLevel(): LogLevel {
  return globalConfig.minLevel
}

/** 开关全局日志 */
export function setLogEnabled(enabled: boolean) {
  globalConfig.enabled = enabled
}

/** 重置为默认配置 */
export function resetConfig() {
  globalConfig = { ...DEFAULT_CONFIG }
  clearBuffer()
  disableFilePersistence()
}

/** 获取当前配置（外部只读快照） */
export function getConfig(): LoggerConfig {
  return { ...globalConfig }
}

// ─── Logger 工厂 ──────────────────────────────────────

const nsColorCache = new Map<string, string>()

/**
 * 创建一个命名空间 Logger。
 *
 * @param namespace - 模块名称，如 'TTS' / 'API' / 'Chat' / 'Character'
 * @param level - 可选，覆盖该 Logger 的最低级别。不传则跟随全局级别。
 */
export function createLogger(namespace: string, level?: LogLevel): Logger {
  const nsColor = nsColorCache.get(namespace) ?? pickNamespaceColor(namespace)
  nsColorCache.set(namespace, nsColor)

  function formatLabel(lvl: LogLevel): string {
    return `%c${LEVEL_LABELS[lvl]}%c[${namespace}]%c`
  }

  function formatStyles(lvl: LogLevel): string[] {
    const lvlStyle = LEVEL_STYLES[lvl]
    const nsStyle = `color:${nsColor}; font-weight:600;`
    const resetStyle = 'color:inherit;'
    return [lvlStyle, nsStyle, resetStyle]
  }

  function log(lvl: LogLevel, message: string, ...args: unknown[]) {
    if (!globalConfig.enabled) return
    if (level && LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return
    if (!meetsLevel(lvl)) return

    const ts = getTimestamp()
    const label = formatLabel(lvl)
    const styles = formatStyles(lvl)
    const fullMsg = `${message}`

    // 控制台输出
    switch (lvl) {
      case 'trace':
        console.debug(label + fullMsg, ...styles, ...args)
        break
      case 'debug':
        console.debug(label + fullMsg, ...styles, ...args)
        break
      case 'info':
        console.info(label + fullMsg, ...styles, ...args)
        break
      case 'warn':
        console.warn(label + fullMsg, ...styles, ...args)
        break
      case 'error':
        console.error(label + fullMsg, ...styles, ...args)
        break
    }

    // 入环形缓冲
    const entry: LogEntry = {
      timestamp: ts,
      level: lvl,
      namespace,
      message: fullMsg,
      args: args.length > 0 ? args : undefined,
      source: detectWindowSource(),
    }
    pushToBuffer(entry)

    // 通知 UI 订阅者
    subscribers.forEach(cb => { try { cb(entry) } catch { /* ignore */ } })

    // 跨窗口广播（让日志窗口实时看到其它窗口的日志）
    ensureBroadcastChannel()
    try {
      bc?.postMessage({
        ...entry,
        message: formattedMessage(entry), // 广播展开后的完整消息
        source: entry.source || detectWindowSource(),
      })
    } catch { /* ignore */ }

    // 文件持久化（全部级别写入文件，2 秒节流批量写入）
    enqueueFileWrite(entry)
    scheduleFileFlush()
  }

  return {
    trace: (msg, ...args) => log('trace', msg, ...args),
    debug: (msg, ...args) => log('debug', msg, ...args),
    info: (msg, ...args) => log('info', msg, ...args),
    warn: (msg, ...args) => log('warn', msg, ...args),
    error: (msg, ...args) => log('error', msg, ...args),
    ns: namespace,
  }
}
