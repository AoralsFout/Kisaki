<script setup lang="ts">
/**
 * 设置面板 - 独立窗口
 *
 * 左侧导航 + 右侧内容，各标签页内容由 settings/ 下子组件实现。
 * 作为独立 Tauri 窗口打开（?settings=1）。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { QUERY_SETTINGS } from '../constants'
import DevPanel from '../DevPanel.vue'
import CharacterManager from './CharacterManager.vue'
import SettingsGeneral from './settings/SettingsGeneral.vue'
import SettingsApi from './settings/SettingsApi.vue'
import SettingsTts from './settings/SettingsTts.vue'
import SettingsAbout from './settings/SettingsAbout.vue'

const { t } = useI18n()

const isSettingsWindow = new URLSearchParams(window.location.search).has(QUERY_SETTINGS)
const selfWindow = ref<WebviewWindow | null>(null)

// ---- 导航 ----
type Tab = 'general' | 'api' | 'character' | 'tts' | 'dev' | 'about'
const activeTab = ref<Tab>('general')

onMounted(() => {
  if (isSettingsWindow) {
    selfWindow.value = getCurrentWebviewWindow()
  }
  // 支持通过 URL ?tab=character 定位标签页
  const tabParam = new URLSearchParams(window.location.search).get('tab')
  const validTabs: Tab[] = ['general', 'api', 'character', 'tts', 'dev', 'about']
  if (tabParam && (validTabs as string[]).includes(tabParam)) {
    activeTab.value = tabParam as Tab
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
  <div class="settings-window" :class="{ standalone: isSettingsWindow }">
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
      <!-- 左侧导航 -->
      <nav class="sidebar">
        <button :class="['nav-item', { active: activeTab === 'general' }]" @click="activeTab = 'general'">
          <i class="fas fa-sliders nav-icon"></i>
          <span>{{ t('settings.nav.general') }}</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'api' }]" @click="activeTab = 'api'">
          <i class="fas fa-plug nav-icon"></i>
          <span>{{ t('settings.nav.api') }}</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'character' }]" @click="activeTab = 'character'">
          <i class="fas fa-masks-theater nav-icon"></i>
          <span>{{ t('settings.nav.character') }}</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'tts' }]" @click="activeTab = 'tts'">
          <i class="fas fa-microphone nav-icon"></i>
          <span>{{ t('settings.nav.tts') }}</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'dev' }]" @click="activeTab = 'dev'">
          <i class="fas fa-screwdriver-wrench nav-icon"></i>
          <span>{{ t('settings.nav.dev') }}</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'about' }]" @click="activeTab = 'about'">
          <i class="fas fa-circle-info nav-icon"></i>
          <span>{{ t('settings.nav.about') }}</span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <main :class="['content', { 'content-flush': activeTab === 'character' }]">
        <SettingsGeneral v-if="activeTab === 'general'" />
        <SettingsApi v-if="activeTab === 'api'" />
        <SettingsTts v-if="activeTab === 'tts'" />

        <div v-if="activeTab === 'character'" class="content-section content-wide">
          <CharacterManager />
        </div>

        <div v-if="activeTab === 'dev'" class="content-section">
          <h2 class="section-title"><i class="fas fa-screwdriver-wrench"></i> {{ t('settings.dev.title') }}</h2>
          <p class="section-desc">{{ t('settings.dev.desc') }}</p>
          <DevPanel />
        </div>

        <SettingsAbout v-if="activeTab === 'about'" />
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
  background: #16162a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: #16162a;
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.topbar-title {
  font-size: 14px;
  font-weight: 600;
  color: #ccc;
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
  transition: background 0.1s;
}

.win-btn:hover {
  background: #2a2a4a;
  color: #ddd;
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
  background: #16162a;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  border: none;
  background: none;
  color: #888;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: #2a2a4a;
  color: #ddd;
}

.nav-item.active {
  background: #3a3a5a;
  color: #fff;
  font-weight: 500;
}

.nav-icon {
  font-size: 15px;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
  border: 1px solid #2a2a4a;
  background: #1a1a2e;
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
  background: #2a2a4a;
  border-radius: 3px;
}

.content::-webkit-scrollbar-thumb:hover,
.sidebar::-webkit-scrollbar-thumb:hover {
  background: #3a3a5a;
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

<style>
/* ===== 共享样式（对 settings/ 子组件可见） ===== */

/* ---- 分区 ---- */
.section-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 4px;
  color: #e0e0e0;
}

.section-desc {
  font-size: 13px;
  color: #999;
  margin: 0 0 12px;
}

.section-divider {
  border: none;
  border-top: 1px solid #2a2a4a;
  margin: 20px 0;
}

/* ---- 表单 ---- */
.form-group {
  margin-bottom: 18px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #aaa;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid #2a2a4a;
  border-radius: 10px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s;
}

.form-input:focus {
  border-color: #4a7aff;
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

.form-input::placeholder {
  color: #555;
}

.form-select {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid #2a2a4a;
  border-radius: 10px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s;
  cursor: pointer;
  appearance: auto;
}

.form-select:focus {
  border-color: #4a7aff;
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

.form-hint {
  font-size: 11px;
  color: #777;
  margin: 4px 0 0;
}

/* ---- 预设按钮 ---- */
.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-btn {
  padding: 6px 14px;
  font-size: 12px;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.15s;
}

.preset-btn:hover {
  border-color: #4a7aff;
  color: #4a7aff;
  background: rgba(74, 122, 255, 0.1);
}

/* ---- 操作按钮 ---- */
.form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
}

.btn-save {
  padding: 10px 28px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #4a7aff;
  color: white;
  border-radius: 24px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-save:hover {
  opacity: 0.85;
}

.status-ok {
  font-size: 12px;
  color: #30b94e;
  font-weight: 500;
}

/* ---- 次要按钮 ---- */
.btn-secondary {
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-secondary:hover:not(:disabled) {
  border-color: #4a7aff;
  color: #4a7aff;
  background: rgba(74, 122, 255, 0.1);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---- Toggle Switch ---- */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toggle-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle-label-text {
  font-size: 13px;
  font-weight: 600;
  color: #e0e0e0;
}

.toggle-label-desc {
  font-size: 11px;
  color: #888;
}

.toggle-switch {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: #555;
  border: none;
  cursor: pointer;
  transition: background 0.2s;
  padding: 0;
  flex-shrink: 0;
}

.toggle-switch.active {
  background: #30b94e;
}

.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: left 0.2s;
}

.toggle-switch.active .toggle-knob {
  left: 22px;
}

/* ---- 旋转动画 ---- */
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

/* ---- 语音列表 ---- */
.voice-error {
  font-size: 13px;
  color: #ef5350;
  margin-top: 10px;
}

.voice-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 10px;
  transition: border-color 0.12s;
}

.voice-item:hover {
  border-color: #4a7aff;
}

.voice-item-icon {
  font-size: 18px;
  color: #4a7aff;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(74, 122, 255, 0.1);
  border-radius: 8px;
  flex-shrink: 0;
}

.voice-item-info {
  flex: 1;
  min-width: 0;
}

.voice-item-id {
  font-size: 13px;
  font-weight: 500;
  color: #e0e0e0;
  word-break: break-all;
  font-family: monospace;
}

.voice-item-meta {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

/* ---- 关于 ---- */
.about-card {
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 20px;
  font-size: 13px;
  line-height: 1.6;
  color: #aaa;
}

.about-links {
  display: flex;
  gap: 8px;
}

.about-link {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 8px;
  transition: all 0.15s;
}

.about-link:hover {
  border-color: #4a7aff;
  color: #4a7aff;
  background: rgba(74, 122, 255, 0.1);
}

.btn-open-logs {
  width: 100%;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-bottom: 8px;
}

.btn-open-logs:last-child {
  margin-bottom: 0;
}

.btn-open-logs:hover {
  border-color: #4a7aff;
  color: #4a7aff;
  background: rgba(74, 122, 255, 0.1);
}

.btn-exit-app {
  width: 100%;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.btn-exit-app:hover {
  background: rgba(239, 68, 68, 0.25);
  border-color: #ef4444;
  color: #f87171;
}

/* ---- 打字机速度滑块 ---- */
.speed-slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.speed-slider {
  flex: 1;
  max-width: 240px;
  -webkit-appearance: none;
  appearance: none;
  height: 6px;
  border-radius: 3px;
  background: #2a2a4a;
  outline: none;
  cursor: pointer;
}

.speed-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #4a7aff;
  border: 2px solid #1a1a2e;
  cursor: pointer;
  transition: transform 0.1s;
}

.speed-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.speed-value {
  font-size: 13px;
  color: #ddd;
  font-weight: 500;
  min-width: 40px;
  font-family: monospace;
}

.speed-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.speed-tag.fast {
  color: #30b94e;
  background: rgba(48, 185, 78, 0.12);
}

.speed-tag.medium {
  color: #ffa726;
  background: rgba(255, 167, 38, 0.12);
}

.speed-tag.slow {
  color: #ef5350;
  background: rgba(239, 83, 80, 0.12);
}
</style>
