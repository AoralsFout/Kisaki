<script setup lang="ts">
/**
 * 会话上下文检查器
 *
 * 默认显示打开设置窗口时读取的当前会话；选择其它会话只改变检查目标。
 * 页面展示明确的静态快照，只有用户手动刷新时才重新读取持久化会话数据。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useSessionStore } from '../../stores/session'
import {
  attachCurrentSession,
  inspectSavedSession,
  type ContextInspectionSnapshot,
  type ContextSessionInspection,
} from '../../contextInspector'
import type { ContextInspectionMessage } from '../../ai'
import type { ToolDefinition } from '../../agent'

const { t, locale } = useI18n()
const chat = useChatStore()
const sessionStore = useSessionStore()

type FilterKey = 'all' | 'system' | 'user' | 'assistant' | 'tool' | 'definition' | 'meta'
type ItemKind = 'message' | 'definition' | 'meta'

interface ContextListItem {
  id: string
  kind: ItemKind
  role: FilterKey
  title: string
  subtitle: string
  summary: string
  tokens?: number
  raw: unknown
}

const snapshot = ref<ContextInspectionSnapshot | null>(null)
const selectedSessionId = ref('')
const followsCurrent = ref(true)
const refreshing = ref(false)
const query = ref('')
const activeFilter = ref<FilterKey>('all')
const selectedItemId = ref('')
const copied = ref(false)
const drawerClose = ref<HTMLButtonElement | null>(null)
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
let lastTrigger: HTMLElement | null = null

function captureLocalSnapshot(): ContextInspectionSnapshot {
  const currentId = sessionStore.currentSessionId
  const current = chat.inspectContext()
  const sessions = sessionStore.sessionList.map(session => session.id === currentId
    ? attachCurrentSession(current, { ...session, messages: chat.messages })
    : inspectSavedSession(session, current))
  return { capturedAt: Date.now(), currentSessionId: currentId, sessions }
}

const sessions = computed(() => snapshot.value?.sessions ?? [])
const selectedSession = computed<ContextSessionInspection | null>(() =>
  sessions.value.find(session => session.sessionId === selectedSessionId.value) ?? null,
)

watch(snapshot, value => {
  if (!value) return
  const selectedStillExists = value.sessions.some(session => session.sessionId === selectedSessionId.value)
  if (!selectedStillExists || followsCurrent.value) selectedSessionId.value = value.currentSessionId
}, { immediate: true })

watch(selectedSessionId, () => {
  selectedItemId.value = ''
  copied.value = false
})

function onSessionChange() {
  followsCurrent.value = selectedSessionId.value === snapshot.value?.currentSessionId
}

function followCurrentSession() {
  followsCurrent.value = true
  selectedSessionId.value = snapshot.value?.currentSessionId ?? ''
}

async function refreshSnapshot() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await sessionStore.init()
    snapshot.value = captureLocalSnapshot()
    now.value = Date.now()
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  snapshot.value = captureLocalSnapshot()
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  window.addEventListener('keydown', onWindowKeydown)
})

onUnmounted(() => {
  if (clockTimer !== null) clearInterval(clockTimer)
  window.removeEventListener('keydown', onWindowKeydown)
})

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selectedItemId.value) closeDrawer()
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale.value).format(Math.round(value || 0))
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(timestamp)
}

const updateAge = computed(() => {
  const seconds = Math.max(0, Math.floor((now.value - (snapshot.value?.capturedAt ?? now.value)) / 1000))
  if (seconds < 2) return t('settings.context.justNow')
  return t('settings.context.secondsAgo', { n: seconds })
})

function messageText(message: ContextInspectionMessage): string {
  const content = typeof message.content === 'string'
    ? message.content
    : message.content.map(part => part.type === 'text' ? part.text : part.image_url.url).join(' ')
  const calls = message.tool_calls?.map(call => call.function.name).join(', ') || ''
  return [content, calls].filter(Boolean).join(' · ')
}

function compact(value: string, limit = 150): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return t('settings.context.emptyContent')
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

function roleTitle(message: ContextInspectionMessage): string {
  if (message.origin === 'summary') return t('settings.context.roles.summary')
  return t(`settings.context.roles.${message.role}`)
}

function messageSubtitle(message: ContextInspectionMessage): string {
  if (message.tool_calls?.length) {
    return t('settings.context.toolCalls', { n: message.tool_calls.length })
  }
  if (message.tool_call_id) return t('settings.context.toolResult', { id: message.tool_call_id })
  return t(`settings.context.origin.${message.origin}`)
}

function buildItems(session: ContextSessionInspection): ContextListItem[] {
  const metadata: ContextListItem[] = [
    {
      id: 'meta-request', kind: 'meta', role: 'meta',
      title: t('settings.context.meta.request'),
      subtitle: session.model || t('settings.context.notConfigured'),
      summary: compact([session.endpoint, session.persona?.render, session.persona?.voiceLang, session.persona?.displayLang]
        .filter(Boolean).join(' · ')),
      raw: {
        model: session.model || null,
        endpoint: session.endpoint || null,
        persona: session.persona,
        characterId: session.characterId || null,
        workspaceRoot: session.workspaceRoot || null,
        maxRounds: session.maxRounds || null,
        turnReminderApplied: session.hasTurnReminder,
        dataSource: session.source,
        capturedAt: new Date(session.capturedAt).toISOString(),
      },
    },
    {
      id: 'meta-budget', kind: 'meta', role: 'meta',
      title: t('settings.context.meta.budget'),
      subtitle: `${formatNumber(session.stats.estimatedTokens)} / ${formatNumber(session.stats.maxContextTokens)} tokens`,
      summary: t('settings.context.meta.budgetSummary', {
        messages: session.stats.messageCount,
        tools: session.toolDefinitions.length,
        summarized: session.stats.summarizedRounds,
      }),
      raw: session.stats,
    },
    {
      id: 'meta-runtime', kind: 'meta', role: 'meta',
      title: t('settings.context.meta.runtime'),
      subtitle: session.runtime.processing
        ? t('settings.context.runtime.processing')
        : t('settings.context.runtime.idle'),
      summary: session.runtime.pendingConfirmation
        ? t('settings.context.runtime.pending', { name: session.runtime.pendingConfirmation.toolName })
        : t('settings.context.runtime.activityCount', { n: session.runtime.activities.length }),
      raw: session.runtime,
    },
  ]

  const messages: ContextListItem[] = session.messages.map(message => ({
    id: `message-${message.position}`,
    kind: 'message',
    role: message.role,
    title: `${String(message.position).padStart(2, '0')} · ${roleTitle(message)}`,
    subtitle: messageSubtitle(message),
    summary: compact(messageText(message)),
    tokens: message.estimatedTokens,
    raw: message,
  }))

  const definitions: ContextListItem[] = session.toolDefinitions.map((definition: ToolDefinition, index) => ({
    id: `definition-${definition.function.name}-${index}`,
    kind: 'definition',
    role: 'definition',
    title: definition.function.name,
    subtitle: t('settings.context.roles.definition'),
    summary: compact(definition.function.description || ''),
    raw: definition,
  }))
  return [...metadata, ...messages, ...definitions]
}

const allItems = computed(() => selectedSession.value ? buildItems(selectedSession.value) : [])
const filteredItems = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return allItems.value.filter(item => {
    if (activeFilter.value !== 'all' && item.role !== activeFilter.value) return false
    if (!normalizedQuery) return true
    return `${item.title} ${item.subtitle} ${item.summary} ${JSON.stringify(item.raw)}`
      .toLocaleLowerCase().includes(normalizedQuery)
  })
})
const selectedItem = computed(() => allItems.value.find(item => item.id === selectedItemId.value) ?? null)
const detailJson = computed(() => selectedItem.value ? JSON.stringify(selectedItem.value.raw, null, 2) : '')

const filters: Array<{ key: FilterKey; icon: string }> = [
  { key: 'all', icon: 'fa-layer-group' },
  { key: 'system', icon: 'fa-shield-halved' },
  { key: 'user', icon: 'fa-user' },
  { key: 'assistant', icon: 'fa-wand-magic-sparkles' },
  { key: 'tool', icon: 'fa-terminal' },
  { key: 'definition', icon: 'fa-puzzle-piece' },
  { key: 'meta', icon: 'fa-circle-info' },
]

async function openDrawer(item: ContextListItem, event: MouseEvent) {
  lastTrigger = event.currentTarget as HTMLElement
  selectedItemId.value = item.id
  copied.value = false
  await nextTick()
  drawerClose.value?.focus()
}

async function closeDrawer() {
  selectedItemId.value = ''
  copied.value = false
  await nextTick()
  lastTrigger?.focus()
  lastTrigger = null
}

async function copyDetail() {
  if (!detailJson.value) return
  try {
    await navigator.clipboard.writeText(detailJson.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
  } catch { copied.value = false }
}
</script>

<template>
  <section class="context-page">
    <header class="context-header">
      <div>
        <h2 class="section-title"><i class="fas fa-layer-group"></i> {{ t('settings.context.title') }}</h2>
        <p class="section-desc">{{ t('settings.context.desc') }}</p>
      </div>
      <div class="snapshot-status" aria-live="polite">
        <i class="fas fa-camera"></i>
        <span>{{ t('settings.context.nonRealtime') }}</span>
        <span class="status-age">· {{ updateAge }}</span>
      </div>
    </header>

    <div class="session-toolbar">
      <label class="session-field">
        <span>{{ t('settings.context.sessionLabel') }}</span>
        <select v-model="selectedSessionId" class="session-select" @change="onSessionChange">
          <option v-for="session in sessions" :key="session.sessionId" :value="session.sessionId">
            {{ session.sessionName }}{{ session.isCurrent ? ` · ${t('common.current')}` : '' }}
          </option>
        </select>
      </label>
      <button v-if="!followsCurrent" class="follow-button" type="button" @click="followCurrentSession">
        <i class="fas fa-location-arrow"></i> {{ t('settings.context.followCurrent') }}
      </button>
      <button class="refresh-button" type="button" :disabled="refreshing" @click="refreshSnapshot">
        <i class="fas fa-rotate-right" :class="{ spinning: refreshing }"></i>
        {{ refreshing ? t('settings.context.refreshing') : t('settings.context.refresh') }}
      </button>
    </div>

    <template v-if="selectedSession">
      <div class="snapshot-note non-live-note" role="note">
        <i class="fas fa-circle-info"></i>
        <span>{{ t('settings.context.nonRealtimeNote') }}</span>
      </div>

      <div class="budget-card">
        <div class="budget-primary">
          <span class="budget-value">{{ formatNumber(selectedSession.stats.estimatedTokens) }}</span>
          <span class="budget-unit">/ {{ formatNumber(selectedSession.stats.maxContextTokens) }} tokens</span>
        </div>
        <div class="budget-meter" role="progressbar" :aria-valuenow="Math.round(selectedSession.stats.utilization * 100)"
          aria-valuemin="0" aria-valuemax="100">
          <span :style="{ width: `${Math.min(100, selectedSession.stats.utilization * 100)}%` }"></span>
        </div>
        <div class="budget-facts">
          <span><strong>{{ selectedSession.stats.messageCount }}</strong> {{ t('settings.context.metrics.messages') }}</span>
          <span><strong>{{ selectedSession.toolDefinitions.length }}</strong> {{ t('settings.context.metrics.tools') }}</span>
          <span><strong>{{ selectedSession.stats.summarizedRounds }}</strong> {{ t('settings.context.metrics.summaries') }}</span>
          <span><strong>{{ selectedSession.stats.prunedMessages }}</strong> {{ t('settings.context.metrics.pruned') }}</span>
        </div>
      </div>

      <div v-if="selectedSession.source === 'saved'" class="snapshot-note" role="status">
        <i class="fas fa-box-archive"></i>
        <span>{{ t(`settings.context.snapshotNote.${selectedSession.source}`) }}</span>
      </div>

      <div class="context-controls">
        <label class="search-field">
          <i class="fas fa-magnifying-glass"></i>
          <span class="sr-only">{{ t('settings.context.search') }}</span>
          <input v-model="query" type="search" :placeholder="t('settings.context.search')">
        </label>
        <div class="filter-row" :aria-label="t('settings.context.filterLabel')">
          <button v-for="filter in filters" :key="filter.key" type="button"
            :class="['filter-button', { active: activeFilter === filter.key }]"
            :aria-pressed="activeFilter === filter.key" @click="activeFilter = filter.key">
            <i class="fas" :class="filter.icon"></i>
            <span>{{ t(`settings.context.filters.${filter.key}`) }}</span>
          </button>
        </div>
      </div>

      <div class="context-list" :aria-label="t('settings.context.listLabel')">
        <button v-for="item in filteredItems" :key="item.id" type="button"
          :class="['context-row', `role-${item.role}`]" @click="openDrawer(item, $event)">
          <span class="track"><span class="track-dot"></span></span>
          <span class="row-main">
            <span class="row-heading">
              <strong>{{ item.title }}</strong>
              <span class="row-subtitle">{{ item.subtitle }}</span>
            </span>
            <span class="row-summary">{{ item.summary }}</span>
          </span>
          <span v-if="item.tokens !== undefined" class="token-count">~{{ formatNumber(item.tokens) }} t</span>
          <i class="fas fa-chevron-right row-chevron"></i>
        </button>
        <div v-if="filteredItems.length === 0" class="empty-list">
          <i class="fas fa-filter-circle-xmark"></i>
          <span>{{ t('settings.context.noResults') }}</span>
        </div>
      </div>
    </template>

    <div v-else class="empty-list page-empty">
      <i class="fas fa-comments"></i>
      <span>{{ t('settings.context.noSessions') }}</span>
    </div>

    <Transition name="drawer">
      <div v-if="selectedItem" class="drawer-layer" @mousedown.self="closeDrawer">
        <aside class="detail-drawer" role="dialog" aria-modal="true" :aria-label="t('settings.context.drawerTitle')">
          <header class="drawer-header">
            <div>
              <span class="drawer-eyebrow">{{ selectedItem.subtitle }}</span>
              <h3>{{ selectedItem.title }}</h3>
            </div>
            <div class="drawer-actions">
              <button type="button" :title="t('settings.context.copy')" @click="copyDetail">
                <i class="fas" :class="copied ? 'fa-check' : 'fa-copy'"></i>
                <span>{{ copied ? t('settings.context.copied') : t('settings.context.copy') }}</span>
              </button>
              <button ref="drawerClose" type="button" :title="t('common.close')" @click="closeDrawer">
                <i class="fas fa-xmark"></i><span class="sr-only">{{ t('common.close') }}</span>
              </button>
            </div>
          </header>
          <div class="drawer-meta">
            <span>{{ t('settings.context.detail.kind') }} <strong>{{ t(`settings.context.filters.${selectedItem.role}`) }}</strong></span>
            <span v-if="selectedItem.tokens !== undefined">{{ t('settings.context.detail.tokens') }} <strong>~{{ formatNumber(selectedItem.tokens) }}</strong></span>
            <span>{{ t('settings.context.detail.updated') }} <strong>{{ formatDate(selectedSession?.capturedAt || 0) }}</strong></span>
          </div>
          <div class="detail-label">JSON</div>
          <pre class="detail-json" data-selectable>{{ detailJson }}</pre>
        </aside>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.context-page { max-width: 980px; margin: 0 auto; }
.context-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.context-header .section-title { font-size: 18px; }
.context-header .section-desc { margin-bottom: 0; }
.context-header .section-title i { color: var(--c-brand-text); margin-right: 7px; }
.snapshot-status { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; min-height: 24px; padding: 0 8px; border: 1px solid rgba(255,167,38,.25); border-radius: var(--radius-pill); color: #e4b762; background: rgba(255,167,38,.07); font-size: 11px; }
.snapshot-status i { font-size: 9px; }
.status-age { opacity: .72; }

.session-toolbar { display: flex; align-items: flex-end; gap: var(--space-2); margin: 12px 0 8px; }
.session-field { flex: 1; display: grid; gap: 4px; color: var(--c-text-muted); font-size: 11px; font-weight: 600; }
.session-select { width: 100%; height: 36px; padding: 0 34px 0 11px; border: 1px solid var(--c-border-strong); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-control); font: inherit; font-size: 13px; cursor: pointer; }
.follow-button, .refresh-button { height: 36px; padding: 0 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-brand-text); background: var(--c-brand-soft); font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer; }
.refresh-button { color: var(--c-text-secondary); background: var(--c-control); }
.refresh-button:hover:not(:disabled) { color: var(--c-text-bright); border-color: var(--c-border-strong); }
.refresh-button:disabled { opacity: .6; cursor: wait; }
.refresh-button .spinning { animation: snapshot-spin .8s linear infinite; }
@keyframes snapshot-spin { to { transform: rotate(360deg); } }

.budget-card { padding: 11px 14px 10px; border: 1px solid var(--c-border); border-radius: 10px; background: linear-gradient(120deg, rgba(74,122,255,.09), transparent 62%), var(--c-bg); }
.budget-primary { display: flex; align-items: baseline; gap: 5px; }
.budget-value { color: var(--c-text-bright); font: 700 21px/1 var(--font-mono); letter-spacing: -.7px; }
.budget-unit { color: var(--c-text-muted); font: 11px var(--font-mono); }
.budget-meter { height: 3px; margin: 8px 0; overflow: hidden; border-radius: var(--radius-pill); background: var(--c-border); }
.budget-meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #4a7aff, #8b7dff); transition: width .25s ease; }
.budget-facts { display: flex; flex-wrap: wrap; gap: 5px 16px; color: var(--c-text-muted); font-size: 11px; }
.budget-facts strong { color: var(--c-text); font-family: var(--font-mono); }
.snapshot-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 7px; padding: 7px 10px; border: 1px solid rgba(255,167,38,.2); border-radius: var(--radius-control); color: #e4b762; background: rgba(255,167,38,.06); font-size: 11px; line-height: 1.45; }
.non-live-note { margin: 8px 0 7px; color: var(--c-text-secondary); border-color: var(--c-border); background: var(--c-bg); }

.context-controls { margin: 12px 0 6px; }
.search-field { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text-muted); }
.search-field:focus-within { border-color: var(--c-brand); box-shadow: var(--focus-ring); }
.search-field input { flex: 1; min-width: 0; border: 0; outline: 0; color: var(--c-text); background: transparent; font: inherit; font-size: 13px; }
.search-field input::placeholder { color: var(--c-text-muted); }
.filter-row { display: flex; gap: 3px; margin-top: 5px; overflow-x: auto; padding: 1px; }
.filter-button { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 4px 7px; border: 1px solid transparent; border-radius: var(--radius-pill); color: var(--c-text-muted); background: transparent; font: inherit; font-size: 10.5px; cursor: pointer; }
.filter-button:hover { color: var(--c-text); background: var(--c-hover); }
.filter-button.active { color: var(--c-brand-text); border-color: rgba(74,122,255,.25); background: var(--c-brand-soft); }

.context-list { position: relative; border-top: 1px solid var(--c-border); }
.context-row { --role-color: #77809b; position: relative; display: flex; align-items: center; gap: 9px; width: 100%; min-height: 58px; padding: 8px 10px 8px 0; border: 0; color: var(--c-text); background: transparent; text-align: left; font: inherit; cursor: pointer; }
.context-row::after { content: ''; position: absolute; right: 0; bottom: 0; left: 29px; height: 1px; background: var(--c-border); }
.context-row:hover { background: linear-gradient(90deg, color-mix(in srgb, var(--role-color) 8%, transparent), transparent 75%); }
.context-row.role-system { --role-color: #aa8cff; }
.context-row.role-user { --role-color: #68a2ff; }
.context-row.role-assistant { --role-color: #62d79a; }
.context-row.role-tool { --role-color: #efb35f; }
.context-row.role-definition { --role-color: #de7cba; }
.context-row.role-meta { --role-color: #8490aa; }
.track { align-self: stretch; position: relative; width: 18px; flex: 0 0 18px; }
.track::before { content: ''; position: absolute; height: calc(100% + 16px); top: -8px; bottom: -8px; left: 50%; width: 1px; transform: translateX(-50%); background: color-mix(in srgb, var(--role-color) 35%, var(--c-border)); }
.context-row:first-child .track::before { top: 50%; height: auto }
.context-row:last-child .track::before { bottom: 50%; }
.track-dot { box-sizing: border-box; position: absolute; z-index: 1; top: 50%; left: 50%; width: 10px; height: 10px; transform: translate(-50%, -50%); border: 2px solid var(--c-panel); border-radius: 50%; background: var(--role-color); box-shadow: 0 0 0 2px color-mix(in srgb, var(--role-color) 22%, transparent); }
.row-main { flex: 1; min-width: 0; display: grid; gap: 3px; }
.row-heading { display: flex; align-items: center; gap: 7px; min-width: 0; }
.row-heading strong { color: color-mix(in srgb, var(--role-color) 78%, white); font-size: 12px; font-weight: 650; letter-spacing: .1px; }
.row-subtitle { overflow: hidden; color: var(--c-text-muted); font: 10px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.row-summary { overflow: hidden; color: var(--c-text-secondary); font-size: 12px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.token-count { flex: 0 0 auto; padding: 2px 5px; border-radius: 5px; color: var(--c-text-muted); background: var(--c-bg); font: 9.5px var(--font-mono); }
.row-chevron { color: var(--c-border-strong); font-size: 10px; }
.context-row:hover .row-chevron { color: var(--role-color); transform: translateX(2px); }
.empty-list { min-height: 130px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--c-text-muted); font-size: 13px; }
.empty-list i { font-size: 22px; opacity: .65; }
.page-empty { border: 1px dashed var(--c-border); border-radius: var(--radius-card); }

.drawer-layer { position: fixed; z-index: 1200; inset: 45px 0 0; background: rgba(9,9,20,.56); backdrop-filter: blur(2px); }
.detail-drawer { position: absolute; inset: 0 0 0 auto; display: flex; flex-direction: column; width: min(590px, calc(100vw - 180px)); border-left: 1px solid var(--c-border-strong); background: #17172b; box-shadow: -18px 0 48px rgba(0,0,0,.38); }
.drawer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 17px 18px 13px; border-bottom: 1px solid var(--c-border); }
.drawer-eyebrow { display: block; margin-bottom: 5px; color: var(--c-brand-text); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: .55px; }
.drawer-header h3 { margin: 0; color: var(--c-text-bright); font-size: 16px; word-break: break-word; }
.drawer-actions { display: flex; gap: 6px; }
.drawer-actions button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 9px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text-secondary); background: var(--c-control); font: inherit; font-size: 11px; cursor: pointer; }
.drawer-actions button:hover { color: var(--c-text-bright); border-color: var(--c-border-strong); }
.drawer-meta { display: flex; flex-wrap: wrap; gap: 6px 15px; padding: 9px 18px; border-bottom: 1px solid var(--c-border); color: var(--c-text-muted); font-size: 10.5px; }
.drawer-meta strong { margin-left: 4px; color: var(--c-text-secondary); font-family: var(--font-mono); }
.detail-label { padding: 12px 18px 6px; color: var(--c-text-muted); font: 10px var(--font-mono); letter-spacing: .6px; }
.detail-json { flex: 1; min-height: 0; overflow: auto; margin: 0 11px 12px; padding: 13px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: #c9d4ee; background: #101020; font: 11px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.drawer-enter-active, .drawer-leave-active { transition: opacity .18s ease; }
.drawer-enter-active .detail-drawer, .drawer-leave-active .detail-drawer { transition: transform .22s cubic-bezier(.22,.85,.35,1); }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .detail-drawer, .drawer-leave-to .detail-drawer { transform: translateX(36px); }

@media (max-width: 720px) {
  .context-header { flex-direction: column; gap: 6px; }
  .session-toolbar { align-items: stretch; flex-direction: column; }
  .follow-button { align-self: flex-start; }
  .refresh-button { align-self: flex-start; }
  .budget-facts { gap: 7px 13px; }
  .detail-drawer { width: calc(100vw - 144px); }
  .drawer-actions button span:not(.sr-only) { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .refresh-button .spinning { animation: none; }
}
</style>
