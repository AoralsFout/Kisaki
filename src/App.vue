<script setup lang="ts">
/**
 * 桌宠 - 主应用组件
 */
import { ref, onMounted } from 'vue'
import Character from './components/Character.vue'
import DialogueBubble from './components/DialogueBubble.vue'
import InputBox from './components/InputBox.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ChatHistory from './components/ChatHistory.vue'
import CharacterSelect from './components/CharacterSelect.vue'
import DevPanel from './DevPanel.vue'
import { useChatStore } from './stores/chat'
import { useCharacterStore } from './character'
import { speakText, isTtsEnabled, setTtsEnabled } from './tts'
import { resolveDisplayLanguage } from './stores/language'

const isDev = new URLSearchParams(window.location.search).has('dev')
const isSettings = new URLSearchParams(window.location.search).has('settings')

const chat = useChatStore()
const charStore = useCharacterStore()

const characterRef = ref<InstanceType<typeof Character> | null>(null)
const bubbleRef = ref<InstanceType<typeof DialogueBubble> | null>(null)

const showHistory = ref(false)
const showCharacterSelect = ref(false)
const ttsEnabled = ref(isTtsEnabled())

function toggleTts() {
  ttsEnabled.value = !ttsEnabled.value
  setTtsEnabled(ttsEnabled.value)
}

let welcomeShown = false

onMounted(async () => {
  chat.init()
  await charStore.init()
  if (charStore.prompt) {
    const voiceLang = charStore.data?.voiceLanguage || 'ja-JP'
    const displayLang = resolveDisplayLanguage(charStore.data?.textLanguage)
    chat.setSystemPrompt(charStore.prompt, voiceLang, displayLang)
  }

  setTimeout(() => {
    if (!welcomeShown) {
      welcomeShown = true
      chat.showBubbleText('嘿嘿', true)
      // // TTS 播报欢迎语
      // if (isTtsEnabled() && charStore.data?.voice) {
      //   speakText('', charStore.data.voice).catch(() => {})
      // }
    }
  }, 1000)

  if (!isDev) {
    try {
      const channel = new BroadcastChannel('deskpet-dev')
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
    } catch { /* ignore */ }
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
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const { getAllWindows } = await import('@tauri-apps/api/window')
  try {
    // 检查是否已有设置窗口
    const all = await getAllWindows()
    const existing = all.find(w => w.label === 'settings')
    if (existing) {
      await existing.unminimize()
      await existing.show()
      await existing.setFocus()
      return
    }

    new WebviewWindow('settings', {
      url: '/?settings=1',
      title: '设置',
      width: 1000,
      height: 600,
      decorations: false,
      resizable: true,
      center: true,
    })
  } catch (e) {
    console.error('无法打开设置窗口', e)
  }
}

async function handleSelectCharacter(charId: string) {
  const ctrl = characterRef.value?.controller
  if (!ctrl || charId === charStore.currentId) return
  await ctrl.switchCharacter(charId)
  chat.resetContext()
  if (charStore.prompt) {
    const voiceLang = charStore.data?.voiceLanguage || 'ja-JP'
    const displayLang = resolveDisplayLanguage(charStore.data?.textLanguage)
    chat.setSystemPrompt(charStore.prompt, voiceLang, displayLang)
  }
  chat.showBubbleText(`切换到 ${charStore.name}~`, false)
}
</script>

<template>
  <DevPanel v-if="isDev" />
  <SettingsPanel v-else-if="isSettings" />

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
      />

      <!-- 工具按钮行（悬停展开文字） -->
      <div class="toolbar">
        <button class="tool-btn" @click="chat.openInput()">
          <i class="fas fa-comment btn-icon"></i>
          <span class="btn-label">聊天</span>
        </button>
        <button class="tool-btn" @click="showHistory = !showHistory">
          <i class="fas fa-clipboard-list btn-icon"></i>
          <span class="btn-label">历史</span>
        </button>
        <button class="tool-btn" @click="showCharacterSelect = !showCharacterSelect">
          <i class="fas fa-rotate btn-icon"></i>
          <span class="btn-label">角色</span>
        </button>
        <button class="tool-btn" :class="{ 'tts-off': !ttsEnabled }" @click="toggleTts">
          <i class="fas fa-volume-high btn-icon"></i>
          <span class="btn-label">{{ ttsEnabled ? '语音' : '静音' }}</span>
        </button>
        <button class="tool-btn" @click="openSettingsWindow()">
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

.tool-btn:hover {
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
</style>
