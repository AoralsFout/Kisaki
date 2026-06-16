/**
 * 会话管理状态（Pinia）
 *
 * 功能：
 * - 创建/删除/重命名会话
 * - 在不同会话间切换（自动保存当前会话）
 * - 自动持久化到 localStorage，下次启动自动恢复
 * - 与 ChatStore 协同：切换会话时加载/保存消息
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useChatStore } from './chat'
import type { ChatMessage } from './chat'
import { useCharacterStore } from './character'
import type { CharacterVisualState } from './character'
import { DEFAULT_POSE } from '../character/poses'
import { createLogger } from '../utils/logger'
import {
  STORAGE_SESSIONS,
  STORAGE_CURRENT_SESSION,
} from '../constants'

const log = createLogger('SessionStore')

// ─── 类型定义 ─────────────────────────────────────────────

export interface Session {
  id: string
  name: string
  messages: ChatMessage[]
  /** 会话关联的角色 ID（切回会话时自动切到该角色） */
  characterId?: string
  /** 会话关联的角色视觉状态（情绪/姿势/服装/屏幕位置） */
  characterState?: CharacterVisualState
  /** 本会话授权给 AI 读写的工作目录绝对路径；null/undefined = 未授权 */
  workspaceRoot?: string | null
  createdAt: number
  updatedAt: number
}

// ─── 工具函数 ─────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return fallback
}

function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* ignore */ }
}

// ─── Store ────────────────────────────────────────────────

export const useSessionStore = defineStore('session', () => {
  // ── 状态 ──
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string>('')
  const ready = ref(false)

  // ── 计算属性 ──
  const currentSession = computed(() =>
    sessions.value.find(s => s.id === currentSessionId.value) ?? null,
  )

  /** 会话列表，按创建时间正序（旧→新） */
  const sessionList = computed(() =>
    [...sessions.value].sort((a, b) => a.createdAt - b.createdAt),
  )

  // ── 初始化 ──

  /**
   * 从 localStorage 加载数据并恢复上次会话
   * 应在 ChatStore 初始化且 system prompt 设定后调用
   */
  async function init() {
    const saved = loadJSON<Session[]>(STORAGE_SESSIONS, [])
    let toRestore: Session | null = null

    if (saved.length > 0) {
      sessions.value = saved
      // 恢复上次使用的会话
      const lastId = loadJSON<string>(STORAGE_CURRENT_SESSION, '')
      if (lastId && sessions.value.some(s => s.id === lastId)) {
        currentSessionId.value = lastId
      } else {
        // 默认选最新的
        currentSessionId.value = sessions.value.reduce((a, b) =>
          a.updatedAt > b.updatedAt ? a : b,
        ).id
      }

      // 将当前会话的消息和角色状态加载到对应的 Store
      const curr = currentSession.value
      if (curr) {
        const chatStore = useChatStore()
        if (curr.messages.length > 0) {
          chatStore.loadMessages(curr.messages)
        }
        toRestore = curr
      }
    } else {
      // 首次使用：创建默认会话
      const now = Date.now()
      const defaultSession: Session = {
        id: generateId(),
        name: '新对话',
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      sessions.value = [defaultSession]
      currentSessionId.value = defaultSession.id
      persistSessions()
    }

    ready.value = true
    log.info(
      '初始化完成: %d 个会话, 当前="%s"',
      sessions.value.length,
      currentSession.value?.name ?? '无',
    )

    // 恢复当前会话绑定的角色与视觉状态（可能异步切角色，不阻塞 ready）
    if (toRestore) await restoreSessionState(toRestore)
  }

  // ── 持久化 ──

  function persistSessions() {
    saveJSON(STORAGE_SESSIONS, sessions.value)
    saveJSON(STORAGE_CURRENT_SESSION, currentSessionId.value)
  }

  // ── 会话操作 ──

  /**
   * 创建新会话并立即切换到它
   * @param name 会话名称，留空自动生成 "新对话 N"
   */
  function createSession(name?: string): Session {
    const count = sessions.value.length + 1
    const charStore = useCharacterStore()
    const session: Session = {
      id: generateId(),
      name: name || `新对话 ${count}`,
      messages: [],
      characterId: charStore.currentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.push(session)
    persistSessions()
    // 立即切换到新会话（角色状态会自动重置为默认）
    switchSession(session.id)
    log.info('已创建并切换到会话: "%s"', session.name)
    return session
  }

  /**
   * 切换到指定会话
   * 自动保存当前会话 → 加载目标会话的消息到 ChatStore
   */
  async function switchSession(sessionId: string) {
    if (sessionId === currentSessionId.value) return
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) {
      log.warn('目标会话不存在: %s', sessionId)
      return
    }

    // 保存当前会话
    saveCurrentSession()

    // 切换 ID（同步更新，UI 立即反映）
    currentSessionId.value = target.id
    persistSessions()

    // 加载目标会话消息（同步）
    const chatStore = useChatStore()
    chatStore.loadMessages(target.messages)
    // 恢复目标会话的角色与视觉状态（可能异步切角色）
    await restoreSessionState(target)

    log.info('已切换到会话: "%s" (%d 条消息)', target.name, target.messages.length)
  }

  /**
   * 将 ChatStore 当前消息和角色视觉状态保存到当前会话
   */
  function saveCurrentSession() {
    const session = currentSession.value
    if (!session) return

    const chatStore = useChatStore()
    session.messages = [...chatStore.messages]
    // 保存角色身份与当前视觉状态
    const charStore = useCharacterStore()
    session.characterId = charStore.currentId
    session.characterState = charStore.getVisualStateSnapshot()
    session.updatedAt = Date.now()
    persistSessions()
  }

  /**
   * 删除会话（至少保留一个）
   * @returns 删除是否成功
   */
  function deleteSession(sessionId: string): boolean {
    if (sessions.value.length <= 1) {
      log.warn('至少需要保留一个会话')
      return false
    }
    const idx = sessions.value.findIndex(s => s.id === sessionId)
    if (idx === -1) return false

    const isCurrent = sessionId === currentSessionId.value
    sessions.value.splice(idx, 1)

    if (isCurrent) {
      // 切换到最近更新的会话
      const next = sessions.value.reduce((a, b) =>
        a.updatedAt > b.updatedAt ? a : b,
      )
      currentSessionId.value = next.id
      const chatStore = useChatStore()
      chatStore.loadMessages(next.messages)
      // 恢复角色/视觉状态（可能异步切角色，fire-and-forget）
      void restoreSessionState(next)
    }

    persistSessions()
    log.info('已删除会话')
    return true
  }

  /**
   * 重命名会话
   * @returns 重命名是否成功
   */
  function renameSession(sessionId: string, newName: string): boolean {
    const name = newName.trim()
    if (!name) return false
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return false
    session.name = name
    session.updatedAt = Date.now()
    persistSessions()
    return true
  }

  function getSessionById(sessionId: string): Session | undefined {
    return sessions.value.find(s => s.id === sessionId)
  }

  // ── AI 工作目录 ──

  /** 为当前会话设置 AI 工作目录（绝对路径） */
  function setWorkspace(path: string) {
    const session = currentSession.value
    if (!session) return
    session.workspaceRoot = path
    session.updatedAt = Date.now()
    persistSessions()
    log.info('已设置会话工作目录: %s', path)
  }

  /** 取消当前会话的工作目录授权 */
  function clearWorkspace() {
    const session = currentSession.value
    if (!session) return
    session.workspaceRoot = null
    session.updatedAt = Date.now()
    persistSessions()
    log.info('已取消会话工作目录授权')
  }

  // ── 角色状态恢复 ──

  /**
   * 恢复会话关联的角色与视觉状态。
   * 1. 若会话绑定了不同的角色（characterId），先切到该角色（异步加载）。
   * 2. 应用保存的视觉状态；无则重置为该角色默认值。
   *
   * characterStore 变更后，controller 的 watch 会自动同步立绘和位置；
   * App.vue 监听 currentId 变化刷新人设（system prompt）。
   */
  async function restoreSessionState(session: Session) {
    const charStore = useCharacterStore()

    // 1. 切换到会话绑定的角色（若不同且存在）
    if (
      session.characterId &&
      session.characterId !== charStore.currentId &&
      charStore.availableList.includes(session.characterId)
    ) {
      try {
        await charStore.loadCharacter(session.characterId, true)
      } catch (err) {
        log.warn('恢复会话角色失败（保持当前角色）: %s', (err as Error).message)
      }
    }

    // 2. 恢复视觉状态
    if (!session.characterState) {
      // 新/空会话 → 重置为角色默认状态（首项标签 + 居中全屏）
      const d = charStore.data
      if (d) {
        charStore.applyVisualState({
          emotion: d.emotions[0] ?? '',
          stance: d.poses[0] ?? '',
          costume: d.costumes[0] ?? '',
          screenPose: DEFAULT_POSE,
        })
      }
      return
    }
    charStore.applyVisualState(session.characterState)
  }

  return {
    // 状态
    sessions,
    currentSessionId,
    ready,
    // 计算
    currentSession,
    sessionList,
    // 方法
    init,
    createSession,
    switchSession,
    saveCurrentSession,
    deleteSession,
    renameSession,
    getSessionById,
    setWorkspace,
    clearWorkspace,
  }
})
