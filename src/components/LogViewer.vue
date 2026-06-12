<script setup lang="ts">
/**
 * 日志查看器
 *
 * 显示应用运行时的日志，支持实时/历史模式、级别过滤、
 * 命名空间搜索、关键词搜索和导出功能。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { getBuffer, clearBuffer, subscribe, subscribeCrossWindow } from '../utils/logger'
import type { LogEntry, LogLevel } from '../utils/logger'
import { QUERY_LOGS } from '../constants'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

// ─── 窗口模式 ─────────────────────────────────────────

/** 是否作为独立 Tauri 窗口运行 (?logs=1) */
const isStandalone = new URLSearchParams(window.location.search).has(QUERY_LOGS)

// ─── 类型 ─────────────────────────────────────────────

interface DisplayEntry {
  id: number
  timestamp: string
  level: LogLevel
  namespace: string
  message: string
  args?: unknown[]
  /** 来源窗口 */
  source?: string
  /** 是否展开显示详细内容 */
  expanded: boolean
}

// ─── 状态 ─────────────────────────────────────────────

const ALL_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'TRC', debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR',
}

const LEVEL_BG: Record<LogLevel, string> = {
  trace: '#888',
  debug: '#4fc3f7',
  info: '#81c784',
  warn: '#ffb74d',
  error: '#ef5350',
}

const entries = ref<DisplayEntry[]>([])
let nextId = 0

// ─── 日志条目节流（rAF 批量刷新） ──────────────────────
const pendingEntries: DisplayEntry[] = []
let flushRafId = 0

/** 将缓冲条目一次性刷新到响应式数组（限制 60fps） */
function flushPendingEntries() {
  flushRafId = 0
  if (pendingEntries.length === 0) return

  const batch = pendingEntries.splice(0)
  entries.value.push(...batch)

  // 限制内存
  if (entries.value.length > 5000) {
    entries.value.splice(0, entries.value.length - 4000)
  }

  // 自动滚动
  if (autoScroll.value) {
    requestAnimationFrame(() => {
      if (logListRef.value && autoScroll.value) {
        logListRef.value.scrollTop = logListRef.value.scrollHeight
      }
    })
  } else {
    hasNewLogs.value = true
  }
}

// 过滤器
const enabledLevels = ref<Set<LogLevel>>(new Set(isStandalone
  ? ['trace', 'debug', 'info', 'warn', 'error']   // 独立窗口默认显示全部
  : ['info', 'warn', 'error']                       // 内嵌模式默认只显示重要级别
))
const namespaceFilter = ref('')
const searchFilter = ref('')

// 模式
type ViewMode = 'realtime' | 'history'
const mode = ref<ViewMode>('realtime')

// 历史模式
const historyEntries = ref<DisplayEntry[]>([])
const historyLoading = ref(false)
const historyError = ref('')
const availableLogFiles = ref<string[]>([])
const selectedLogFile = ref('')

// 滚动
const logListRef = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const hasNewLogs = ref(false)
let userScrolling = false

// 统计
const now = ref(Date.now())
const tickTimer = ref<ReturnType<typeof setInterval> | null>(null)

// ─── 计算属性 ─────────────────────────────────────────

const filteredEntries = computed(() => {
  const source = mode.value === 'realtime' ? entries.value : historyEntries.value
  return source.filter(e => {
    if (!enabledLevels.value.has(e.level)) return false
    if (namespaceFilter.value && !e.namespace.toLowerCase().includes(namespaceFilter.value.toLowerCase())) return false
    if (searchFilter.value && !e.message.toLowerCase().includes(searchFilter.value.toLowerCase())) return false
    return true
  })
})

const stats = computed(() => {
  const counts: Record<string, number> = { total: 0 }
  for (const lvl of ALL_LEVELS) counts[lvl] = 0
  for (const e of entries.value) {
    counts.total++
    counts[e.level] = (counts[e.level] || 0) + 1
  }
  return counts
})

const filteredStats = computed(() => {
  const counts: Record<string, number> = { total: 0 }
  for (const lvl of ALL_LEVELS) counts[lvl] = 0
  for (const e of filteredEntries.value) {
    counts.total++
    counts[e.level] = (counts[e.level] || 0) + 1
  }
  return counts
})

// ─── 方法 ─────────────────────────────────────────────

function toggleLevel(lvl: LogLevel) {
  const next = new Set(enabledLevels.value)
  if (next.has(lvl)) {
    // 至少保留一个级别
    if (next.size <= 1) return
    next.delete(lvl)
  } else {
    next.add(lvl)
  }
  enabledLevels.value = next
}

function toggleAllLevels() {
  if (enabledLevels.value.size === ALL_LEVELS.length) {
    enabledLevels.value = new Set(['error'])
  } else {
    enabledLevels.value = new Set(ALL_LEVELS)
  }
}

function toggleExpand(entry: DisplayEntry) {
  entry.expanded = !entry.expanded
}

function handleScroll() {
  if (!logListRef.value) return
  const el = logListRef.value
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  if (dist < 80) {
    autoScroll.value = true
    hasNewLogs.value = false
  } else if (userScrolling) {
    autoScroll.value = false
  }
}

function scrollToBottom() {
  if (!logListRef.value) return
  logListRef.value.scrollTop = logListRef.value.scrollHeight
  autoScroll.value = true
  hasNewLogs.value = false
}

function formatTime(ts: string): string {
  // ISO → HH:MM:SS.mmm
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

function formatArgsDisplay(args?: unknown[]): string {
  if (!args || args.length === 0) return ''
  return args.map(a => {
    if (a instanceof Error) return `Error: ${a.message}\n${a.stack || ''}`
    try { return JSON.stringify(a, null, 2) } catch { return String(a) }
  }).join('\n---\n')
}

// ─── 实时模式（rAF 节流） ────────────────────────────

function addEntry(entry: LogEntry) {
  const display: DisplayEntry = {
    id: nextId++,
    timestamp: entry.timestamp,
    level: entry.level,
    namespace: entry.namespace,
    message: entry.message,
    args: entry.args,
    source: entry.source,
    expanded: false,
  }
  // 写入缓冲队列，在下一个 rAF 批量推入响应式数组
  pendingEntries.push(display)
  if (!flushRafId) {
    flushRafId = requestAnimationFrame(flushPendingEntries)
  }
}

// ─── 历史模式 ─────────────────────────────────────────

async function loadHistory() {
  if (!selectedLogFile.value) return
  historyLoading.value = true
  historyError.value = ''
  historyEntries.value = []

  try {
    const result: Array<{
      line: number
      timestamp: string
      level: string
      namespace: string
      message: string
      source: string
    }> = await invoke('read_log_file', { filename: selectedLogFile.value })

    historyEntries.value = result.map(r => ({
      id: nextId++,
      timestamp: r.timestamp,
      level: (ALL_LEVELS.includes(r.level as LogLevel) ? r.level : 'info') as LogLevel,
      namespace: r.namespace,
      message: r.message,
      source: r.source || undefined,
      expanded: false,
    }))
  } catch (e) {
    historyError.value = (e as Error).message
  } finally {
    historyLoading.value = false
  }
}

async function refreshLogFileList() {
  try {
    availableLogFiles.value = await invoke<string[]>('list_log_files')
    if (availableLogFiles.value.length > 0 && !selectedLogFile.value) {
      selectedLogFile.value = availableLogFiles.value[0]
    }
  } catch {
    availableLogFiles.value = []
  }
}

// ─── 导出 ─────────────────────────────────────────────

async function exportLog() {
  try {
    const destPath = await save({
      title: '导出日志文件',
      defaultPath: 'kisaki-logs-' + new Date().toISOString().slice(0, 10) + '.log',
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
      ],
    })

    if (!destPath) return // 用户取消

    if (mode.value === 'history' && selectedLogFile.value) {
      // 历史模式：导出选中的历史文件
      await invoke('export_log_file', {
        sourceFilename: selectedLogFile.value,
        destPath,
      })
    } else {
      // 实时模式：先 flush 再导出当日文件
      const filename = `app-${new Date().toISOString().slice(0, 10)}.jsonl`
      // 尝试导出，如果当日文件不存在则说明没有日志
      try {
        await invoke('export_log_file', {
          sourceFilename: filename,
          destPath,
        })
      } catch {
        // 回退：把内存中的日志写出为一个临时文件再导出
        // 此时直接写入一个简易文本格式到目标路径
        const content = entries.value.map(e =>
          `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.namespace}] ${e.message}`
        ).join('\n')

        // 通过 Tauri 文件写入命令保存
        try {
          await invoke('append_log_entries', {
            filename: '__export_temp.jsonl',
            entries: [{
              timestamp: new Date().toISOString(),
              level: 'info',
              namespace: 'Export',
              message: '用户导出日志',
            }],
          })
          await invoke('export_log_file', {
            sourceFilename: '__export_temp.jsonl',
            destPath,
          })
        } catch {
          // 最终兜底：用 Blob 下载（在 WebView 环境中可能不生效）
          const blob = new Blob([content], { type: 'text/plain' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `kisaki-logs-${new Date().toISOString().slice(0, 10)}.log`
          a.click()
          URL.revokeObjectURL(url)
        }
      }
    }
  } catch (e) {
    console.error('导出日志失败:', e)
  }
}

async function handleClear() {
  if (mode.value === 'realtime') {
    clearBuffer()
    entries.value = []
  }
}

async function switchMode(newMode: ViewMode) {
  mode.value = newMode
  if (newMode === 'history') {
    await refreshLogFileList()
    if (selectedLogFile.value) {
      await loadHistory()
    }
  }
}

// ─── 生命周期 ─────────────────────────────────────────

let unsubLog: (() => void) | null = null
let unsubCrossWindow: (() => void) | null = null
let historyRefreshTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  if (isStandalone) {
    // 独立窗口：从文件加载历史日志（跨窗口共享）
    await refreshLogFileList()
    if (selectedLogFile.value) {
      await loadHistory()
    }
    // 每 5 秒自动刷新历史文件列表和内容
    historyRefreshTimer = setInterval(async () => {
      const prevFile = selectedLogFile.value
      await refreshLogFileList()
      if (selectedLogFile.value !== prevFile || historyEntries.value.length === 0) {
        if (selectedLogFile.value) {
          await loadHistory()
        }
      }
    }, 5000)
  } else {
    // 内嵌模式：加载当前窗口的内存缓冲
    const buf = getBuffer()
    for (const e of buf) {
      addEntry(e)
    }
  }

  // 订阅当前进程内的新日志
  unsubLog = subscribe((entry) => {
    addEntry(entry)
  })

  // 订阅跨窗口广播日志（让日志窗口看到其它窗口的实时日志）
  unsubCrossWindow = subscribeCrossWindow((entry) => {
    addEntry(entry)
  })

  // 自动刷新技术
  tickTimer.value = setInterval(() => {
    now.value = Date.now()
  }, 60000)
})

onUnmounted(() => {
  if (historyRefreshTimer) clearInterval(historyRefreshTimer)
})

onUnmounted(() => {
  if (unsubLog) unsubLog()
  if (unsubCrossWindow) unsubCrossWindow()
  if (historyRefreshTimer) clearInterval(historyRefreshTimer)
  if (tickTimer.value) clearInterval(tickTimer.value)
  if (flushRafId) cancelAnimationFrame(flushRafId)
})

// ─── 窗口控制 ─────────────────────────────────────────

async function closeWindow() {
  try {
    await getCurrentWebviewWindow().close()
  } catch (e) {
    console.warn('[LogViewer] 关闭窗口失败:', e)
  }
}

async function maximizeWindow() {
  let maximized = await getCurrentWebviewWindow().isMaximized()
  if (maximized) {
    try {
      await getCurrentWebviewWindow().unmaximize()
    } catch (e) {
      console.warn('[LogViewer] 取消最大化窗口失败:', e)
    }
  } else {
    try {
      await getCurrentWebviewWindow().maximize()
    } catch (e) {
      console.warn('[LogViewer] 最大化窗口失败:', e)
    }
  }
}

async function minimizeWindow() {
  try {
    await getCurrentWebviewWindow().minimize()
  } catch (e) {
    console.warn('[LogViewer] 最小化窗口失败:', e)
  }
}

// 当用户悬停在列表上时标记为手动滚动
function onWheel() {
  userScrolling = true
  setTimeout(() => { userScrolling = false }, 300)
}
</script>

<template>
  <div class="log-viewer" :class="{ standalone: isStandalone }">
    <!-- ===== 标题栏（独立窗口） ===== -->
    <header v-if="isStandalone" class="topbar" data-tauri-drag-region>
      <span class="topbar-title"><i class="fas fa-receipt"></i> 日志</span>
      <div class="window-controls">
        <button class="win-btn" @click="minimizeWindow" title="最小化">─</button>
        <button class="win-btn" @click="maximizeWindow" title="最大化">□</button>
        <button class="win-btn win-close" @click="closeWindow" title="关闭">✕</button>
      </div>
    </header>

    <!-- ===== 工具栏 ===== -->
    <div class="toolbar">
      <!-- 左区：模式切换 + 级别过滤 -->
      <div class="toolbar-left">
        <div class="mode-tabs">
          <button :class="['mode-tab', { active: mode === 'realtime' }]" @click="switchMode('realtime')">
            <i class="fas fa-bolt"></i> 实时
          </button>
          <button :class="['mode-tab', { active: mode === 'history' }]" @click="switchMode('history')">
            <i class="fas fa-clock-rotate"></i> 历史
          </button>
        </div>

        <div class="level-filters">
          <button v-for="lvl in ALL_LEVELS" :key="lvl" :class="['level-btn', lvl, { active: enabledLevels.has(lvl) }]"
            :style="{ '--lvl-color': LEVEL_BG[lvl] }" @click="toggleLevel(lvl)">
            {{ LEVEL_LABELS[lvl] }}
          </button>
          <button class="level-btn all" :class="{ active: enabledLevels.size === ALL_LEVELS.length }"
            @click="toggleAllLevels">
            全部
          </button>
        </div>

        <!-- 统计 -->
        <span class="stats-text" :title="`显示 ${filteredStats.total} / 共 ${stats.total} 条`">
          {{ filteredStats.total }}/{{ stats.total }}
        </span>
      </div>

      <!-- 右区：搜索 + 操作 -->
      <div class="toolbar-right">
        <!-- 历史模式文件选择 -->
        <select v-if="mode === 'history'" v-model="selectedLogFile" class="file-select" @change="loadHistory">
          <option v-for="f in availableLogFiles" :key="f" :value="f">{{ f }}</option>
        </select>

        <div class="search-box">
          <i class="fas fa-circle-nodes search-icon"></i>
          <input v-model="namespaceFilter" class="search-input" placeholder="命名空间..." title="按命名空间过滤" />
        </div>

        <div class="search-box">
          <i class="fas fa-magnifying-glass search-icon"></i>
          <input v-model="searchFilter" class="search-input" placeholder="搜索..." title="按消息内容搜索" />
        </div>

        <button class="toolbar-btn" title="刷新（仅历史模式）" @click="refreshLogFileList(); loadHistory()">
          <i class="fas fa-rotate"></i>
        </button>
        <button class="toolbar-btn" title="导出日志" @click="exportLog">
          <i class="fas fa-download"></i>
        </button>

        <button v-if="mode === 'realtime'" class="toolbar-btn" title="清空当前日志" @click="handleClear">
          <i class="fas fa-trash-can"></i>
        </button>
      </div>
    </div>

    <!-- ===== 日志列表 ===== -->
    <div ref="logListRef" class="log-list" @scroll="handleScroll" @wheel="onWheel">
      <!-- 空态 -->
      <div v-if="filteredEntries.length === 0 && !historyLoading" class="empty-state">
        <i class="fas fa-inbox empty-icon"></i>
        <p class="empty-text">暂无日志记录</p>
        <p v-if="mode === 'history'" class="empty-hint">选择左侧的日志文件以查看历史记录</p>
        <p v-else class="empty-hint">应用运行时产生的日志将在此显示</p>
      </div>

      <!-- 加载中 -->
      <div v-if="historyLoading" class="loading-state">
        <i class="fas fa-spinner spinning"></i>
        <span>加载中...</span>
      </div>

      <!-- 错误 -->
      <div v-if="historyError" class="error-state">
        <i class="fas fa-triangle-exclamation"></i>
        <span>加载失败: {{ historyError }}</span>
        <button class="retry-btn" @click="loadHistory">重试</button>
      </div>

      <!-- 日志行 -->
      <div v-for="entry in filteredEntries" :key="entry.id" :class="['log-row', { expanded: entry.expanded }]"
        @click="toggleExpand(entry)">
        <div class="log-line">
          <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
          <span class="log-level" :style="{ background: LEVEL_BG[entry.level] }">
            {{ LEVEL_LABELS[entry.level] }}
          </span>
          <span class="log-namespace">{{ entry.namespace }}</span>
          <span v-if="entry.source" class="log-source">{{ entry.source }}</span>
          <span class="log-msg">{{ entry.message }}</span>
          <span v-if="entry.args?.length" class="log-expand-icon">
            <i class="fas fa-chevron-down"></i>
          </span>
        </div>
        <!-- 展开的详细信息 -->
        <div v-if="entry.expanded && entry.args?.length" class="log-detail" @click.stop>
          <pre class="log-detail-pre">{{ formatArgsDisplay(entry.args) }}</pre>
        </div>
      </div>
    </div>

    <!-- ===== 底部新日志提示 ===== -->
    <div v-if="hasNewLogs && !autoScroll" class="new-logs-bar" @click="scrollToBottom">
      <i class="fas fa-arrow-down"></i> 新日志
    </div>
  </div>
</template>

<style scoped>
/* ─── 布局 ──────────────────────────────────────────── */
.log-viewer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: relative;
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 12px;
  overflow: hidden;
}

.log-viewer:not(.standalone) {
  border-radius: 8px;
  height: 100%;
}

/* ─── 标题栏（独立窗口） ──────────────────────────────── */
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  background: #16162a;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
  -webkit-app-region: drag;
  user-select: none;
}

.topbar-title {
  font-size: 13px;
  font-weight: 600;
  color: #aaa;
}

.window-controls {
  -webkit-app-region: no-drag;
  display: flex;
  gap: 4px;
}

.win-btn {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  color: #666;
  padding: 4px 10px;
  border-radius: 6px;
  transition: background 0.1s, color 0.1s;
}

.win-btn:hover {
  background: #2a2a4a;
  color: #ddd;
}

.win-close:hover {
  background: #ef5350;
  color: white;
}

/* ─── 工具栏 ─────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: #16162a;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* 模式切换 */
.mode-tabs {
  display: flex;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  overflow: hidden;
}

.mode-tab {
  padding: 4px 10px;
  font-size: 11px;
  border: none;
  background: transparent;
  color: #888;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-tab.active {
  background: #3a3a5a;
  color: #fff;
}

.mode-tab:hover:not(.active) {
  color: #ccc;
}

/* 级别过滤 */
.level-filters {
  display: flex;
  gap: 3px;
}

.level-btn {
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: #666;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.level-btn.active {
  border-color: var(--lvl-color);
  color: var(--lvl-color);
  background: color-mix(in srgb, var(--lvl-color) 15%, transparent);
}

.level-btn.trace.active {
  color: #888;
  border-color: #888;
}

.level-btn.debug.active {
  color: #4fc3f7;
  border-color: #4fc3f7;
}

.level-btn.info.active {
  color: #81c784;
  border-color: #81c784;
}

.level-btn.warn.active {
  color: #ffb74d;
  border-color: #ffb74d;
}

.level-btn.error.active {
  color: #ef5350;
  border-color: #ef5350;
}

.level-btn.all.active {
  border-color: #aaa;
  color: #aaa;
  background: color-mix(in srgb, #aaa 15%, transparent);
}

/* 统计 */
.stats-text {
  font-size: 10px;
  color: #555;
  font-family: 'Consolas', monospace;
  padding: 0 4px;
}

/* 搜索 */
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 7px;
  font-size: 10px;
  color: #555;
  pointer-events: none;
}

.search-input {
  width: 100px;
  padding: 4px 6px 4px 22px;
  font-size: 11px;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: #1e1e38;
  color: #ccc;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: #4a4a7a;
}

.search-input::placeholder {
  color: #555;
}

/* 工具栏按钮 */
.toolbar-btn {
  padding: 4px 8px;
  font-size: 13px;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: transparent;
  color: #888;
  cursor: pointer;
  transition: all 0.15s;
}

.toolbar-btn:hover {
  background: #2a2a4a;
  color: #ddd;
}

/* 历史文件选择 */
.file-select {
  padding: 4px 8px;
  font-size: 11px;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  background: #1e1e38;
  color: #ccc;
  outline: none;
  font-family: inherit;
  cursor: pointer;
  max-width: 160px;
}

/* ─── 日志列表 ───────────────────────────────────────── */
.log-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.log-list::-webkit-scrollbar {
  width: 6px;
}

.log-list::-webkit-scrollbar-track {
  background: transparent;
}

.log-list::-webkit-scrollbar-thumb {
  background: #2a2a4a;
  border-radius: 3px;
}

/* 空态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: #555;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.empty-text {
  font-size: 13px;
  margin: 0 0 4px;
}

.empty-hint {
  font-size: 11px;
  margin: 0;
  color: #444;
}

/* 加载中 */
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100px;
  color: #888;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

/* 错误态 */
.error-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: #ef5350;
  font-size: 12px;
}

.retry-btn {
  padding: 4px 12px;
  font-size: 11px;
  border: 1px solid #ef5350;
  border-radius: 6px;
  background: transparent;
  color: #ef5350;
  cursor: pointer;
  font-family: inherit;
}

.retry-btn:hover {
  background: color-mix(in srgb, #ef5350 15%, transparent);
}

/* ─── 日志行 ─────────────────────────────────────────── */
.log-row {
  padding: 2px 12px;
  cursor: pointer;
  transition: background 0.1s;
  border-bottom: 1px solid rgba(255, 255, 255, 0.02);
}

.log-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.log-row.expanded {
  background: rgba(255, 255, 255, 0.05);
}

.log-line {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.6;
}

.log-time {
  color: #555;
  font-size: 10px;
  flex-shrink: 0;
  min-width: 78px;
}

.log-level {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  color: #fff;
  flex-shrink: 0;
  min-width: 24px;
  text-align: center;
}

.log-namespace {
  color: #7c7cba;
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-source {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  color: #888;
  flex-shrink: 0;
  font-weight: 400;
}

.log-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d0d0d0;
}

.log-expand-icon {
  flex-shrink: 0;
  color: #555;
  font-size: 9px;
}

/* ─── 展开详情 ───────────────────────────────────────── */
.log-detail {
  padding: 6px 0 6px 86px;
}

.log-detail-pre {
  margin: 0;
  font-size: 11px;
  color: #aaa;
  background: rgba(0, 0, 0, 0.3);
  padding: 8px 12px;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ─── 底部新日志提示 ─────────────────────────────────── */
.new-logs-bar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 16px;
  background: #3a3a7a;
  color: #ccc;
  border-radius: 20px;
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  transition: background 0.15s;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
}

.new-logs-bar:hover {
  background: #5a5a9a;
}
</style>
