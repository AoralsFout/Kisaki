/**
 * 结构化日志系统
 *
 * 特性：
 * - 命名空间隔离（每个模块独立 Logger）
 * - 5 级日志 trace / debug / info / warn / error
 * - 彩色控制台输出（namespace 着色 + 级别标签）
 * - 运行时动态调整日志级别（生产/开发环境自适应）
 * - 内存环形缓冲区（保留最近 N 条日志，供崩溃诊断或 UI 查看器使用）
 * - 严格结构化事件：每条日志必须包含稳定 event，错误必须携带原始异常
 *
 * 使用示例：
 *   import { createLogger } from '../utils/logger'
 *   const log = createLogger('TTS')
 *   log.info('tts.completed', '播报完成', { durationMs })
 *   log.error('tts.failed', '连接失败', error, { requestId })
 */

import {
  DEFAULT_LOG_RETENTION_DAYS,
  STORAGE_LOG_RETENTION_DAYS,
  STORAGE_SENSITIVE_DIAGNOSTICS,
} from '../constants'

// ─── 类型定义 ─────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
export const LOG_SCHEMA_VERSION = 2 as const

export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: string
  cause?: SerializedError
  details?: unknown
}

export type LogContext = Record<string, unknown>

export interface LogRecord {
  event: string
  message: string
  context?: LogContext
  error?: unknown
}

export interface LogEntry {
  schemaVersion: typeof LOG_SCHEMA_VERSION
  timestamp: string
  level: LogLevel
  namespace: string
  message: string
  event: string
  /** 完整、可序列化的异常信息 */
  error?: SerializedError
  /** 与本次操作相关的结构化上下文 */
  context?: LogContext
  /** 来源窗口标签 */
  source: string
}

export interface Logger {
  trace: (event: string, message: string, context?: LogContext) => void
  debug: (event: string, message: string, context?: LogContext) => void
  /** 仅在用户主动开启敏感诊断时记录；可能包含对话、路径或工具载荷。 */
  sensitiveDebug: (event: string, message: string, context?: LogContext) => void
  info: (event: string, message: string, context?: LogContext) => void
  warn: (event: string, message: string, error?: unknown, context?: LogContext) => void
  error: (event: string, message: string, error: unknown, context?: LogContext) => void
  /** 致命错误会等待当前日志批次完成落盘。 */
  fatal: (event: string, message: string, error: unknown, context?: LogContext) => Promise<void>
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
    if (entry?.schemaVersion === LOG_SCHEMA_VERSION && entry.timestamp && entry.level && entry.namespace && entry.event) {
      // 通知 UI 订阅者
      try { cb(entry) } catch { /* 忽略 */ }

      // 注意：不在此处写文件——源窗口已经在 log() 中写过了。
      // 若接收方也写，会导致 JSONL 中每条跨窗口日志重复。
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
let flushInFlight: Promise<void> | null = null
let persistenceFailures = 0
let lastPersistenceError: SerializedError | undefined
let droppedEntries = 0

const NORMAL_FLUSH_DELAY = 2000
const MAX_RETRY_DELAY = 30000
const MAX_PENDING_ENTRIES = 5000

/** 获取今日日志文件名（前端侧计算，与 Rust 侧约定） */
function todayLogFilename(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `app-v${LOG_SCHEMA_VERSION}-${y}-${m}-${day}.jsonl`
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

const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)$/i

function serializeUnknown(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (value instanceof Error) return normalizeError(value, seen, depth)
  if (value instanceof Date) return value.toISOString()
  if (depth >= 6) return '[MaxDepth]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const result = value.slice(0, 100).map(item => serializeUnknown(item, seen, depth + 1))
    if (value.length > 100) result.push(`[Truncated ${value.length - 100} items]`)
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : serializeUnknown(child, seen, depth + 1)
  }
  if (Object.keys(value).length > 100) result.__truncated__ = true
  return result
}

/** 将浏览器、Tauri 和第三方库抛出的任意值统一成可持久化异常。 */
export function normalizeError(
  error: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): SerializedError {
  if (error instanceof Error) {
    if (seen.has(error)) return { name: error.name || 'Error', message: '[Circular error]' }
    seen.add(error)
    const withExtras = error as Error & { code?: unknown; cause?: unknown }
    const serialized: SerializedError = {
      name: error.name || 'Error',
      message: redactSensitiveText(error.message || String(error)),
    }
    if (error.stack) serialized.stack = redactSensitiveText(error.stack)
    if (withExtras.code != null) serialized.code = String(withExtras.code)
    if (withExtras.cause != null && depth < 5) {
      serialized.cause = normalizeError(withExtras.cause, seen, depth + 1)
    }
    const extras: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(error)) {
      if (!['name', 'message', 'stack', 'code', 'cause'].includes(key)) {
        extras[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : serializeUnknown(value, seen, depth + 1)
      }
    }
    if (Object.keys(extras).length) serialized.details = extras
    return serialized
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: redactSensitiveText(error) }
  }

  const details = serializeUnknown(error, seen, depth + 1)
  let message = '未知错误'
  if (error && typeof error === 'object' && 'message' in error) {
    message = redactSensitiveText(String((error as { message?: unknown }).message ?? message))
  } else if (details != null) {
    try { message = JSON.stringify(details) } catch { message = String(details) }
  }
  return { name: 'Error', message, details }
}

function serializeEntry(entry: LogEntry): LogEntry {
  return {
    ...entry,
    message: redactSensitiveText(entry.message),
    error: entry.error ? serializeUnknown(entry.error) as SerializedError : undefined,
    context: entry.context ? serializeUnknown(entry.context) as LogContext : undefined,
  }
}

function publishInternalDiagnostic(
  level: LogLevel,
  message: string,
  error?: unknown,
  context?: LogContext,
) {
  const entry: LogEntry = {
    schemaVersion: LOG_SCHEMA_VERSION,
    timestamp: getTimestamp(),
    level,
    namespace: 'Logger',
    event: level === 'error' ? 'logger.persistence_failed' : 'logger.persistence_recovered',
    message,
    error: error === undefined ? undefined : normalizeError(error),
    context,
    source: detectWindowSource(),
  }
  const safeEntry = serializeEntry(entry)
  pushToBuffer(safeEntry)
  subscribers.forEach(cb => { try { cb(safeEntry) } catch { /* 忽略 */ } })
  ensureBroadcastChannel()
  try { bc?.postMessage(safeEntry) } catch { /* 忽略 */ }
}

/** Windows 盘符路径和 UNC 路径。空格允许出现在路径中；宁可多遮盖少量文案，也不泄漏路径尾部。 */
const WINDOWS_ABS_PATH = /(?:\\\\\?\\(?:UNC\\)?|\\\\)[^\\\r\n"'`,;{}<>|]+\\[^\r\n"'`,;{}<>|)]+|(?:\\\\\?\\)?[A-Za-z]:\\[^\r\n"'`,;{}<>|)]+/g

/** 把 Windows 绝对路径整体替换为 `[PATH]`。 */
export function redactWindowsPath(text: string): string {
  return text.replace(WINDOWS_ABS_PATH, '[PATH]')
}

export function isSensitiveDiagnosticsEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_SENSITIVE_DIAGNOSTICS) === '1' } catch { return false }
}

export function setSensitiveDiagnosticsEnabled(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_SENSITIVE_DIAGNOSTICS, enabled ? '1' : '0') } catch { /* 忽略 */ }
}

export function getLogRetentionDays(): number {
  try {
    const parsed = Number(localStorage.getItem(STORAGE_LOG_RETENTION_DAYS))
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_LOG_RETENTION_DAYS
  } catch {
    return DEFAULT_LOG_RETENTION_DAYS
  }
}

export async function setLogRetentionDays(days: number): Promise<void> {
  const normalized = Math.min(365, Math.max(1, Math.round(days)))
  try { localStorage.setItem(STORAGE_LOG_RETENTION_DAYS, String(normalized)) } catch { /* 忽略 */ }
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('prune_log_files', { retentionDays: normalized })
  } catch (error) {
    publishInternalDiagnostic('error', '清理过期日志失败', error, { retentionDays: normalized })
  }
}

/**
 * 写入磁盘或跨窗口广播前移除常见敏感形态：密钥、用户原文与本地路径。
 * 仅处理字符串表示层，不修改调用方持有的原始对象。
 * 用户原文的消息体本身由各调用方只记录长度/ID，此处兜底移除残留的绝对路径。
 */
export function redactSensitiveText(text: string): string {
  let out = text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
  out = redactWindowsPath(out)
  return out
}

// ─── 文件持久化 ──────────────────────────────────────

async function flushFileEntries(): Promise<void> {
  if (flushInFlight) return flushInFlight
  if (!filePersistenceEnabled || pendingFileEntries.length === 0) return

  const batch = pendingFileEntries.splice(0)
  flushInFlight = (async () => {
    try {
      const recoveredFailures = persistenceFailures
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('append_log_entries', {
        filename: todayLogFilename(),
        entries: batch.map(serializeEntry),
      })
      persistenceFailures = 0
      lastPersistenceError = undefined
      if (recoveredFailures > 0) {
        publishInternalDiagnostic('info', '日志写入已恢复', undefined, { recoveredFailures })
      }
    } catch (error) {
      // 写失败时恢复批次，避免最需要诊断的日志被永久丢弃。
      pendingFileEntries.unshift(...batch)
      persistenceFailures++
      lastPersistenceError = normalizeError(error)
      console.error('[Logger] 日志落盘失败，将自动重试:', error)
      if (persistenceFailures === 1 || (persistenceFailures & (persistenceFailures - 1)) === 0) {
        publishInternalDiagnostic('error', '日志写入失败，诊断文件可能不完整；系统将自动重试', error, {
          failures: persistenceFailures,
          pending: pendingFileEntries.length,
        })
      }
    } finally {
      flushInFlight = null
      if (pendingFileEntries.length > 0 && filePersistenceEnabled) {
        const delay = persistenceFailures > 0
          ? Math.min(NORMAL_FLUSH_DELAY * (2 ** (persistenceFailures - 1)), MAX_RETRY_DELAY)
          : NORMAL_FLUSH_DELAY
        scheduleFileFlush(delay)
      }
    }
  })()
  return flushInFlight
}

function scheduleFileFlush(delay = NORMAL_FLUSH_DELAY) {
  if (!filePersistenceEnabled) return
  if (fileWriteTimer) return
  fileWriteTimer = setTimeout(() => {
    fileWriteTimer = null
    void flushFileEntries()
  }, delay)
}

/** 添加日志条目到待写入队列 */
function enqueueFileWrite(entry: LogEntry) {
  if (!filePersistenceEnabled) return
  pendingFileEntries.push(entry)
  if (pendingFileEntries.length > MAX_PENDING_ENTRIES) {
    const overflow = pendingFileEntries.length - MAX_PENDING_ENTRIES
    pendingFileEntries.splice(0, overflow)
    droppedEntries += overflow
  }
}

/** 立即尝试写完当前队列，供错误处理、导出和窗口关闭前调用。 */
export async function flushLogs(): Promise<void> {
  if (fileWriteTimer) {
    clearTimeout(fileWriteTimer)
    fileWriteTimer = null
  }
  await flushFileEntries()
  // 若等待既有写入期间又产生了日志，成功后继续排空；失败则交给退避重试。
  if (pendingFileEntries.length > 0 && persistenceFailures === 0) {
    await flushFileEntries()
  }
}

export function getPersistenceStatus() {
  return {
    enabled: filePersistenceEnabled,
    pending: pendingFileEntries.length,
    failures: persistenceFailures,
    dropped: droppedEntries,
    lastError: lastPersistenceError,
  }
}

/**
 * 启用 Tauri 文件持久化。
 * 日志会以 2 秒为间隔批量写入 Tauri 后端日志文件。
 * 持久化失败会进入有界重试队列，并在状态中显式暴露。
 *
 * 模块初始化时会自动检测 Tauri 环境并调用此方法。
 */
export async function enableFilePersistence() {
  if (filePersistenceEnabled) return
  filePersistenceEnabled = true
  // 启用落盘时顺便执行保留策略；失败只影响清理，不阻断新日志。
  void setLogRetentionDays(getLogRetentionDays())
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
if (typeof window !== 'undefined' && isTauri()) {
  void enableFilePersistence()
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
  pendingFileEntries = []
  persistenceFailures = 0
  lastPersistenceError = undefined
  droppedEntries = 0
}

/** 获取当前配置（外部只读快照） */
export function getConfig(): LoggerConfig {
  return { ...globalConfig }
}

// ─── Logger 工厂 ──────────────────────────────────────

const nsColorCache = new Map<string, string>()
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

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

  function log(lvl: LogLevel, record: LogRecord, forceLevel = false) {
    if (!EVENT_NAME_PATTERN.test(record.event)) {
      throw new TypeError(`无效的日志事件名: ${record.event}`)
    }
    if (!globalConfig.enabled) return
    if (!forceLevel && level && LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return
    if (!forceLevel && !meetsLevel(lvl)) return

    const ts = getTimestamp()
    const label = formatLabel(lvl)
    const styles = formatStyles(lvl)
    const fullMsg = `${record.message}`
    const consoleDetails = {
      ...(record.context ? { context: record.context } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    }

    // 控制台输出
    switch (lvl) {
      case 'trace':
        console.debug(label + `[${record.event}] ${fullMsg}`, ...styles, consoleDetails)
        break
      case 'debug':
        console.debug(label + `[${record.event}] ${fullMsg}`, ...styles, consoleDetails)
        break
      case 'info':
        console.info(label + `[${record.event}] ${fullMsg}`, ...styles, consoleDetails)
        break
      case 'warn':
        console.warn(label + `[${record.event}] ${fullMsg}`, ...styles, consoleDetails)
        break
      case 'error':
        console.error(label + `[${record.event}] ${fullMsg}`, ...styles, consoleDetails)
        break
    }

    // 内存查看器、跨窗口与文件只接收脱敏副本；原始值最多出现在当前开发者控制台。
    const entry: LogEntry = {
      schemaVersion: LOG_SCHEMA_VERSION,
      timestamp: ts,
      level: lvl,
      namespace,
      message: fullMsg,
      event: record.event,
      error: record.error !== undefined ? normalizeError(record.error) : undefined,
      context: record.context,
      source: detectWindowSource(),
    }
    const safeEntry = serializeEntry(entry)
    pushToBuffer(safeEntry)

    // 通知 UI 订阅者
    subscribers.forEach(cb => { try { cb(safeEntry) } catch { /* 忽略 */ } })

    // 跨窗口广播（让日志窗口实时看到其它窗口的日志）
    ensureBroadcastChannel()
    try {
      bc?.postMessage(safeEntry)
    } catch { /* 忽略 */ }

    // 文件持久化（全部级别写入文件，2 秒节流批量写入）
    enqueueFileWrite(safeEntry)
    if (lvl === 'error') void flushLogs()
    else scheduleFileFlush()
  }

  return {
    trace: (event, message, context) => log('trace', { event, message, context }),
    debug: (event, message, context) => log('debug', { event, message, context }),
    sensitiveDebug: (event, message, context) => {
      // 生产环境默认级别是 info；显式开启敏感诊断后仍必须能够采集这些 debug 事件。
      if (isSensitiveDiagnosticsEnabled()) log('debug', { event, message, context }, true)
    },
    info: (event, message, context) => log('info', { event, message, context }),
    warn: (event, message, error, context) => log('warn', { event, message, error, context }),
    error: (event, message, error, context) => log('error', { event, message, error, context }),
    fatal: async (event, message, error, context) => {
      log('error', { event, message, error, context })
      await flushLogs()
    },
    ns: namespace,
  }
}

/** 安装一次当前 WebView 的全局错误采集，返回卸载函数。 */
export function installGlobalErrorHandlers(logger: Logger): () => void {
  if (typeof window === 'undefined') return () => {}

  const onError = (event: ErrorEvent) => {
    void logger.fatal(
      'javascript.uncaught_error',
      '未捕获的 JavaScript 异常',
      event.error ?? event.message,
      { filename: event.filename, line: event.lineno, column: event.colno },
    )
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    void logger.fatal(
      'javascript.unhandled_rejection',
      '未处理的 Promise rejection',
      event.reason,
    )
  }
  const onPageHide = () => { void flushLogs() }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
    window.removeEventListener('pagehide', onPageHide)
  }
}
