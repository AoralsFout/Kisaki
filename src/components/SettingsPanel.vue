<script setup lang="ts">
/**
 * 设置面板 - 独立窗口
 *
 * 左侧导航 + 右侧内容，简约白色风格。
 * 作为独立 Tauri 窗口打开（?settings=1）。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { loadConfigSecure, saveConfigSecure, DEFAULT_CONFIG, isConfigValid } from '../ai'
import type { AIConfig } from '../ai'
import {
  loadCosyVoiceConfigSecure, saveCosyVoiceConfigSecure,
  REGIONS, MODELS, DEFAULT_COSYVOICE_CONFIG,
  isTtsEnabled, setTtsEnabled,
} from '../tts'
import { fetchVoiceList } from '../tts/api'
import type { CosyVoiceConfig, VoiceInfo } from '../tts/types'
import DevPanel from '../DevPanel.vue'
import CharacterManager from './CharacterManager.vue'
import { getDisplayLanguage, setDisplayLanguage, SUPPORTED_LANGUAGES } from '../stores/language'
import { getTypingSpeed, setTypingSpeed } from '../stores/language'
import { UI_LANGUAGES, getUiLanguage, setUiLanguage } from '../i18n'
import { WINDOW_LOGS, QUERY_SETTINGS, QUERY_LOGS } from '../constants'
import { getAllWindows } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

const { t } = useI18n()

const isSettingsWindow = new URLSearchParams(window.location.search).has(QUERY_SETTINGS)
const selfWindow = ref<WebviewWindow | null>(null)

// ---- 配置状态 ----
const config = ref<AIConfig>({ ...DEFAULT_CONFIG })
const saved = ref(false)

// ---- CosyVoice 配置 ----
const cvConfig = ref<CosyVoiceConfig>({ ...DEFAULT_COSYVOICE_CONFIG })
const cvSaved = ref(false)
const voices = ref<VoiceInfo[]>([])
const loadingVoices = ref(false)
const voiceError = ref('')
const ttsEnabled = ref(isTtsEnabled())
const displayLang = ref(getDisplayLanguage())
const uiLang = ref(getUiLanguage())
const typingSpeed = ref(getTypingSpeed())

function onTypingSpeedInput(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10)
  typingSpeed.value = val
  setTypingSpeed(val)
}

// ---- 导航 ----
type Tab = 'general' | 'api' | 'character' | 'tts' | 'dev' | 'about'
const activeTab = ref<Tab>('general')

const PRESETS = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3' },
]

onMounted(async () => {
  if (isSettingsWindow) {
    selfWindow.value = getCurrentWebviewWindow()
  }
  // 支持通过 URL ?tab=character 定位标签页（如从主窗口「添加角色」引导进入）
  const tabParam = new URLSearchParams(window.location.search).get('tab')
  const validTabs: Tab[] = ['general', 'api', 'character', 'tts', 'dev', 'about']
  if (tabParam && (validTabs as string[]).includes(tabParam)) {
    activeTab.value = tabParam as Tab
  }
  config.value = { ...await loadConfigSecure() }
  cvConfig.value = { ...await loadCosyVoiceConfigSecure() }
})

function applyPreset(p: typeof PRESETS[0]) {
  config.value.baseURL = p.baseURL
  config.value.model = p.model
}

async function handleSave() {
  await saveConfigSecure(config.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 1500)
}

async function handleCvSave() {
  await saveCosyVoiceConfigSecure(cvConfig.value)
  cvSaved.value = true
  voiceError.value = ''
  setTimeout(() => { cvSaved.value = false }, 1500)
}

async function handleFetchVoices() {
  loadingVoices.value = true
  voiceError.value = ''
  voices.value = []
  try {
    // 先保存当前配置
    await saveCosyVoiceConfigSecure(cvConfig.value)
    const list = await fetchVoiceList({ apiKey: cvConfig.value.apiKey })
    voices.value = list
    if (list.length === 0) {
      voiceError.value = t('settings.tts.noVoices')
    }
  } catch (e) {
    voiceError.value = (e as Error).message
  } finally {
    loadingVoices.value = false
  }
}

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

async function openCharacterFolder() {
  try {
    const dirs = await invoke<{ characters: string }>('get_data_dirs')
    await revealItemInDir(dirs.characters)
  } catch (e) {
    console.error('打开角色数据文件夹失败:', e)
  }
}

async function exitApp() {
  try {
    const all = await getAllWindows()
    for (const w of all) {
      try { await w.close() } catch { }
    }
  } catch { }
}

async function openLogWindow() {
  try {
    const all = await getAllWindows()
    const existing = all.find(w => w.label === WINDOW_LOGS)
    if (existing) {
      await existing.unminimize()
      await existing.show()
      await existing.setFocus()
      return
    }

    new WebviewWindow(WINDOW_LOGS, {
      url: `/?${QUERY_LOGS}=1`,
      title: t('window.logs'),
      width: 800,
      height: 500,
      decorations: false,
      resizable: true,
    })
  } catch (e) {
    console.error('无法打开日志窗口', e)
  }
}
</script>

<template>
  <div class="settings-window" :class="{ standalone: isSettingsWindow }">
    <!-- 标题栏 -->
    <header class="topbar" data-tauri-drag-region>
      <span class="topbar-title"><i class="fas fa-gear"></i> {{ t('settings.title') }}</span>
      <div v-if="isSettingsWindow" class="window-controls">
        <button class="win-btn" @click="minimizeWindow" :title="t('settings.win.minimize')" :aria-label="t('settings.winAria.minimize')">─</button>
        <button class="win-btn" @click="maximizeWindow" :title="t('settings.win.maximize')" :aria-label="t('settings.winAria.maximize')">□</button>
        <button class="win-btn win-close" @click="closeWindow" :title="t('settings.win.close')" :aria-label="t('settings.winAria.close')">✕</button>
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
        <!-- ===== 通用 ===== -->
        <div v-if="activeTab === 'general'" class="content-section">
          <h2 class="section-title">{{ t('settings.general.title') }}</h2>
          <p class="section-desc">{{ t('settings.general.desc') }}</p>

          <div class="form-group">
            <label class="form-label">{{ t('settings.general.uiLang') }}</label>
            <select v-model="uiLang" class="form-select" @change="setUiLanguage(uiLang)">
              <option v-for="l in UI_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
            </select>
            <p class="form-hint">{{ t('settings.general.uiLangHint') }}</p>
          </div>
        </div>

        <!-- ===== API 配置 ===== -->
        <div v-if="activeTab === 'api'" class="content-section">
          <h2 class="section-title">{{ t('settings.api.title') }}</h2>
          <p class="section-desc">{{ t('settings.api.desc') }}</p>

          <div class="form-group">
            <label class="form-label">{{ t('settings.api.quickSelect') }}</label>
            <div class="preset-row">
              <button v-for="p in PRESETS" :key="p.label" class="preset-btn" @click="applyPreset(p)">
                {{ p.label }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.api.baseURL') }}</label>
            <input v-model="config.baseURL" class="form-input" placeholder="https://api.openai.com/v1" />
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.api.apiKey') }}</label>
            <input v-model="config.apiKey" class="form-input" type="password" placeholder="sk-..." />
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.api.model') }}</label>
            <input v-model="config.model" class="form-input" placeholder="gpt-4o-mini" />
          </div>

          <div class="form-actions">
            <button class="btn-save" @click="handleSave">
              {{ saved ? t('common.saved') : t('common.save') }}
            </button>
            <span v-if="isConfigValid(config)" class="status-ok"><i class="fas fa-check-circle"></i> {{ t('settings.api.configOk') }}</span>
          </div>
        </div>

        <!-- ===== 语音合成 (CosyVoice) ===== -->
        <div v-if="activeTab === 'tts'" class="content-section">
          <h2 class="section-title"><i class="fas fa-microphone"></i> {{ t('settings.tts.title') }}</h2>
          <p class="section-desc">{{ t('settings.tts.desc') }}</p>

          <!-- TTS 总开关 -->
          <div class="form-group">
            <div class="toggle-row">
              <label class="toggle-label">
                <span class="toggle-label-text">{{ t('settings.tts.enableTitle') }}</span>
                <span class="toggle-label-desc">{{ t('settings.tts.enableDesc') }}</span>
              </label>
              <button :class="['toggle-switch', { active: ttsEnabled }]"
                @click="ttsEnabled = !ttsEnabled; setTtsEnabled(ttsEnabled)" role="switch" :aria-checked="ttsEnabled">
                <span class="toggle-knob"></span>
              </button>
            </div>
          </div>

          <hr class="section-divider" />

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.apiKeyLabel') }}</label>
            <input v-model="cvConfig.apiKey" class="form-input" type="password" placeholder="sk-..." />
            <p class="form-hint">{{ t('settings.tts.apiKeyHint') }}</p>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.modelLabel') }}</label>
            <select v-model="cvConfig.model" class="form-select">
              <option v-for="m in MODELS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <p class="form-hint">{{ t('settings.tts.modelHint') }}</p>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.region') }}</label>
            <select v-model="cvConfig.region" class="form-select">
              <option v-for="(r, k) in REGIONS" :key="k" :value="k">{{ r.label }}</option>
            </select>
          </div>

          <div v-if="cvConfig.region === 'singapore'" class="form-group">
            <label class="form-label">{{ t('settings.tts.workspaceId') }}</label>
            <input v-model="REGIONS.singapore.workspaceId" class="form-input" :placeholder="t('settings.tts.workspaceIdPlaceholder')" />
            <p class="form-hint">{{ t('settings.tts.workspaceIdHint') }}</p>
          </div>

          <div class="form-actions">
            <button class="btn-save" @click="handleCvSave">
              {{ cvSaved ? t('common.saved') : t('settings.tts.saveConfig') }}
            </button>
          </div>

          <hr class="section-divider" />

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.myVoices') }}</label>
            <button class="btn-secondary" :disabled="loadingVoices || !cvConfig.apiKey" @click="handleFetchVoices">
              <i class="fas fa-sync" :class="{ spinning: loadingVoices }"></i>
              {{ loadingVoices ? t('settings.tts.fetching') : t('settings.tts.fetchVoices') }}
            </button>

            <div v-if="voiceError" class="voice-error">{{ voiceError }}</div>

            <div v-if="voices.length > 0" class="voice-list">
              <div v-for="v in voices" :key="v.voiceId" class="voice-item">
                <div class="voice-item-icon"><i class="fas fa-user-mic"></i></div>
                <div class="voice-item-info">
                  <div class="voice-item-id">{{ v.voiceId }}</div>
                  <div class="voice-item-meta">{{ t('settings.tts.voiceMeta', { date: v.gmtCreate, status: v.status }) }}</div>
                </div>
              </div>
            </div>
          </div>

          <hr class="section-divider" />

          <!-- 用户显示语言偏好 -->
          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.displayLang') }}</label>
            <select v-model="displayLang" class="form-select" @change="setDisplayLanguage(displayLang)">
              <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
            </select>
            <p class="form-hint">{{ t('settings.tts.displayLangHint') }}</p>
          </div>

          <!-- 打字机速度 -->
          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.typingSpeed') }}</label>
            <div class="speed-slider-row">
              <input type="range" min="10" max="200" step="5" :value="typingSpeed" @input="onTypingSpeedInput"
                class="speed-slider" />
              <span class="speed-value">{{ typingSpeed }}ms</span>
              <span class="speed-tag"
                :class="{ fast: typingSpeed <= 20, medium: typingSpeed > 20 && typingSpeed <= 60, slow: typingSpeed > 60 }">
                {{ typingSpeed <= 20 ? t('settings.tts.speedFast') : typingSpeed <= 60 ? t('settings.tts.speedMedium') : t('settings.tts.speedSlow') }} </span>
            </div>
            <p class="form-hint">{{ t('settings.tts.typingSpeedHint') }}</p>
          </div>
        </div>

        <!-- ===== 角色管理 ===== -->
        <div v-if="activeTab === 'character'" class="content-section content-wide">
          <CharacterManager />
        </div>

        <!-- ===== Dev 面板 ===== -->
        <div v-if="activeTab === 'dev'" class="content-section content-dev">
          <h2 class="section-title"><i class="fas fa-screwdriver-wrench"></i> {{ t('settings.dev.title') }}</h2>
          <p class="section-desc">{{ t('settings.dev.desc') }}</p>
          <DevPanel />
        </div>

        <!-- ===== 关于 ===== -->
        <div v-if="activeTab === 'about'" class="content-section">
          <h2 class="section-title">{{ t('settings.about.title') }}</h2>
          <p class="section-desc">{{ t('settings.about.version') }}</p>
          <div class="about-card">
            <img src="/images/kisaki_alpha.png" height="100" />
            <img src="/images/kisaki_logo_alpha.png" height="70" />
            <p>{{ t('settings.about.desc1') }}</p>
            <p>{{ t('settings.about.desc2') }}</p>
            <p style="margin-top:12px;color:#999;font-size:12px;">
              {{ t('settings.about.privacy') }}
            </p>
            <hr class="section-divider" />
            <div class="about-links">
              <a class="about-link" href="https://github.com/AoralsFout/Kisaki" target="_blank"
                rel="noopener noreferrer">
                <i class="fab fa-github"></i> {{ t('settings.about.github') }}
              </a>
              <a class="about-link" href="https://kisaki.aoralsfout.top" target="_blank" rel="noopener noreferrer">
                <i class="fas fa-globe"></i> {{ t('settings.about.website') }}
              </a>
            </div>
            <hr class="section-divider" />
            <button class="btn-open-logs" @click="openCharacterFolder">
              <i class="fas fa-folder-open"></i> {{ t('settings.about.openCharFolder') }}
            </button>
            <button class="btn-open-logs" @click="openLogWindow">
              <i class="fas fa-receipt"></i> {{ t('settings.about.openLogs') }}
            </button>
            <hr class="section-divider" />
            <button class="btn-exit-app" @click="exitApp">
              <i class="fas fa-power-off"></i> {{ t('settings.about.exitApp') }}
            </button>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ===== 全局（深色主题） ===== */
.settings-window {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}

/* ===== 标题栏 ===== */
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

/* ===== 布局 ===== */
.layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ===== 侧边栏 ===== */
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

/* ===== 内容区 ===== */
.content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
  border: 1px solid #2a2a4a;
  border-radius: 24px 0px 0px 0px;
}

/* 深色滚动条 */
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

/* ===== 表单 ===== */
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

/* ===== 预设按钮 ===== */
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

/* ===== 操作按钮 ===== */
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

/* ===== 语音合成 ===== */
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

.section-divider {
  border: none;
  border-top: 1px solid #2a2a4a;
  margin: 20px 0;
}

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

/* ===== Toggle Switch ===== */
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

.about-card {
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 20px;
  font-size: 13px;
  line-height: 1.6;
  color: #aaa;
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

/* ===== 打字机速度滑块 ===== */
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
