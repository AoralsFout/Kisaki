<script setup lang="ts">
/**
 * 桌宠 - 主应用组件
 */
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Character from './components/Character.vue'
import InputBox from './components/InputBox.vue'
import ChatHistory from './components/ChatHistory.vue'
import ConversationDock from './components/ConversationDock.vue'
import CharacterSelect from './components/CharacterSelect.vue'
import SessionList from './components/SessionList.vue'
import WorkspaceChip from './components/WorkspaceChip.vue'
import ToolActivityList from './components/ToolActivityList.vue'
import ToolConfirm from './components/ToolConfirm.vue'
import CommandConfirm from './components/CommandConfirm.vue'
import ScreenCaptureConfirm from './components/ScreenCaptureConfirm.vue'
import CommandExecution from './components/CommandExecution.vue'
import Onboarding from './components/Onboarding.vue'
import { useChatStore } from './stores/chat'
import { useSessionStore } from './stores/session'
import { useCharacterStore } from './character'
import { isTtsEnabled, setTtsEnabled } from './tts'
import { loadConfigSecure, isConfigValid } from './ai'
import type { ChatInputPayload } from './ai'
import { startMainWindow } from './startup'
import { resolveDisplayLanguage } from './stores/language'
import { createLogger } from './utils/logger'
import {
  WINDOW_SETTINGS,
  QUERY_SETTINGS,
  CHANNEL_DESKPET_DEV,
  DEFAULT_VOICE_LANGUAGE,
  EVENT_CHARACTERS_CHANGED,
  EVENT_AI_CONFIG_CHANGED,
  EVENT_SETTINGS_NAVIGATE,
  STORAGE_ONBOARDING_DONE,
  STORAGE_ONBOARDING_DISMISSED,
  STORAGE_CHARACTER_CANVAS_TOP,
} from './constants'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getAllWindows, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { listen, emitTo } from '@tauri-apps/api/event'
import { setPassthroughEnabled, isPassthroughEnabled } from './passthrough'
import { adjustCharacterOpacity, getCharacterOpacity } from './character/opacity'

const log = createLogger('App')

const { t } = useI18n()

const chat = useChatStore()
const sessionStore = useSessionStore()
const charStore = useCharacterStore()

// 角色就绪标记 + 零角色判断：无任何角色时禁止聊天、引导用户去添加
const charReady = ref(false)
const noCharacter = computed(() => charReady.value && charStore.availableList.length === 0)

const characterRef = ref<InstanceType<typeof Character> | null>(null)
// 透明度由 App 单一持有，角色组件通过 update:opacity 回传悬浮滚轮调整结果。
const characterOpacity = ref(getCharacterOpacity())
const characterOpacityPercent = computed(() => Math.round(characterOpacity.value * 100))

// 聊天 = 对话框从底部弹出 + 历史对话向上展开到全高（两者由 chat.showInput 驱动）
const showSession = ref(false)
const showCharacterSelect = ref(false)
const ttsEnabled = ref(isTtsEnabled())
const latestMessageHeight = ref(0)

// ── 角色画布顶部位置 ────────────────────────────────
const CHARACTER_CANVAS_TOP_MAX = 0.8

function clampCharacterTopRatio(value: number): number {
  return Math.min(CHARACTER_CANVAS_TOP_MAX, Math.max(0, value))
}

function loadCharacterTopRatio(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_CHARACTER_CANVAS_TOP))
    if (Number.isFinite(stored)) return clampCharacterTopRatio(stored)
  } catch { /* 忽略 */ }
  return 0
}

const characterTopRatio = ref(loadCharacterTopRatio())
const characterCanvasStyle = computed(() => ({
  top: `${characterTopRatio.value * 100}%`,
}))

watch(characterTopRatio, value => {
  try { localStorage.setItem(STORAGE_CHARACTER_CANVAS_TOP, String(value)) } catch { /* 忽略 */ }
})

async function startWindowDrag(event: MouseEvent) {
  if (event.button !== 0) return
  try {
    await getCurrentWindow().startDragging()
  } catch (error) {
    log.warn("app.start_window_drag.warn", "拖动窗口失败", error)
  }
}

/** 键盘方向键移动窗口。 */
async function onMoveWindowKeydown(event: KeyboardEvent) {
  const step = 20
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
  if (!dx && !dy) return
  event.preventDefault()
  event.stopPropagation()
  try {
    const appWindow = getCurrentWindow()
    const position = await appWindow.outerPosition()
    await appWindow.setPosition(new PhysicalPosition(position.x + dx, position.y + dy))
  } catch (error) {
    log.warn("app.move_window_keydown.warn", "键盘移动窗口失败", error)
  }
}

/** 滚轮向下缩短画布，向上增高画布。 */
function onCanvasHeightWheel(event: WheelEvent) {
  const delta = Math.max(-0.05, Math.min(0.05, event.deltaY * 0.0004))
  if (!delta) return
  characterTopRatio.value = clampCharacterTopRatio(characterTopRatio.value + delta)
}

/** 键盘方向键：↑ 增高画布，↓ 缩短画布。 */
function onCanvasHeightKeydown(event: KeyboardEvent) {
  const delta = event.key === 'ArrowDown' ? 0.03 : event.key === 'ArrowUp' ? -0.03 : 0
  if (!delta) return
  event.preventDefault()
  event.stopPropagation()
  characterTopRatio.value = clampCharacterTopRatio(characterTopRatio.value + delta)
}

/** 工具栏显式调整透明度：不受“悬浮角色滚轮”设置开关影响。 */
function onCharacterOpacityWheel(event: WheelEvent) {
  event.preventDefault()
  event.stopPropagation()
  characterOpacity.value = adjustCharacterOpacity(characterOpacity.value, event.deltaY)
}

function onCharacterOpacityKeydown(event: KeyboardEvent) {
  const deltaY = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!deltaY) return
  event.preventDefault()
  event.stopPropagation()
  characterOpacity.value = adjustCharacterOpacity(characterOpacity.value, deltaY)
}

/** 打开对话框（历史随对话框展开）；会话/换角色等其它浮层互斥关闭 */
function openChat() {
  if (noCharacter.value) {
    openSettingsWindow('character')
    return
  }
  chat.openInput()
  showSession.value = false
  showCharacterSelect.value = false
  closeMoreMenu()
}

/** 工具栏聊天按钮：切换历史/对话框的展开状态。 */
function toggleChat() {
  if (chat.showInput) {
    chat.closeInput()
    closeMoreMenu()
    return
  }
  openChat()
}

// ── 「更多」菜单：语音、穿透、会话、设置收敛于此（日志入口在 设置 → 诊断） ──
const showMoreMenu = ref(false)
const moreButtonRef = ref<HTMLButtonElement | null>(null)
const moreMenuRef = ref<HTMLElement | null>(null)

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value
}

function closeMoreMenu() {
  showMoreMenu.value = false
}

/** 「更多」菜单项动作：先把焦点交还触发按钮，再打开后续面板 */
async function menuAct(action: () => void) {
  closeMoreMenu()
  await nextTick()
  action()
}

watch(showMoreMenu, async visible => {
  if (visible) {
    await nextTick()
    moreMenuRef.value?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  } else {
    const shouldRestore = Boolean(moreMenuRef.value?.contains(document.activeElement))
    await nextTick()
    if (shouldRestore) moreButtonRef.value?.focus()
  }
})

function onMoreMenuKeydown(event: KeyboardEvent) {
  const items = [...(moreMenuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMoreMenu()
    void nextTick(() => moreButtonRef.value?.focus())
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length
  items[next].focus()
}

function toggleSessionPanel() {
  const opening = !showSession.value
  showSession.value = opening
  if (opening) {
    chat.closeInput()
    showCharacterSelect.value = false
    closeMoreMenu()
  }
}

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
 * 供首次初始化、发送消息前的 UI 切角色以及会话恢复共用。
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
  const list = charStore.availableList
  if (list.length === 0) return // 角色被删空：noCharacter 自动恢复为 true
  const cur = charStore.currentId
  const target = list.includes(cur) ? cur : (list.includes('kisaki') ? 'kisaki' : list[0])
  await charStore.loadCharacter(target, true).catch((e) => log.error("app.on_characters_changed.error", "刷新角色失败", e))
}

// 角色首次加载、切换或同 ID 配置刷新后，统一同步一次人设。
// 监听 data 而非 currentId，既能覆盖启动时 ID 未变的默认角色，也能覆盖同角色热刷新。
watch(() => charStore.data, () => applyCharacterPersona(), { flush: 'sync' })

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
  } catch { /* 忽略 */ }
  onboardingDone.value = true
  onboardingDismissed.value = false
  showOnboarding.value = false
}

/** 「稍后再说」：仅搁置引导，不写完成标记；配置待办保留在主窗口 */
function laterOnboarding() {
  try { localStorage.setItem(STORAGE_ONBOARDING_DISMISSED, '1') } catch { /* 忽略 */ }
  onboardingDismissed.value = true
  showOnboarding.value = false
}

/** 配置待办：引导被搁置、配置仍未完成时显示，点击重新打开引导 */
const showConfigTodo = computed(() =>
  onboardingDismissed.value && !onboardingDone.value && !showOnboarding.value
  && !apiConfigured.value && !noCharacter.value,
)

// ── 聊天展示 ──
/** 上下文预算悬浮详情（输入框底栏圆环用） */
const contextDetail = computed(() => t('chat.history.contextDetail', {
  used: chat.contextStats.estimatedTokens,
  max: chat.contextStats.maxContextTokens,
  tools: chat.contextStats.toolDefinitionTokens,
  pruned: chat.contextStats.prunedMessages,
}))

onMounted(async () => {
  // 启动序列（窗口恢复、凭据预热、会话与角色加载）由 startup.ts 负责，
  // 本组件只保留界面状态与事件绑定。
  await startMainWindow()
  void refreshApiConfigured()
  // 首次运行：无完成标记时显示引导；已被「稍后」搁置则不再整层弹出，
  // 改以主窗口的配置待办入口恢复（仅主窗口）。
  onboardingDone.value = isOnboardingDone()
  onboardingDismissed.value = isOnboardingDismissed()
  showOnboarding.value = !onboardingDone.value && !onboardingDismissed.value
  // 角色和会话状态均已恢复，此时再挂载渲染器，首帧即为正确角色。
  charReady.value = true

  // Dev 面板通信：根入口已确保只有主窗口执行此 handler。
  try {
    const channel = new BroadcastChannel(CHANNEL_DESKPET_DEV)
    channel.onmessage = (event) => {
      const { type, payload } = event.data ?? {}
      if (type === 'set-pose') {
        charStore.setScreenPose(payload.key as any)
        return
      }
      if (type === 'set-expression') { charStore.setVisualLook({ emotion: payload.expression as string }); return }
      if (type === 'play-motion') { void charStore.playMotion(payload.group as string, payload.index ?? 0); return }
      if (type === 'set-stance') { charStore.setVisualLook({ stance: payload.stance as string }); return }
      if (type === 'set-emotion') { charStore.setVisualLook({ emotion: payload.emotion as string }); return }
      if (type === 'set-costume') { charStore.setVisualLook({ costume: payload.costume as string }); return }
      if (type === 'request-state') {
        const snapshot = charStore.getRuntimeSnapshot()
        channel.postMessage({
          type: 'state-update',
          payload: {
            currentId: charStore.currentId,
            poseTag: snapshot.look?.stance ?? '',
            emotion: snapshot.look?.emotion ?? '',
            costume: snapshot.look?.costume ?? '',
            screenPose: snapshot.look?.screenPose ?? 'full-center',
            expression: snapshot.render === 'live2d' ? (snapshot.look?.emotion ?? '') : '',
          },
        })
      }
    }
  } catch (e) { log.warn("app.module.warn", "BroadcastChannel 初始化失败", e) }

  // 监听其它窗口（设置窗口）的角色变更通知，刷新主窗口角色状态
  await listen(EVENT_CHARACTERS_CHANGED, () => { onCharactersChanged() })
    .catch(() => { /* 浏览器预览环境无 Tauri 事件总线 */ })
  await listen(EVENT_AI_CONFIG_CHANGED, () => {
    chat.refreshModelContext()
    void refreshApiConfigured()
  })
    .catch(() => { /* 浏览器预览环境无 Tauri 事件总线 */ })

})

// ---- 交互 ----

function handleCharacterClick() {
  if (noCharacter.value) {
    openSettingsWindow('character')
    return
  }
  openChat()
}

async function handleSend(payload: ChatInputPayload): Promise<boolean> {
  if (noCharacter.value || chat.isProcessing) return false
  if (!charStore.hasActiveRenderer()) return false
  // 消息一经接受立即收起对话框（历史折叠回一条消息高度），不等生成完成；
  // 被拒绝（未配置/断网/处理中）时重新弹出，草稿与错误提示仍保留在输入框内
  chat.closeInput()
  const sessionId = sessionStore.currentSessionId
  const accepted = await chat.sendMessage(payload)
  if (sessionId === sessionStore.currentSessionId && !accepted) chat.openInput()
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
          .catch((e) => log.warn("app.open_settings_window.warn", "定位设置标签失败", e))
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
    log.error("app.open_settings_window.error", "无法打开设置窗口", e)
  }
}

async function handleSelectCharacter(charId: string) {
  if (!sessionStore.canChangeCharacter || charId === charStore.currentId) return
  await charStore.loadCharacter(charId, true)
  await sessionStore.bindCurrentCharacter()
  chat.resetContext()
  // resetContext 会清除旧角色人设；切换完成后将新角色人设写入新上下文。
  applyCharacterPersona()
}
</script>

<template>
  <main class="app-container">
    <!-- 角色区 -->
    <!-- 边框跟随穿透模式（而非光标瞬时命中）：实体态常显作状态指示，穿透态始终隐藏 -->
    <div class="character-area" :class="{ 'is-passthrough': passthroughOn }">
      <div class="character-canvas" :style="characterCanvasStyle">
        <Character v-if="charReady && !noCharacter" ref="characterRef" :opacity="characterOpacity"
          @update:opacity="characterOpacity = $event" @click="handleCharacterClick" />
      </div>

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

    <!-- 底部交互区：统一轨道协调历史区与输入区的开合 -->
    <ConversationDock :expanded="chat.showInput" :latest-message-height="latestMessageHeight"
      :layout-key="sessionStore.currentSessionId">
      <template #before>
        <!-- 文件操作确认卡（AI 改文件且未开自动执行时弹出） -->
        <ToolConfirm v-if="!noCharacter" />
        <!-- 命令执行确认卡（AI 执行命令时弹出，每次都必须确认） -->
        <CommandConfirm v-if="!noCharacter && chat.pendingApproval?.kind === 'command'" />
        <!-- 屏幕截图确认卡（高隐私读取，每次只能允许一次） -->
        <ScreenCaptureConfirm v-if="!noCharacter && chat.pendingApproval?.kind === 'screen-capture'" />
        <CommandExecution v-if="!noCharacter" />
      </template>

      <!-- 历史对话：常驻底部；折叠时显示最新一条，对话框弹出时展开到可用高度 -->
      <template #history="{ collapsedHeight, latestOverflowing }">
        <ChatHistory visible :collapsed-height="collapsedHeight" :latest-overflowing="latestOverflowing"
          @latest-height-change="latestMessageHeight = $event" />
      </template>

      <template #after>

      <!-- 状态行：配置待办；无内容时不渲染，出现时不推动工具栏位置 -->
      <div v-if="showConfigTodo" class="status-row" data-pet-solid>
        <button class="stop-btn config-todo" @click="showOnboarding = true" :aria-label="t('app.aria.configTodo')">
          <i class="fas fa-clipboard-check"></i>
          <span>{{ t('app.configTodo') }}</span>
        </button>
      </div>

      <div class="bars">
        <!-- 工作区条（AI 文件读写目录，按会话独立） -->
        <WorkspaceChip v-if="!noCharacter" />
        <!-- 陪伴状态工具栏：聊天 / 会话 / 更多（换角色、语音、穿透、设置收敛进更多；日志入口在 设置 → 诊断） -->
        <div class="toolbar" data-pet-solid>
          <button class="tool-btn" :disabled="noCharacter" @click="toggleChat" :aria-expanded="chat.showInput"
            :aria-label="t('app.aria.chatInput')">
            <i class="fas fa-comment btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.chat') }}</span>
          </button>
          <button class="tool-btn" :disabled="chat.isProcessing || noCharacter" @click="toggleSessionPanel"
            :aria-label="t('app.toolbar.session')">
            <i class="fas fa-comments btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.session') }}</span>
          </button>
          <div class="more-wrap">
            <button ref="moreButtonRef" class="tool-btn" :class="{ active: showMoreMenu }" @click="toggleMoreMenu"
              :aria-expanded="showMoreMenu" aria-haspopup="menu" aria-controls="more-menu"
              :aria-label="t('app.aria.more')">
              <i class="fas fa-ellipsis btn-icon"></i>
              <span class="btn-label">{{ t('app.toolbar.more') }}</span>
            </button>
            <Transition name="menu-fade">
              <div v-if="showMoreMenu" id="more-menu" ref="moreMenuRef" class="more-menu" role="menu" data-pet-solid
                @keydown="onMoreMenuKeydown">
                <button class="menu-item" role="menuitem"
                  :disabled="chat.isProcessing || noCharacter || !sessionStore.canChangeCharacter"
                  :title="!sessionStore.canChangeCharacter ? t('app.toolbar.characterLocked') : undefined"
                  @click="menuAct(() => { showCharacterSelect = true })">
                  <i class="fas fa-rotate menu-icon"></i>
                  <span>{{ t('app.toolbar.character') }}</span>
                </button>
                <button class="menu-item" role="menuitem" :aria-pressed="ttsEnabled" @click="menuAct(toggleTts)">
                  <i class="fas fa-volume-high menu-icon" :class="{ 'is-off': !ttsEnabled }"></i>
                  <span>{{ ttsEnabled ? t('app.toolbar.voice') : t('app.toolbar.mute') }}</span>
                </button>
                <button class="menu-item" role="menuitem" :aria-pressed="passthroughOn"
                  @click="menuAct(togglePassthrough)">
                  <i class="fas fa-arrow-pointer menu-icon" :class="{ 'is-off': !passthroughOn }"></i>
                  <span>{{ passthroughOn ? t('app.toolbar.passthrough') : t('app.toolbar.solid') }}</span>
                </button>
                <button class="menu-item" role="menuitem" @click="menuAct(() => { openSettingsWindow() })">
                  <i class="fas fa-gear menu-icon"></i>
                  <span>{{ t('app.toolbar.settings') }}</span>
                </button>
              </div>
            </Transition>
          </div>
        </div>
        <!-- 窗口 / 画布控制栏 -->
        <div class="toolbar canvas-toolbar" data-pet-solid>
          <button class="tool-btn" type="button" :aria-label="t('app.aria.moveWindow')"
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
            @mousedown.stop.prevent="startWindowDrag"
            @keydown="onMoveWindowKeydown">
            <i class="fas fa-up-down-left-right btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.moveWindow') }}</span>
          </button>
          <button class="tool-btn" type="button" :aria-label="t('app.aria.resizeCharacterCanvas')"
            aria-keyshortcuts="ArrowUp ArrowDown"
            @wheel.prevent.stop="onCanvasHeightWheel"
            @keydown="onCanvasHeightKeydown">
            <i class="fas fa-up-down btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.resizeCanvas') }}</span>
          </button>
          <button class="tool-btn" type="button"
            :aria-label="t('app.aria.adjustCharacterOpacity', { value: characterOpacityPercent })"
            :title="t('app.aria.adjustCharacterOpacity', { value: characterOpacityPercent })"
            aria-keyshortcuts="ArrowUp ArrowDown"
            @wheel.prevent.stop="onCharacterOpacityWheel"
            @keydown="onCharacterOpacityKeydown">
            <i class="fas fa-sun btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.adjustOpacity') }}</span>
          </button>
        </div>


        <!-- 停止生成：与工具栏同一行，出现/消失不改变工具栏位置 -->
        <button v-if="chat.isProcessing" class="stop-btn" data-pet-solid @click="chat.cancelResponse()"
          :aria-label="t('app.aria.stop')">
          <i class="fas fa-stop"></i>
          <span>{{ t('app.stop') }}</span>
        </button>
      </div>

      </template>

      <!-- 点击「更多」菜单外的任意位置关闭菜单 -->
      <template #overlay>
        <div v-if="showMoreMenu" class="menu-backdrop" data-pet-solid @click="closeMoreMenu"></div>
      </template>

      <!-- 输入框常驻轨道底部；收起时随轨道移出窗口裁剪区 -->
      <template #input>
        <InputBox :visible="chat.showInput" :disabled="chat.isProcessing" :draft-key="sessionStore.currentSessionId"
          :valid-draft-keys="sessionStore.sessionList.map(s => s.id)" :submit="handleSend"
          :title="sessionStore.currentSession?.name" @close="chat.closeInput()"
          :context-utilization="chat.contextStats.utilization" :context-detail="contextDetail" />
      </template>
    </ConversationDock>

    <!-- 面板 -->
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
  color: var(--c-text-bright);
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
  padding: var(--space-2) var(--space-5);
  font-size: var(--fs-body);
  border: none;
  border-radius: var(--radius-control);
  background: var(--c-brand);
  color: var(--c-text-bright);
  cursor: pointer;
  transition: opacity 0.15s;
}

.no-char-btn:hover {
  opacity: 0.88;
}

.character-area {
  position: absolute;
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  border: 1px dashed #f00;
}

/* 实体态（可交互）始终显示红色虚线边框作状态指示；穿透态隐藏。
   用 transparent 而非 none，保留 1px 占位避免布局抖动。 */
.character-area.is-passthrough {
  border-color: transparent;
}

/* 内部角色画布：只调整它自己的高度，不改变外层应用窗口尺寸 */
.character-canvas {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
}

.bars {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: stretch;
  /* 工作区条与工具栏等高，垂直居中对齐 */
  justify-content: center;
  gap: 8px;
  margin: 8px 0px;
}

.toolbar {
  display: flex;
  gap: 6px;
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(8px);
  padding: 6px 10px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  /* 高于 menu-backdrop（z:45）：backdrop-filter 使工具栏成为独立堆叠上下文，
     不抬层会让内部 z 更高的菜单整体被遮罩盖住 */
  position: relative;
  z-index: 46;
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

.tool-btn:hover .btn-label,
.tool-btn:focus-visible .btn-label {
  opacity: 1;
}

.tool-btn.active {
  background: rgba(255, 255, 255, 0.14);
}

/* ---- 「更多」菜单 ---- */
.more-wrap {
  position: relative;
  display: flex;
}

.more-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  min-width: 150px;
  padding: 6px;
  background: rgba(20, 20, 35, 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-overlay);
  z-index: 55;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  background: none;
  border: none;
  border-radius: var(--radius-control);
  color: var(--c-text);
  font-size: var(--fs-body);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.menu-item:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.menu-icon {
  width: 16px;
  text-align: center;
  color: var(--c-brand-text);
}

.menu-icon.is-off {
  color: var(--c-text-muted);
}

/* 菜单打开时铺满窗口的透明点击捕获层 */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: transparent;
}

.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* ---- 停止生成 / 配置待办（共用固定高度状态行） ---- */
.status-row {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
}

.stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(210, 60, 60, 0.88);
  color: var(--c-text-bright);
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

@media (max-height: 520px) {
  .bars {
    margin-block: var(--space-1);
  }
}
</style>
