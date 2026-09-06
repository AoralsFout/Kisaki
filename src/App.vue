<script setup lang="ts">
/**
 * 桌宠 - 主应用组件
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Character from './components/Character.vue'
import DialogueBubble from './components/DialogueBubble.vue'
import InputBox from './components/InputBox.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ChatHistory from './components/ChatHistory.vue'
import CharacterSelect from './components/CharacterSelect.vue'
import SessionList from './components/SessionList.vue'
import WorkspaceChip from './components/WorkspaceChip.vue'
import ToolActivityList from './components/ToolActivityList.vue'
import ToolConfirm from './components/ToolConfirm.vue'
import CommandConfirm from './components/CommandConfirm.vue'
import CommandExecution from './components/CommandExecution.vue'
import DevPanel from './components/settings/DevPanel.vue'
import LogViewer from './components/LogViewer.vue'
import Onboarding from './components/Onboarding.vue'
import { useChatStore } from './stores/chat'
import { useSessionStore } from './stores/session'
import { useCharacterStore, initCharacterDataDir, getCharacterController } from './character'
import { isTtsEnabled, setTtsEnabled } from './tts'
import { loadConfigSecure, isConfigValid } from './ai'
import type { ChatInputPayload } from './ai'
import { loadCosyVoiceConfigSecure } from './tts'
import { resolveDisplayLanguage } from './stores/language'
import { setAvailableCharacters, setOnCharacterSwitched, getAgentLive2DController } from './agent'
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
  EVENT_CHARACTERS_CHANGED,
  EVENT_AI_CONFIG_CHANGED,
  EVENT_SETTINGS_NAVIGATE,
  STORAGE_ONBOARDING_DONE,
  STORAGE_ONBOARDING_DISMISSED,
} from './constants'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows } from '@tauri-apps/api/window'
import { listen, emitTo } from '@tauri-apps/api/event'
import { initPassthrough, setPassthroughEnabled, isPassthroughEnabled, isIgnoring } from './passthrough'
import { initWindowState } from './utils/windowState'

const log = createLogger('App')

const { t } = useI18n()

const isDev = import.meta.env.DEV && new URLSearchParams(window.location.search).has(QUERY_DEV)
const isSettings = new URLSearchParams(window.location.search).has(QUERY_SETTINGS)
const isLogs = new URLSearchParams(window.location.search).has(QUERY_LOGS)

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()

// 角色就绪标记 + 零角色判断：无任何角色时禁止聊天、引导用户去添加
const charReady = ref(false)
const noCharacter = computed(() => charReady.value && charStore.availableList.length === 0)

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

// 鼠标穿透开关（透明区域点击穿透到下方窗口）
const passthroughOn = ref(isPassthroughEnabled())

function togglePassthrough() {
  passthroughOn.value = !passthroughOn.value
  setPassthroughEnabled(passthroughOn.value)
}

/**
 * 应用当前角色的人格到对话上下文（仅更新 system prompt，不重置历史）。
 * 供首次初始化、UI 切角色、以及 AI 自助 switch_character 工具共用。
 */
function applyCharacterPersona() {
  if (!charStore.prompt) return
  const voiceLang = charStore.data?.voiceLanguage || DEFAULT_VOICE_LANGUAGE
  const displayLang = resolveDisplayLanguage(charStore.data?.textLanguage)
  chat.setSystemPrompt(charStore.prompt, voiceLang, displayLang, charStore.render)
}

/**
 * 收到「角色已变更」跨窗口通知后刷新主窗口状态：
 * 重新扫描角色列表，并确保有一个有效的当前角色（处理零→有、当前角色被删/被改）。
 */
async function onCharactersChanged() {
  await charStore.refreshList()
  setAvailableCharacters(charStore.availableList)
  const list = charStore.availableList
  if (list.length === 0) return // 角色被删空：noCharacter 自动恢复为 true
  const cur = charStore.currentId
  const target = list.includes(cur) ? cur : (list.includes('kisaki') ? 'kisaki' : list[0])
  await charStore.loadCharacter(target, true).catch((e) => log.error('刷新角色失败', e))
  applyCharacterPersona()
}

// 角色切换后（UI / agent / 会话恢复任一路径）统一刷新人设（system prompt）
watch(() => charStore.currentId, () => applyCharacterPersona())

// ── 首次运行引导 ──
const showOnboarding = ref(false)
// 引导完成/搁置状态：稍后 ≠ 完成；被搁置且配置仍未完成时，主窗口保留可恢复的配置待办入口
const onboardingDone = ref(false)
const onboardingDismissed = ref(false)
// API 配置是否已保存（仅代表字段完整，不代表连接测试通过）
const apiConfigured = ref(false)

function isOnboardingDone(): boolean {
  try { return localStorage.getItem(STORAGE_ONBOARDING_DONE) === '1' } catch { return true }
}

function isOnboardingDismissed(): boolean {
  try { return localStorage.getItem(STORAGE_ONBOARDING_DISMISSED) === '1' } catch { return false }
}

async function refreshApiConfigured() {
  try {
    apiConfigured.value = isConfigValid(await loadConfigSecure())
  } catch {
    apiConfigured.value = false
  }
}

/** 两步配置齐全，用户点击「开始使用」：写入完成标记并清除搁置标记 */
function finishOnboarding() {
  try {
    localStorage.setItem(STORAGE_ONBOARDING_DONE, '1')
    localStorage.removeItem(STORAGE_ONBOARDING_DISMISSED)
  } catch { /* ignore */ }
  onboardingDone.value = true
  onboardingDismissed.value = false
  showOnboarding.value = false
}

/** 「稍后再说」：仅搁置引导，不写完成标记；配置待办保留在主窗口 */
function laterOnboarding() {
  try { localStorage.setItem(STORAGE_ONBOARDING_DISMISSED, '1') } catch { /* ignore */ }
  onboardingDismissed.value = true
  showOnboarding.value = false
}

/** 配置待办：引导被搁置、配置仍未完成时显示，点击重新打开引导 */
const showConfigTodo = computed(() =>
  onboardingDismissed.value && !onboardingDone.value && !showOnboarding.value
  && !apiConfigured.value && !noCharacter.value,
)

let welcomeShown = false

onMounted(async () => {
  // 日志窗口/Dev 窗口不初始化角色和对话
  if (isLogs || isDev) return

  if (!isSettings) {
    // 主窗口在 Tauri 配置中隐藏创建：先恢复上次的位置/大小再显示，
    // 避免默认位置白窗闪现后瞬移。穿透初始化放在恢复之后，确保初始坐标正确。
    await initWindowState('main', { showAfterRestore: true })
      .catch(() => { /* 浏览器预览环境无原生窗口 */ })
    await initPassthrough().catch(() => { /* 浏览器预览环境无原生窗口 */ })
  }

  // 加载并解密 API Key（填充解密缓存，后续 sync loadConfig 直接取缓存）
  await Promise.allSettled([
    loadConfigSecure(),
    loadCosyVoiceConfigSecure(),
  ])
  void refreshApiConfigured()
  // 初始化 data_dir 路径（供 imageUrl / loadCharacterJson 使用），
  // await 确保 data_dir 就绪后再加载角色，避免时序竞态。
  await initCharacterDataDir().catch(() => { /* 非 Tauri 环境降级 */ })
  chat.init()
  await charStore.init().catch((e) => log.error('角色初始化失败', e))
  charReady.value = true
  // 首次运行：无完成标记时显示引导；已被「稍后」搁置则不再整层弹出，
  // 改以主窗口的配置待办入口恢复（仅主窗口）。
  if (!isSettings) {
    onboardingDone.value = isOnboardingDone()
    onboardingDismissed.value = isOnboardingDismissed()
    showOnboarding.value = !onboardingDone.value && !onboardingDismissed.value
  }
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
  await sessionStore.init()

  setTimeout(() => {
    if (!showOnboarding.value && !welcomeShown && chat.messages.length === 0) {
      welcomeShown = true
      chat.showBubbleText(t('app.bubble.welcome'), true)
    }
  }, 1000)

  // Dev 面板通信：仅主窗口响应，避免设置窗口/日志窗口的 handler 干扰
  if (!isDev && !isSettings && !isLogs) {
    try {
      const channel = new BroadcastChannel(CHANNEL_DESKPET_DEV)
      channel.onmessage = (event) => {
        const { type, payload } = event.data ?? {}
        const l2dCtrl = getAgentLive2DController()
        if (type === 'set-pose') {
          l2dCtrl?.setScreenPose(payload.key as any)
          getCharacterController()?.setScreenPose(payload.key as any)
          return
        }
        if (type === 'set-expression') { l2dCtrl?.setExpression(payload.expression as string); return }
        if (type === 'play-motion') { l2dCtrl?.playMotion(payload.group as string, payload.index ?? 0); return }
        if (type === 'set-stance') { getCharacterController()?.setPoseTag(payload.stance as string); return }
        if (type === 'set-emotion') { getCharacterController()?.setEmotion(payload.emotion as string); return }
        if (type === 'set-costume') { getCharacterController()?.setCostume(payload.costume as string); return }
        if (type === 'request-state') {
          const ctrl = getCharacterController()
          channel.postMessage({
            type: 'state-update',
            payload: {
              currentId: charStore.currentId,
              poseTag: ctrl?.currentPoseTag.value ?? '',
              emotion: ctrl?.currentEmotion.value ?? '',
              costume: ctrl?.currentCostume.value ?? '',
              screenPose: (ctrl ?? l2dCtrl)?.charStore?.currentScreenPose ?? 'full-center',
              expression: l2dCtrl?.currentExpression.value ?? '',
            },
          })
        }
      }
    } catch (e) { log.warn('BroadcastChannel 初始化失败', e) }
  }

  // 监听其它窗口（设置窗口）的角色变更通知，刷新主窗口角色状态
  await listen(EVENT_CHARACTERS_CHANGED, () => { onCharactersChanged() })
    .catch(() => { /* 浏览器预览环境无 Tauri 事件总线 */ })
  // 只让主窗口重建并保存会话；设置窗口持有的会话副本可能已过期，不能回写覆盖。
  if (!isSettings) {
    await listen(EVENT_AI_CONFIG_CHANGED, () => {
      chat.refreshModelContext()
      void refreshApiConfigured()
    })
      .catch(() => { /* 浏览器预览环境无 Tauri 事件总线 */ })
  }

})

// ---- 交互 ----

function handleCharacterClick() {
  if (noCharacter.value) {
    openSettingsWindow('character')
    return
  }
  if (chat.showBubble && chat.isTyping) {
    bubbleRef.value?.skipTyping()
    return
  }
  chat.openInput()
}

async function handleSend(payload: ChatInputPayload): Promise<boolean> {
  if (noCharacter.value || chat.isProcessing) return false
  if (charStore.render === 'illustration' && !getCharacterController()) return false
  const sessionId = sessionStore.currentSessionId
  const accepted = await chat.sendMessage(payload)
  if (sessionId === sessionStore.currentSessionId) {
    if (accepted) chat.closeInput()
    else chat.openInput()
  }
  return accepted
}

async function openSettingsWindow(tab?: string) {
  try {
    // 检查是否已有设置窗口
    const all = await getAllWindows()
    const existing = all.find(w => w.label === WINDOW_SETTINGS)
    if (existing) {
      await existing.unminimize()
      await existing.show()
      await existing.setFocus()
      // 已有窗口时通过事件定位到目标标签（设置窗口侧会先经过未保存更改确认）
      if (tab) {
        await emitTo(WINDOW_SETTINGS, EVENT_SETTINGS_NAVIGATE, { tab })
          .catch((e) => log.warn('定位设置标签失败', e))
      }
      return
    }

    const tabQuery = tab ? `&tab=${tab}` : ''
    new WebviewWindow(WINDOW_SETTINGS, {
      url: `/?${QUERY_SETTINGS}=1${tabQuery}`,
      title: t('window.settings'),
      width: 1000,
      height: 600,
      decorations: false,
      resizable: true,
      center: true,
      visible: false,
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
      title: t('window.logs'),
      width: 800,
      height: 500,
      x: mainPos ? mainPos.x + (mainSize?.width ?? 400) : undefined,
      y: mainPos ? mainPos.y : undefined,
      decorations: false,
      resizable: true,
      visible: false,
    })
  } catch (e) {
    log.error('无法打开日志窗口', e)
  }
}

async function handleSelectCharacter(charId: string) {
  if (charId === charStore.currentId) return
  // 先取消正在进行中的 AI 请求与 TTS，防止生成的回复被写入将被清空的上下文
  if (chat.isProcessing) chat.cancelResponse()
  const ctrl = getCharacterController()
  if (ctrl) {
    await ctrl.switchCharacter(charId)
  } else {
    // Live2D 角色无立绘控制器，走渲染无关切换
    await charStore.loadCharacter(charId, true)
    sessionStore.saveCurrentSession()
  }
  chat.resetContext()
  applyCharacterPersona()
  chat.showBubbleText(t('app.bubble.switchTo', { name: charStore.name }), false)
}
</script>

<template>
  <DevPanel v-if="isDev" />
  <SettingsPanel v-else-if="isSettings" />
  <LogViewer v-else-if="isLogs" />

  <main v-else class="app-container">
    <!-- 拖拽区域 -->
    <div class="drag-region" data-tauri-drag-region data-pet-solid></div>

    <!-- 角色区 -->
    <div class="character-area" :class="{ 'is-passthrough': isIgnoring }">
      <Character ref="characterRef" @click="handleCharacterClick" />

      <!-- 零角色引导：无任何角色时提示添加，聊天被禁用 -->
      <div v-if="noCharacter" class="no-char-guide" data-pet-solid>
        <i class="fas fa-masks-theater no-char-icon"></i>
        <p class="no-char-title">{{ t('app.noChar.title') }}</p>
        <p class="no-char-hint">{{ t('app.noChar.hint') }}</p>
        <button class="no-char-btn" @click="openSettingsWindow('character')">
          <i class="fas fa-plus"></i> {{ t('app.noChar.add') }}
        </button>
      </div>
    </div>

    <!-- 工具调用过程列表（右侧浮层，处理时自动显现） -->
    <ToolActivityList v-if="!noCharacter" />

    <!-- 底部交互区 -->
    <div class="bottom-area">
      <!-- 文件操作确认卡（AI 改文件且未开自动执行时弹出） -->
      <ToolConfirm v-if="!noCharacter" />
      <!-- 命令执行确认卡（AI 执行命令时弹出，每次都必须确认） -->
      <CommandConfirm v-if="!noCharacter && chat.pendingCommandConfirm" />
      <CommandExecution v-if="!noCharacter" />

      <!-- 对话气泡 -->
      <DialogueBubble ref="bubbleRef" :text="chat.currentBubbleText" :thinking="chat.currentThinking"
        :visible="chat.showBubble" :typing="chat.isTyping" @typing-end="chat.isTyping = false" />

      <div class="bars">
        <!-- 工作区条（AI 文件读写目录，按会话独立） -->
        <WorkspaceChip v-if="!noCharacter" />

        <!-- 工具按钮行（悬停展开文字） -->
        <div class="toolbar" data-pet-solid>
          <button class="tool-btn" :disabled="noCharacter" @click="chat.openInput()"
            :aria-label="t('app.aria.chatInput')">
            <i class="fas fa-comment btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.chat') }}</span>
          </button>
          <button class="tool-btn" :disabled="chat.isProcessing || noCharacter" @click="showSession = !showSession"
            :aria-label="t('app.aria.session')">
            <i class="fas fa-comments btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.session') }}</span>
          </button>
          <button class="tool-btn" :disabled="chat.isProcessing || noCharacter" @click="showHistory = !showHistory"
            :aria-label="t('app.aria.history')">
            <i class="fas fa-clipboard-list btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.history') }}</span>
          </button>
          <button class="tool-btn" :disabled="chat.isProcessing || noCharacter"
            @click="showCharacterSelect = !showCharacterSelect" :aria-label="t('app.aria.switchCharacter')">
            <i class="fas fa-rotate btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.character') }}</span>
          </button>
          <button class="tool-btn" :class="{ 'tts-off': !ttsEnabled }" @click="toggleTts"
            :aria-label="ttsEnabled ? t('app.aria.ttsOff') : t('app.aria.ttsOn')">
            <i class="fas fa-volume-high btn-icon"></i>
            <span class="btn-label">{{ ttsEnabled ? t('app.toolbar.voice') : t('app.toolbar.mute') }}</span>
          </button>
          <button class="tool-btn" :class="{ 'tts-off': !passthroughOn }" @click="togglePassthrough"
            :aria-label="passthroughOn ? t('app.aria.passthroughOff') : t('app.aria.passthroughOn')">
            <i class="fas fa-arrow-pointer btn-icon"></i>
            <span class="btn-label">{{ passthroughOn ? t('app.toolbar.passthrough') : t('app.toolbar.solid') }}</span>
          </button>
          <button class="tool-btn" @click="openLogWindow()" :aria-label="t('app.aria.logs')">
            <i class="fas fa-receipt btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.logs') }}</span>
          </button>
          <button class="tool-btn" @click="openSettingsWindow()" :aria-label="t('app.aria.settings')">
            <i class="fas fa-gear btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.settings') }}</span>
          </button>
        </div>

        <!-- 停止生成按钮（仅在 AI 生成中显示） -->
        <button v-if="chat.isProcessing" class="stop-btn" data-pet-solid @click="chat.cancelResponse()"
          :aria-label="t('app.aria.stop')">
          <i class="fas fa-stop"></i>
          <span>{{ t('app.stop') }}</span>
        </button>
      </div>

      <!-- 配置待办（引导被搁置且配置未完成时可恢复） -->
      <button v-if="showConfigTodo" class="stop-btn config-todo" data-pet-solid @click="showOnboarding = true"
        :aria-label="t('app.aria.configTodo')">
        <i class="fas fa-clipboard-check"></i>
        <span>{{ t('app.configTodo') }}</span>
      </button>

      <!-- 输入框（外包装控制高度动画，实现缓慢抬升） -->
      <div class="input-wrapper" :class="{ open: chat.showInput }">
        <InputBox :visible="chat.showInput" :disabled="chat.isProcessing" :draft-key="sessionStore.currentSessionId" :valid-draft-keys="sessionStore.sessionList.map(s => s.id)" :submit="handleSend"
          @close="chat.closeInput()" />
      </div>
    </div>

    <!-- 面板 -->
    <ChatHistory :visible="showHistory" @close="showHistory = false" />
    <SessionList :visible="showSession" @close="showSession = false" />
    <CharacterSelect :visible="showCharacterSelect" @close="showCharacterSelect = false"
      @select="handleSelectCharacter" />

    <!-- 首次运行引导（覆盖层） -->
    <Onboarding :visible="showOnboarding" @open-settings="openSettingsWindow" @finish="finishOnboarding"
      @later="laterOnboarding" />
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

/* ---- 零角色引导 ---- */
.no-char-guide {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
  background: rgba(20, 20, 35, 0.55);
  backdrop-filter: blur(3px);
  border-radius: 12px;
  z-index: 60;
}

.no-char-icon {
  font-size: 40px;
  color: rgba(255, 255, 255, 0.55);
  margin-bottom: 6px;
}

.no-char-title {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0;
}

.no-char-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0 0 12px;
}

.no-char-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  font-size: 13px;
  border: none;
  border-radius: 18px;
  background: #4a7aff;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
}

.no-char-btn:hover {
  opacity: 0.88;
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

  &::before {
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

/* 穿透态（鼠标在透明区）隐藏调试边框；实体态（可交互）显示红色虚线边框作状态指示。
   用 transparent 而非 none，保留 1px 占位避免布局抖动。 */
.character-area.is-passthrough {
  border-color: transparent;
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
  max-height: 380px;
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

.bottom-area>* {
  pointer-events: auto;
}

.bars {
  display: grid;
  /* 三列 */
  grid-template-columns: 3fr 7fr 3fr;
  max-width: 600px;
  gap: 6px;

  :chlidren {
    width: 30%;
  }
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
  position: relative;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.tool-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tool-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.btn-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.btn-label {
  position: absolute;
  font-size: 14px;
  border-radius: 8px;
  left: 50%;
  transform: translate(-50%, -35px);
  padding: 4px 6px;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.1s ease 0.1s;
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
  justify-content: center;
  gap: 6px;
  margin-bottom: 8px;
  background: rgba(210, 60, 60, 0.88);
  color: #fff;
  border: none;
  border-radius: 20px;
  font-size: 14px;
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: background 0.15s;
}

.stop-btn:hover {
  background: rgba(210, 60, 60, 1);
}

/* ---- 配置待办入口（复用停止按钮的胶囊形态，语义色为品牌蓝） ---- */
.config-todo {
  background: rgba(74, 122, 255, 0.88);
}

.config-todo:hover {
  background: rgba(74, 122, 255, 1);
}
</style>
