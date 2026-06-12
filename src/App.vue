<script setup lang="ts">
/**
 * 桌宠 - 主应用组件
 */
import { ref, onMounted, watch } from 'vue'
import Character from './components/Character.vue'
import DialogueBubble from './components/DialogueBubble.vue'
import InputBox from './components/InputBox.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ChatHistory from './components/ChatHistory.vue'
import CharacterSelect from './components/CharacterSelect.vue'
import SessionList from './components/SessionList.vue'
import DevPanel from './DevPanel.vue'
import LogViewer from './components/LogViewer.vue'
import { useChatStore } from './stores/chat'
import { useSessionStore } from './stores/session'
import { useCharacterStore, initCharacterDataDir } from './character'
import { isTtsEnabled, setTtsEnabled } from './tts'
import { loadConfigSecure } from './ai'
import { loadCosyVoiceConfigSecure } from './tts'
import { resolveDisplayLanguage } from './stores/language'
import { setAvailableCharacters, setOnCharacterSwitched } from './agent'
import { createLogger } from './utils/logger'
import {
  WINDOW_MAIN,
  WINDOW_SETTINGS,
  WINDOW_LOGS,
  QUERY_DEV,
  QUERY_SETTINGS,
  QUERY_LOGS,
  CHANNEL_DESKPET_DEV,
  DEFAULT_VOICE_LANGUAGE,
} from './constants'
import { register } from '@tauri-apps/plugin-global-shortcut'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows } from '@tauri-apps/api/window'

const log = createLogger('App')

const isDev = new URLSearchParams(window.location.search).has(QUERY_DEV)
const isSettings = new URLSearchParams(window.location.search).has(QUERY_SETTINGS)
const isLogs = new URLSearchParams(window.location.search).has(QUERY_LOGS)

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()

const characterRef = ref<InstanceType<typeof Character> | null>(null)
const bubbleRef = ref<InstanceType<typeof DialogueBubble> | null>(null)

const showHistory = ref(false)
const showSession = ref(false)
const showCharacterSelect = ref(false)
const ttsEnabled = ref(isTtsEnabled())

function toggleTts() {
  ttsEnabled.value = !ttsEnabled.value
  setTtsEnabled(ttsEnabled.value)
}

/**
 * 应用当前角色的人格到对话上下文（仅更新 system prompt，不重置历史）。
 * 供首次初始化、UI 切角色、以及 AI 自助 switch_character 工具共用。
 */
function applyCharacterPersona() {
  if (!charStore.prompt) return
  const voiceLang = charStore.data?.voiceLanguage || DEFAULT_VOICE_LANGUAGE
  const displayLang = resolveDisplayLanguage(charStore.data?.textLanguage)
  chat.setSystemPrompt(charStore.prompt, voiceLang, displayLang)
}

let welcomeShown = false

onMounted(async () => {
  // 日志窗口/Dev 窗口不初始化角色和对话
  if (isLogs || isDev) return

  // 加载并解密 API Key（填充解密缓存，后续 sync loadConfig 直接取缓存）
  await Promise.allSettled([
    loadConfigSecure(),
    loadCosyVoiceConfigSecure(),
  ])
  // 初始化 data_dir 路径（供 imageUrl / loadCharacterJson 使用），
  // await 确保 data_dir 就绪后再加载角色，避免时序竞态。
  await initCharacterDataDir().catch(() => { /* 非 Tauri 环境降级 */ })
  chat.init()
  await charStore.init()
  // 同步可用角色列表到 agent 上下文（避免 agent 直接 import Pinia）
  setAvailableCharacters(charStore.availableList)
  watch(() => charStore.availableList, (list) => {
    setAvailableCharacters(list)
  })
  if (charStore.prompt) {
    applyCharacterPersona()
  }
  // 注入“AI 自助切换角色后刷新人格”回调（switch_character 工具会调用）
  setOnCharacterSwitched(applyCharacterPersona)

  // 初始化会话管理（system prompt 设定后加载历史消息）
  sessionStore.init()

  setTimeout(() => {
    if (!welcomeShown && chat.messages.length === 0) {
      welcomeShown = true
      chat.showBubbleText('嘿嘿', true)
    }
  }, 1000)

  if (!isDev) {
    try {
      const channel = new BroadcastChannel(CHANNEL_DESKPET_DEV)
      channel.onmessage = (event) => {
        const { type, payload } = event.data ?? {}
        const ctrl = characterRef.value?.controller
        if (!ctrl) return
        if (type === 'set-pose') ctrl.setScreenPose(payload.key as any)
        if (type === 'set-emotion') ctrl.setEmotion(payload.emotion as any)
        if (type === 'set-stance') ctrl.setPoseTag(payload.stance as any)
        if (type === 'set-costume') ctrl.setCostume(payload.costume as any)
        if (type === 'request-state') {
          channel.postMessage({
            type: 'state-update',
            payload: {
              poseTag: ctrl.currentPoseTag.value,
              emotion: ctrl.currentEmotion.value,
              costume: ctrl.currentCostume.value,
            },
          })
        }
      }
    } catch (e) { log.warn('BroadcastChannel 初始化失败', e) }
  }

  // 注册全局快捷键
  if (!isDev && !isSettings && !isLogs) {
    try {
      await register('Ctrl+Shift+L', (event) => {
        if (event.state === 'Pressed') openLogWindow()
      })
      await register('Ctrl+Shift+S', (event) => {
        if (event.state === 'Pressed') openSettingsWindow()
      })
      await register('Ctrl+Shift+T', (event) => {
        if (event.state === 'Pressed') toggleTts()
      })
      log.info('全局快捷键已注册 (Ctrl+Shift+L=日志, S=设置, T=静音)')
    } catch (e) { log.warn('全局快捷键注册失败', e) }
  }
})

// ---- 交互 ----

function handleCharacterClick() {
  if (chat.showBubble && chat.isTyping) {
    bubbleRef.value?.skipTyping()
    return
  }
  chat.openInput()
}

function handleSend(text: string) {
  if (!characterRef.value?.controller) return
  chat.closeInput()
  chat.sendMessage(text)
}

async function openSettingsWindow() {
  try {
    // 检查是否已有设置窗口
    const all = await getAllWindows()
    const existing = all.find(w => w.label === WINDOW_SETTINGS)
    if (existing) {
      await existing.unminimize()
      await existing.show()
      await existing.setFocus()
      return
    }

    new WebviewWindow(WINDOW_SETTINGS, {
      url: `/?${QUERY_SETTINGS}=1`,
      title: '设置',
      width: 1000,
      height: 600,
      decorations: false,
      resizable: true,
      center: true,
    })
  } catch (e) {
    log.error('无法打开设置窗口', e)
  }
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

    const appWindow = all.find(w => w.label === WINDOW_MAIN)
    const mainPos = appWindow ? await appWindow.outerPosition() : undefined
    const mainSize = appWindow ? await appWindow.outerSize() : undefined

    new WebviewWindow(WINDOW_LOGS, {
      url: `/?${QUERY_LOGS}=1`,
      title: '日志',
      width: 800,
      height: 500,
      x: mainPos ? mainPos.x + (mainSize?.width ?? 400) : undefined,
      y: mainPos ? mainPos.y : undefined,
      decorations: false,
      resizable: true,
    })
  } catch (e) {
    log.error('无法打开日志窗口', e)
  }
}

async function handleSelectCharacter(charId: string) {
  const ctrl = characterRef.value?.controller
  if (!ctrl || charId === charStore.currentId) return
  // 先取消正在进行中的 AI 请求与 TTS，防止生成的回复被写入将被清空的上下文
  if (chat.isProcessing) chat.cancelResponse()
  await ctrl.switchCharacter(charId)
  chat.resetContext()
  applyCharacterPersona()
  chat.showBubbleText(`切换到 ${charStore.name}~`, false)
}
</script>

<template>
  <DevPanel v-if="isDev" />
  <SettingsPanel v-else-if="isSettings" />
  <LogViewer v-else-if="isLogs" />

  <main v-else class="app-container">
    <!-- 拖拽区域 -->
    <div class="drag-region" data-tauri-drag-region></div>

    <!-- 角色区 -->
    <div class="character-area">
      <Character ref="characterRef" @click="handleCharacterClick" />
    </div>

    <!-- 底部交互区 -->
    <div class="bottom-area">
      <!-- 对话气泡 -->
      <DialogueBubble
        ref="bubbleRef"
        :text="chat.currentBubbleText"
        :thinking="chat.currentThinking"
        :visible="chat.showBubble"
        :typing="chat.isTyping"
        @typing-end="chat.isTyping = false"
      />

      <!-- 停止生成按钮（仅在 AI 生成中显示） -->
      <button
        v-if="chat.isProcessing"
        class="stop-btn"
        @click="chat.cancelResponse()"
        aria-label="停止生成"
      >
        <i class="fas fa-stop"></i>
        <span>停止</span>
      </button>

      <!-- 工具按钮行（悬停展开文字） -->
      <div class="toolbar">
        <button class="tool-btn" @click="chat.openInput()" aria-label="打开聊天输入框">
          <i class="fas fa-comment btn-icon"></i>
          <span class="btn-label">聊天</span>
        </button>
        <button class="tool-btn" :disabled="chat.isProcessing" @click="showSession = !showSession" aria-label="会话管理">
          <i class="fas fa-comments btn-icon"></i>
          <span class="btn-label">会话</span>
        </button>
        <button class="tool-btn" :disabled="chat.isProcessing" @click="showHistory = !showHistory" aria-label="打开对话历史">
          <i class="fas fa-clipboard-list btn-icon"></i>
          <span class="btn-label">历史</span>
        </button>
        <button class="tool-btn" :disabled="chat.isProcessing" @click="showCharacterSelect = !showCharacterSelect" aria-label="切换角色">
          <i class="fas fa-rotate btn-icon"></i>
          <span class="btn-label">角色</span>
        </button>
        <button class="tool-btn" :class="{ 'tts-off': !ttsEnabled }" @click="toggleTts" :aria-label="ttsEnabled ? '关闭语音播报' : '开启语音播报'">
          <i class="fas fa-volume-high btn-icon"></i>
          <span class="btn-label">{{ ttsEnabled ? '语音' : '静音' }}</span>
        </button>
        <button class="tool-btn" @click="openLogWindow()" aria-label="打开日志窗口">
          <i class="fas fa-receipt btn-icon"></i>
          <span class="btn-label">日志</span>
        </button>
        <button class="tool-btn" @click="openSettingsWindow()" aria-label="打开设置窗口">
          <i class="fas fa-gear btn-icon"></i>
          <span class="btn-label">设置</span>
        </button>
      </div>

      <!-- 输入框（外包装控制高度动画，实现缓慢抬升） -->
      <div class="input-wrapper" :class="{ open: chat.showInput }">
        <InputBox
          :visible="chat.showInput"
          :disabled="chat.isProcessing"
          @send="handleSend"
          @close="chat.closeInput()"
        />
      </div>
    </div>

    <!-- 面板 -->
    <ChatHistory :visible="showHistory" @close="showHistory = false" />
    <SessionList :visible="showSession" @close="showSession = false" />
    <CharacterSelect :visible="showCharacterSelect" @close="showCharacterSelect = false" @select="handleSelectCharacter" />
  </main>
</template>

<style scoped>
.app-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: transparent;
}

.drag-region {
  position: fixed;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 200px;
  height: 30px;
  -webkit-app-region: drag;
  cursor: move;
  z-index: 1000;
  background: #00000090;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  font-size: 12px;
  opacity: 0;

  transition: opacity 0.25s;

  &:hover {
    opacity: 1;
  }

  &::before{
    position: absolute;
    content: ' ';
    width: 150px;
    height: 1px;
    background: #999;
  }
}

.character-area {
  position: absolute;
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  border: 1px dashed #f00;
}

/* ---- 输入框展开动画（缓慢抬升工具栏/气泡） ---- */
.input-wrapper {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.4s ease;
  width: 100%;
  pointer-events: auto;
}

.input-wrapper.open {
  max-height: 260px;
}

/* ---- 底部工具栏 ---- */
.bottom-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.bottom-area > * {
  pointer-events: auto;
}

.toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(8px);
  padding: 6px 10px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.tool-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 12px;
  transition: background 0.15s;
  line-height: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  max-width: 28px;
  transition: max-width 0.25s ease, background 0.15s;
}

.tool-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tool-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  max-width: 80px;
}

.btn-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.btn-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.15s ease 0.1s;
}

.tool-btn:hover .btn-label {
  opacity: 1;
}

.tool-btn.tts-off {
  opacity: 0.5;
}

.tool-btn.tts-off:hover {
  opacity: 0.8;
}

/* ---- 停止生成按钮 ---- */
.stop-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px 16px;
  background: rgba(210, 60, 60, 0.88);
  color: #fff;
  border: none;
  border-radius: 16px;
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: background 0.15s;
}

.stop-btn:hover {
  background: rgba(210, 60, 60, 1);
}
</style>
