<script setup lang="ts">
/**
 * 设置面板 - 独立窗口
 *
 * 左侧导航 + 右侧内容，简约白色风格。
 * 作为独立 Tauri 窗口打开（?settings=1）。
 */
import { ref, onMounted } from 'vue'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { loadConfig, saveConfig, DEFAULT_CONFIG, isConfigValid } from '../ai'
import type { AIConfig } from '../ai'
import DevPanel from '../DevPanel.vue'
import CharacterManager from './CharacterManager.vue'

const isSettingsWindow = new URLSearchParams(window.location.search).has('settings')
const selfWindow = ref<WebviewWindow | null>(null)

// ---- 配置状态 ----
const config = ref<AIConfig>({ ...DEFAULT_CONFIG })
const saved = ref(false)

// ---- 导航 ----
type Tab = 'api' | 'character' | 'dev' | 'about'
const activeTab = ref<Tab>('api')

const PRESETS = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { label: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'llama3' },
]

onMounted(() => {
  if (isSettingsWindow) {
    selfWindow.value = getCurrentWebviewWindow()
  }
  config.value = { ...loadConfig() }
})

function applyPreset(p: typeof PRESETS[0]) {
  config.value.baseURL = p.baseURL
  config.value.model = p.model
}

function handleSave() {
  saveConfig(config.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 1500)
}

async function minimizeWindow() {
  try { await selfWindow.value?.minimize() } catch {}
}
async function maximizeWindow() {
  try {
    const isMax = await selfWindow.value?.isMaximized()
    if (isMax) await selfWindow.value?.unmaximize()
    else await selfWindow.value?.maximize()
  } catch {}
}
function closeWindow() {
  selfWindow.value?.close()
}
</script>

<template>
  <div class="settings-window" :class="{ standalone: isSettingsWindow }">
    <!-- 标题栏 -->
    <header class="topbar" data-tauri-drag-region>
      <span class="topbar-title"><i class="fas fa-gear"></i> 设置</span>
      <div v-if="isSettingsWindow" class="window-controls">
        <button class="win-btn" @click="minimizeWindow" title="最小化">─</button>
        <button class="win-btn" @click="maximizeWindow" title="最大化">□</button>
        <button class="win-btn win-close" @click="closeWindow" title="关闭">✕</button>
      </div>
    </header>

    <div class="layout">
      <!-- 左侧导航 -->
      <nav class="sidebar">
        <button :class="['nav-item', { active: activeTab === 'api' }]" @click="activeTab = 'api'">
          <i class="fas fa-plug nav-icon"></i>
          <span>API 配置</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'character' }]" @click="activeTab = 'character'">
          <i class="fas fa-masks-theater nav-icon"></i>
          <span>角色管理</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'dev' }]" @click="activeTab = 'dev'">
          <i class="fas fa-screwdriver-wrench nav-icon"></i>
          <span>Dev</span>
        </button>
        <button :class="['nav-item', { active: activeTab === 'about' }]" @click="activeTab = 'about'">
          <i class="fas fa-circle-info nav-icon"></i>
          <span>关于</span>
        </button>
      </nav>

      <!-- 右侧内容 -->
      <main :class="['content', { 'content-flush': activeTab === 'character' }]">
        <!-- ===== API 配置 ===== -->
        <div v-if="activeTab === 'api'" class="content-section">
          <h2 class="section-title">API 配置</h2>
          <p class="section-desc">配置 AI 对话接口，所有数据仅保存在本地。</p>

          <div class="form-group">
            <label class="form-label">快速选择</label>
            <div class="preset-row">
              <button v-for="p in PRESETS" :key="p.label" class="preset-btn" @click="applyPreset(p)">
                {{ p.label }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">API 地址</label>
            <input v-model="config.baseURL" class="form-input" placeholder="https://api.openai.com/v1" />
          </div>

          <div class="form-group">
            <label class="form-label">API Key</label>
            <input v-model="config.apiKey" class="form-input" type="password" placeholder="sk-..." />
          </div>

          <div class="form-group">
            <label class="form-label">模型</label>
            <input v-model="config.model" class="form-input" placeholder="gpt-4o-mini" />
          </div>

          <div class="form-actions">
            <button class="btn-save" @click="handleSave">
              {{ saved ? '✓ 已保存' : '保存' }}
            </button>
            <span v-if="isConfigValid(config)" class="status-ok"><i class="fas fa-check-circle"></i> 配置可用</span>
          </div>
        </div>

        <!-- ===== 角色管理 ===== -->
        <div v-if="activeTab === 'character'" class="content-section content-wide">
          <CharacterManager />
        </div>

        <!-- ===== Dev 面板 ===== -->
        <div v-if="activeTab === 'dev'" class="content-section content-dev">
          <h2 class="section-title"><i class="fas fa-screwdriver-wrench"></i> Dev 面板</h2>
          <p class="section-desc">姿态、情绪等功能的本地测试。</p>
          <DevPanel />
        </div>

        <!-- ===== 关于 ===== -->
        <div v-if="activeTab === 'about'" class="content-section">
          <h2 class="section-title">关于</h2>
          <p class="section-desc">Kisaki v0.1</p>
          <div class="about-card">
            <p>基于 Tauri + Vue 3 构建</p>
            <p>支持 AI 对话、角色切换、工具调用</p>
            <p style="margin-top:12px;color:#999;font-size:12px;">
              数据仅保存在本地，API Key 不会上传到任何第三方服务器。
            </p>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ===== 全局 ===== */
.settings-window {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f5f7;
  color: #1d1d1f;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}

/* ===== 标题栏 ===== */
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: white;
  border-bottom: 1px solid #e5e5e7;
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.topbar-title {
  font-size: 14px;
  font-weight: 600;
  color: #1d1d1f;
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
  color: #999;
  padding: 4px 10px;
  border-radius: 6px;
  transition: background 0.1s;
}

.win-btn:hover {
  background: #e8e8ed;
  color: #333;
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
  background: white;
  border-right: 1px solid #e5e5e7;
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
  color: #555;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: #f0f0f2;
  color: #1d1d1f;
}

.nav-item.active {
  background: #e8e8ed;
  color: #1d1d1f;
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
  color: #1d1d1f;
}

.section-desc {
  font-size: 13px;
  color: #86868b;
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
  color: #555;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid #d2d2d7;
  border-radius: 10px;
  background: white;
  color: #1d1d1f;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s;
}

.form-input:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
}

.form-input::placeholder {
  color: #c0c0c5;
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
  border: 1px solid #d2d2d7;
  background: white;
  color: #555;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.15s;
}

.preset-btn:hover {
  border-color: #0071e3;
  color: #0071e3;
  background: #f5f9ff;
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
  background: #0071e3;
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

.about-card {
  background: white;
  border: 1px solid #e5e5e7;
  border-radius: 12px;
  padding: 20px;
  font-size: 13px;
  line-height: 1.6;
  color: #555;
}
</style>
