<script setup lang="ts">
/**
 * 桌宠 - 主应用组件
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Character from './components/Character.vue'
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
import { useChatStore, setChatCharacterIdentity } from './stores/chat'
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
  WINDOW_SETTINGS,
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
import { initPassthrough, setPassthroughEnabled, isPassthroughEnabled } from './passthrough'
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

// 聊天 = 对话框从底部弹出 + 历史对话向上展开到全高（两者由 chat.showInput 驱动）
const showSession = ref(false)
const showCharacterSelect = ref(false)
const ttsEnabled = ref(isTtsEnabled())

/** 打开对话框（历史随对话框展开）；会话/换角色等其它浮层互斥关闭 */
function openChat() {
  if (noCharacter.value) {
    openSettingsWindow('character')
    return
  }
  chat.openInput()
  showSession.value = false
  showCharacterSelect.value = false
}

// ── 「更多」菜单：语音、穿透、会话、设置收敛于此（日志入口在 设置 → 诊断） ──
const showMoreMenu = ref(false)

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value
}

function closeMoreMenu() {
  showMoreMenu.value = false
}

/** 「更多」菜单项动作：先收起菜单再执行 */
function menuAct(action: () => void) {
  closeMoreMenu()
  action()
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

// ── 聊天展示 ──
/** 上下文预算悬浮详情（输入框底栏圆环用） */
const contextDetail = computed(() => t('chat.history.contextDetail', {
  used: chat.contextStats.estimatedTokens,
  max: chat.contextStats.maxContextTokens,
  tools: chat.contextStats.toolDefinitionTokens,
  pruned: chat.contextStats.prunedMessages,
}))

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
  // 注入角色身份来源：assistant 消息落库时记录 { id, name } 快照
  setChatCharacterIdentity(() => (charStore.data ? { id: charStore.currentId, name: charStore.name } : null))
  // 注入“AI 自助切换角色后刷新人格”回调（switch_character 工具会调用）
  setOnCharacterSwitched(applyCharacterPersona)

  // 初始化会话管理（system prompt 设定后加载历史消息）
  await sessionStore.init()

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
  openChat()
}

async function handleSend(payload: ChatInputPayload): Promise<boolean> {
  if (noCharacter.value || chat.isProcessing) return false
  if (charStore.render === 'illustration' && !getCharacterController()) return false
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
    <!-- 边框跟随穿透模式（而非光标瞬时命中）：实体态常显作状态指示，穿透态始终隐藏 -->
    <div class="character-area" :class="{ 'is-passthrough': passthroughOn }">
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

      <!-- 历史对话：常驻底部；折叠时显示最新一条，对话框弹出时展开到全高 -->
      <ChatHistory visible />

      <!-- 状态行：配置待办；无内容时不渲染，出现时不推动工具栏位置 -->
      <div v-if="showConfigTodo" class="status-row" data-pet-solid>
        <button class="stop-btn config-todo" @click="showOnboarding = true"
          :aria-label="t('app.aria.configTodo')">
          <i class="fas fa-clipboard-check"></i>
          <span>{{ t('app.configTodo') }}</span>
        </button>
      </div>

      <div class="bars">
        <!-- 工作区条（AI 文件读写目录，按会话独立） -->
        <WorkspaceChip v-if="!noCharacter" />

        <!-- 陪伴状态工具栏：聊天 / 会话 / 更多（换角色、语音、穿透、设置收敛进更多；日志入口在 设置 → 诊断） -->
        <div class="toolbar" data-pet-solid>
          <button class="tool-btn" :disabled="noCharacter" @click="openChat"
            :aria-label="t('app.aria.chatInput')">
            <i class="fas fa-comment btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.chat') }}</span>
          </button>
          <button class="tool-btn" :disabled="chat.isProcessing || noCharacter"
            @click="showSession = !showSession" :aria-label="t('app.toolbar.session')">
            <i class="fas fa-comments btn-icon"></i>
            <span class="btn-label">{{ t('app.toolbar.session') }}</span>
          </button>
          <div class="more-wrap">
            <button class="tool-btn" :class="{ active: showMoreMenu }" @click="toggleMoreMenu"
              :aria-expanded="showMoreMenu" aria-haspopup="menu" :aria-label="t('app.aria.more')">
              <i class="fas fa-ellipsis btn-icon"></i>
              <span class="btn-label">{{ t('app.toolbar.more') }}</span>
            </button>
            <Transition name="menu-fade">
              <div v-if="showMoreMenu" class="more-menu" role="menu" data-pet-solid>
                <button class="menu-item" role="menuitem" :disabled="chat.isProcessing || noCharacter"
                  @click="menuAct(() => { showCharacterSelect = true })">
                  <i class="fas fa-rotate menu-icon"></i>
                  <span>{{ t('app.toolbar.character') }}</span>
                </button>
                <button class="menu-item" role="menuitem" @click="menuAct(toggleTts)">
                  <i class="fas fa-volume-high menu-icon" :class="{ 'is-off': !ttsEnabled }"></i>
                  <span>{{ ttsEnabled ? t('app.toolbar.voice') : t('app.toolbar.mute') }}</span>
                </button>
                <button class="menu-item" role="menuitem" @click="menuAct(togglePassthrough)">
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

        <!-- 停止生成：与工具栏同一行，出现/消失不改变工具栏位置 -->
        <button v-if="chat.isProcessing" class="stop-btn" data-pet-solid @click="chat.cancelResponse()"
          :aria-label="t('app.aria.stop')">
          <i class="fas fa-stop"></i>
          <span>{{ t('app.stop') }}</span>
        </button>
      </div>

      <!-- 点击「更多」菜单外的任意位置关闭菜单 -->
      <div v-if="showMoreMenu" class="menu-backdrop" data-pet-solid @click="closeMoreMenu"></div>

      <!-- 输入框：从底部弹出/收起（历史对话随其展开） -->
      <div class="input-wrapper" :class="{ open: chat.showInput }">
        <InputBox :visible="chat.showInput" :disabled="chat.isProcessing" :draft-key="sessionStore.currentSessionId"
          :valid-draft-keys="sessionStore.sessionList.map(s => s.id)" :submit="handleSend"
          :title="sessionStore.currentSession?.name" @close="chat.closeInput()"
          :context-utilization="chat.contextStats.utilization"
          :context-detail="contextDetail" />
      </div>
    </div>

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
    background: var(--c-text-muted);
  }
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

/* ---- 输入框弹出/收起动画（从底部缓慢展开） ---- */
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

/* ---- 底部交互区 ---- */
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
  display: flex;
  flex-direction: row;
  align-items: stretch; /* 工作区条与工具栏等高，垂直居中对齐 */
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

.tool-btn:hover .btn-label {
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
</style>
