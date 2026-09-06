<script setup lang="ts">
/**
 * 设置面板 - 独立窗口
 *
 * 左侧导航 + 右侧内容，各标签页内容由 settings/ 下子组件实现。
 * 作为独立 Tauri 窗口打开（?settings=1）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import UnsavedDialog from './UnsavedDialog.vue'
import type { EditablePage } from '../utils/editableForm'
import { useI18n } from 'vue-i18n'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { QUERY_SETTINGS, EVENT_SETTINGS_NAVIGATE } from '../constants'
import { initWindowState } from '../utils/windowState'
import DevPanel from './settings/DevPanel.vue'
import CharacterManager from './CharacterManager.vue'
import SettingsGeneral from './settings/SettingsGeneral.vue'
import SettingsApi from './settings/SettingsApi.vue'
import SettingsSearch from './settings/SettingsSearch.vue'
import SettingsTts from './settings/SettingsTts.vue'
import SettingsAbout from './settings/SettingsAbout.vue'
import SettingsPrivacy from './settings/SettingsPrivacy.vue'
import SettingsPermissions from './settings/SettingsPermissions.vue'
import SettingsDiagnostics from './settings/SettingsDiagnostics.vue'

const { t } = useI18n()

const isSettingsWindow = new URLSearchParams(window.location.search).has(QUERY_SETTINGS)
const isDevelopment = import.meta.env.DEV
const selfWindow = ref<WebviewWindow | null>(null)

// ---- 导航 ----
type Tab = 'general' | 'api' | 'search' | 'character' | 'tts' | 'permissions' | 'dev' | 'about' | 'privacy' | 'diagnostics'
const TAB_GROUPS: Array<{ key: 'experience' | 'connection' | 'maintenance'; tabs: Tab[] }> = [
  { key: 'experience', tabs: ['general', 'character', 'tts'] },
  { key: 'connection', tabs: ['api', 'search', 'permissions'] },
  { key: 'maintenance', tabs: ['privacy', 'diagnostics', 'about'] },
]
const VALID_TABS: Tab[] = [
  ...TAB_GROUPS.flatMap(g => g.tabs),
  'dev', // 仅开发构建
]
const TAB_META: Record<Tab, { icon: string; label: string }> = {
  general: { icon: 'fa-sliders', label: 'settings.nav.general' },
  character: { icon: 'fa-masks-theater', label: 'settings.nav.character' },
  tts: { icon: 'fa-microphone', label: 'settings.nav.tts' },
  api: { icon: 'fa-plug', label: 'settings.nav.api' },
  search: { icon: 'fa-globe', label: 'settings.nav.search' },
  permissions: { icon: 'fa-user-shield', label: 'settings.nav.permissions' },
  privacy: { icon: 'fa-shield-halved', label: 'settings.nav.privacy' },
  diagnostics: { icon: 'fa-clipboard-list', label: 'settings.nav.diagnostics' },
  about: { icon: 'fa-circle-info', label: 'settings.nav.about' },
  dev: { icon: 'fa-screwdriver-wrench', label: 'settings.nav.dev' },
}
/** 维护与帮助组在开发构建下追加 Dev 标签 */
const visibleGroups = computed(() => {
  const groups = TAB_GROUPS.map(g => ({ ...g, tabs: [...g.tabs] }))
  if (isDevelopment) groups[2].tabs.push('dev')
  return groups
})
const activeTab = ref<Tab>('general')
const editor = ref<EditablePage | null>(null)
const leaveDialog = ref<InstanceType<typeof UnsavedDialog> | null>(null)
let unlistenClose: (() => void) | undefined
let unlistenNavigate: (() => void) | undefined
const closeError = ref(false)
async function installCloseGuard() {
  unlistenClose = await selfWindow.value?.onCloseRequested(async event => {
    // Always prevent the helper's implicit destroy(), which needs a broader permission.
    event.preventDefault()
    if (!await leaveDialog.value?.ask(editor.value)) return
    closeError.value = false
    try {
      // Removing the listener lets the existing close permission take the normal native path.
      await unlistenClose?.()
      unlistenClose = undefined
      window.removeEventListener('beforeunload', beforeUnload)
      await selfWindow.value?.close()
    } catch {
      closeError.value = true
      window.addEventListener('beforeunload', beforeUnload)
      await installCloseGuard()
    }
  })
}
async function selectTab(tab: Tab) {
  if (tab === activeTab.value) return
  if (await leaveDialog.value?.ask(editor.value)) activeTab.value = tab
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (editor.value?.dirty || editor.value?.saving) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onUnmounted(() => {
  unlistenClose?.()
  unlistenNavigate?.()
  window.removeEventListener('beforeunload', beforeUnload)
})

onMounted(async () => {
  // 支持通过 URL ?tab=character 定位标签页；在窗口显示前完成，避免先闪过默认页。
  const tabParam = new URLSearchParams(window.location.search).get('tab')
  if (tabParam && (VALID_TABS as string[]).includes(tabParam)) {
    activeTab.value = tabParam as Tab
  }
  if (isSettingsWindow) {
    selfWindow.value = getCurrentWebviewWindow()
    await installCloseGuard().catch(() => {})
    // 已有设置窗口时，主窗口通过事件请求定位标签（如引导的「去配置」）。
    // 走 selectTab 以复用未保存更改确认。
    try {
      unlistenNavigate = await listen<{ tab?: string }>(EVENT_SETTINGS_NAVIGATE, (e) => {
        const tab = e.payload?.tab
        if (tab && (VALID_TABS as string[]).includes(tab)) void selectTab(tab as Tab)
      })
    } catch { /* 浏览器预览环境无 Tauri 事件总线 */ }
    // 隐藏创建，恢复位置/大小后再显示，避免白窗闪现和瞬移。
    await initWindowState('settings', { showAfterRestore: true }).catch(() => {})
  }
})

async function minimizeWindow() {
  try { await selfWindow.value?.minimize() } catch { }
}
async function maximizeWindow() {
  try {
    const isMax = await selfWindow.value?.isMaximized()
    if (isMax) await selfWindow.value?.unmaximize()
    else await selfWindow.value?.maximize()
  } catch { }
}
function closeWindow() {
  selfWindow.value?.close()
}
</script>

<template>
  <UnsavedDialog ref="leaveDialog" />
  <div class="settings-window" :class="{ standalone: isSettingsWindow }">
    <p v-if="closeError" role="alert" data-selectable>{{ t('safety.leaveFailed') }}</p>
    <!-- 标题栏 -->
    <header class="topbar" data-tauri-drag-region>
      <span class="topbar-title"><i class="fas fa-gear"></i> {{ t('settings.title') }}</span>
      <div v-if="isSettingsWindow" class="window-controls">
        <button class="win-btn" @click="minimizeWindow" :title="t('settings.win.minimize')"
          :aria-label="t('settings.winAria.minimize')">─</button>
        <button class="win-btn" @click="maximizeWindow" :title="t('settings.win.maximize')"
          :aria-label="t('settings.winAria.maximize')">□</button>
        <button class="win-btn win-close" @click="closeWindow" :title="t('settings.win.close')"
          :aria-label="t('settings.winAria.close')">✕</button>
      </div>
    </header>

    <div class="layout">
      <!-- 左侧导航（按使用体验 / 连接与能力 / 维护与帮助分组） -->
      <nav class="sidebar" :aria-label="t('settings.title')">
        <template v-for="group in visibleGroups" :key="group.key">
          <div class="nav-group-title">{{ t(`settings.nav.groups.${group.key}`) }}</div>
          <button v-for="tab in group.tabs" :key="tab" :class="['nav-item', { active: activeTab === tab }]"
            :aria-current="activeTab === tab ? 'page' : undefined" @click="selectTab(tab)">
            <i class="fas" :class="TAB_META[tab].icon"></i>
            <span>{{ t(TAB_META[tab].label) }}</span>
          </button>
        </template>
      </nav>

      <!-- 右侧内容 -->
      <main :class="['content', { 'content-flush': activeTab === 'character' }]">
        <SettingsGeneral v-if="activeTab === 'general'" />
        <SettingsApi ref="editor" v-if="activeTab === 'api'" />
        <SettingsSearch ref="editor" v-if="activeTab === 'search'" />
        <SettingsTts ref="editor" v-if="activeTab === 'tts'" />
        <SettingsPermissions v-if="activeTab === 'permissions'" />

        <div v-if="activeTab === 'character'" class="content-section content-wide">
          <CharacterManager ref="editor" />
        </div>

        <div v-if="isDevelopment && activeTab === 'dev'" class="content-section">
          <h2 class="section-title"><i class="fas fa-screwdriver-wrench"></i> {{ t('settings.dev.title') }}</h2>
          <p class="section-desc">{{ t('settings.dev.desc') }}</p>
          <DevPanel />
        </div>

        <SettingsDiagnostics v-if="activeTab === 'diagnostics'" />
        <SettingsAbout v-if="activeTab === 'about'" />
        <SettingsPrivacy v-if="activeTab === 'privacy'" />
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ===== 外壳布局（仅 SettingsPanel 自身模板） ===== */
.settings-window {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: var(--c-bg);
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.topbar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text-secondary);
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
  color: var(--c-text-muted);
  padding: 4px 10px;
  border-radius: 6px;
  transition: background 0.1s;
}

.win-btn:hover {
  background: var(--c-border);
  color: var(--c-text);
}

.win-close:hover {
  background: #ff4444;
  color: white;
}

.layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.sidebar {
  width: 180px;
  flex-shrink: 0;
  background: var(--c-bg);
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.nav-group-title {
  margin: 10px 4px 4px;
  font-size: var(--fs-aux);
  font-weight: 600;
  color: var(--c-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.nav-group-title:first-child {
  margin-top: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  border: none;
  background: none;
  color: var(--c-text-muted);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: var(--c-border);
  color: var(--c-text);
}

.nav-item.active {
  background: var(--c-border-strong);
  color: var(--c-text-bright);
  font-weight: 500;
}

.nav-icon {
  font-size: 15px;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
  border: 1px solid var(--c-border);
  background: var(--c-panel);
  border-radius: 24px 0px 0px 0px;
}

.content::-webkit-scrollbar,
.sidebar::-webkit-scrollbar {
  width: 6px;
}

.content::-webkit-scrollbar-track,
.sidebar::-webkit-scrollbar-track {
  background: transparent;
}

.content::-webkit-scrollbar-thumb,
.sidebar::-webkit-scrollbar-thumb {
  background: var(--c-border);
  border-radius: 3px;
}

.content::-webkit-scrollbar-thumb:hover,
.sidebar::-webkit-scrollbar-thumb:hover {
  background: var(--c-border-strong);
}

@media (max-width: 720px) {
  .topbar { padding: var(--space-2) var(--space-3); }
  .sidebar { width: 144px; padding-inline: var(--space-1); }
  .nav-group-title { font-size: var(--fs-aux); }
  .nav-item { padding: var(--space-2); }
  .content { padding: var(--space-4); border-radius: var(--radius-card) 0 0; }
}

@media (max-height: 480px) {
  .topbar { padding-block: var(--space-1); }
  .sidebar { padding-block: var(--space-1); }
  .content { padding-block: var(--space-3); }
}

.content-flush {
  padding: 0 !important;
  overflow: hidden !important;
  display: flex !important;
  flex-direction: column;
}

.content-wide {
  flex: 1 !important;
  min-height: 0 !important;
  display: flex;
  flex-direction: column;
}
</style>
