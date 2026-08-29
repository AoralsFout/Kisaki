/**
 * 会话管理状态（Pinia）
 *
 * 功能：
 * - 创建/删除/重命名会话
 * - 在不同会话间切换（自动保存当前会话）
 * - 自动持久化：Tauri 环境写入 Rust 管理的 sessions.json（原子写入），
 *   非 Tauri 环境回退 localStorage；旧数据首次启动自动迁移
 * - 与 ChatStore 协同：切换会话时加载/保存消息
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
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
  /** Rust 原生目录选择器签发的不透明工作目录能力。绝对路径不再作为授权凭据。 */
  workspaceId?: string | null
  /** 回档检查点：每条用户消息一个，记录回合前的视觉状态；hasFiles 标记是否有文件备份 */
  checkpoints?: Checkpoint[]
  createdAt: number
  updatedAt: number
}

/**
 * 回档检查点 —— 对应一次用户消息触发的回合（id = 该用户消息 id）。
 * 文件备份本身存在 Rust 缓存目录（见 src-tauri/src/backup.rs），此处仅存对话/视觉侧元信息。
 */
export interface Checkpoint {
  /** = 触发该回合的用户消息 id */
  id: string
  createdAt: number
  /** 回合开始前的角色 id */
  characterId?: string
  /** 回合开始前的角色视觉状态 */
  visualState?: CharacterVisualState
  /** 本回合是否对文件做过备份（决定回档时是否需要还原文件） */
  hasFiles: boolean
  /** 备份时的工作根（仅记录，实际还原以 Rust manifest 为准） */
  workspaceRoot?: string | null
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

function saveJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (e) {
    // 典型原因：localStorage 配额耗尽（WebView 通常约 10MB）。
    // 不再静默忽略——否则用户会以为历史已保存，重启后才发现丢失。
    log.error('本地存储写入失败（key=%s），数据未能持久化: %s', key, (e as Error)?.message || String(e))
    return false
  }
}

// ─── 文件持久化（Tauri）与 localStorage 回退 ────────────────
// 会话数据（聊天历史、角色状态、检查点）是用户资产且体积可能远超
// localStorage 配额（WebView 约 10MB），故迁移到 Rust 管理的
// sessions.json（原子写入）。浏览器环境（非 Tauri）自动回退 localStorage。

/** true=文件模式；false=localStorage 回退；init 前为 null */
let fileMode: boolean | null = null
/** 文件写入串行队列：保证多次快速保存不会乱序覆盖 */
let fileSaveQueue: Promise<boolean> = Promise.resolve(true)

type FileLoadResult =
  | { ok: true; data: { sessions: Session[]; currentId: string } | null }
  | { ok: false }

async function loadFromFile(): Promise<FileLoadResult> {
  try {
    const raw = await invoke<string | null>('sessions_load')
    if (raw == null) return { ok: true, data: null }
    const parsed = JSON.parse(raw) as { sessions?: Session[]; currentId?: string }
    if (!Array.isArray(parsed.sessions) || typeof parsed.currentId !== 'string') {
      log.warn('会话文件格式异常，按无数据处理（不会覆盖文件直到下次保存）')
      return { ok: true, data: null }
    }
    return { ok: true, data: { sessions: parsed.sessions, currentId: parsed.currentId } }
  } catch (e) {
    log.warn('读取会话文件失败（非 Tauri 环境？），回退 localStorage: %s',
      (e as Error)?.message || String(e))
    return { ok: false }
  }
}

// ─── Store ────────────────────────────────────────────────

export const useSessionStore = defineStore('session', () => {
  // ── 状态 ──
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string>('')
  const ready = ref(false)
  /** 本地存储是否发生写入失败（配额满等）；成功后自动清除 */
  const persistError = ref(false)

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
   * 加载数据并恢复上次会话。
   * 优先读 Rust 管理的会话文件（Tauri），不可用时回退 localStorage；
   * 旧 localStorage 数据会在文件可用时自动迁移（成功后清除旧副本）。
   * 应在 ChatStore 初始化且 system prompt 设定后调用
   */
  async function init() {
    const file = await loadFromFile()
    fileMode = file.ok

    let saved: Session[] = []
    let source: 'file' | 'local' | 'none' = 'none'
    if (file.ok && file.data) {
      saved = file.data.sessions
      source = 'file'
    } else {
      const local = loadJSON<Session[]>(STORAGE_SESSIONS, [])
      if (local.length > 0) {
        saved = local
        source = 'local'
      }
    }

    let toRestore: Session | null = null

    if (saved.length > 0) {
      sessions.value = saved
      // v2 授权迁移：旧会话只有前端路径、没有后端能力，不能静默恢复。
      // 清除旧路径并要求用户通过原生选择器重新授权一次。
      for (const session of sessions.value) {
        if (session.workspaceRoot && !session.workspaceId) {
          session.workspaceRoot = null
        }
      }
      // 恢复上次使用的会话
      const lastId = file.ok && file.data
        ? file.data.currentId
        : loadJSON<string>(STORAGE_CURRENT_SESSION, '')
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

    // 迁移：localStorage 旧数据 → 会话文件（文件写入成功后才清除旧副本，避免丢数据）
    if (source === 'local' && file.ok) {
      const migrated = await persistToFile(sessions.value, currentSessionId.value)
      if (migrated) {
        try {
          localStorage.removeItem(STORAGE_SESSIONS)
          localStorage.removeItem(STORAGE_CURRENT_SESSION)
        } catch { /* ignore */ }
        log.info('会话数据已从 localStorage 迁移到会话文件')
      }
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

  /**
   * 写会话文件（串行队列，保证保存顺序）。返回是否成功。
   * 失败时置 persistError，供 UI 提示用户。
   */
  function persistToFile(sessions: Session[], currentId: string): Promise<boolean> {
    const payload = JSON.stringify({ sessions, currentId })
    const p = fileSaveQueue
      .then(() => invoke('sessions_save', { data: payload }))
      .then(
        () => true,
        (e) => {
          log.error('会话写入磁盘失败，历史可能无法保存: %s', (e as Error)?.message || String(e))
          persistError.value = true
          return false
        },
      )
    fileSaveQueue = p
    return p
  }

  function persistSessions() {
    if (fileMode === true) {
      void persistToFile(sessions.value, currentSessionId.value).then(ok => {
        if (ok) persistError.value = false
      })
      return
    }
    const sessionsOk = saveJSON(STORAGE_SESSIONS, sessions.value)
    const currentOk = saveJSON(STORAGE_CURRENT_SESSION, currentSessionId.value)
    const ok = sessionsOk && currentOk
    persistError.value = !ok
    if (!ok) {
      log.error('本地存储配额可能已满，会话数据未能完整保存；删除旧会话后会自动恢复')
    }
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

    // 清理该会话的文件备份（Rust 缓存目录）
    void invoke('agent_checkpoint_clear_session', { sessionId }).catch(() => { /* ignore */ })

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

  /** 保存由 Rust 原生目录选择器签发的工作目录能力。 */
  function setWorkspace(grant: { id: string; path: string }) {
    const session = currentSession.value
    if (!session) return
    const previousId = session.workspaceId
    session.workspaceId = grant.id
    session.workspaceRoot = grant.path
    session.updatedAt = Date.now()
    persistSessions()
    if (previousId && previousId !== grant.id) {
      void invoke('agent_revoke_workspace', { workspaceId: previousId }).catch(() => { /* ignore */ })
    }
    log.info('已设置会话工作目录: %s', grant.path)
  }

  /** 取消当前会话的工作目录授权 */
  function clearWorkspace() {
    const session = currentSession.value
    if (!session) return
    const workspaceId = session.workspaceId
    session.workspaceId = null
    session.workspaceRoot = null
    session.updatedAt = Date.now()
    persistSessions()
    if (workspaceId) {
      void invoke('agent_revoke_workspace', { workspaceId }).catch((e) => {
        log.warn('撤销工作目录授权失败: %s', (e as Error)?.message || String(e))
      })
    }
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

    // 0. 验证持久化能力仍有效；能力不存在、目录被移走或已撤销时安全清除。
    if (session.workspaceId) {
      try {
        session.workspaceRoot = await invoke<string>('agent_resolve_workspace', {
          workspaceId: session.workspaceId,
        })
      } catch (e) {
        log.warn('恢复工作目录授权失败，需重新选择: %s', (e as Error)?.message || String(e))
        session.workspaceId = null
        session.workspaceRoot = null
        persistSessions()
      }
    }

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

  // ── 回档检查点 ──

  /**
   * 为一次用户消息回合建立检查点：记录回合前的角色与视觉状态。
   * 文件备份在「改文件工具执行前」由 backupFile 按需追加。
   * @returns checkpointId（= 传入的用户消息 id）
   */
  function beginCheckpoint(messageId: string): string {
    const session = currentSession.value
    if (!session) return messageId
    if (!session.checkpoints) session.checkpoints = []
    const charStore = useCharacterStore()
    session.checkpoints.push({
      id: messageId,
      createdAt: Date.now(),
      characterId: charStore.currentId,
      visualState: charStore.getVisualStateSnapshot(),
      hasFiles: false,
      workspaceRoot: session.workspaceRoot ?? null,
    })
    persistSessions()
    return messageId
  }

  /** 标记某检查点已产生文件备份（回档时据此决定是否还原文件） */
  function markCheckpointFiles(checkpointId: string) {
    const cp = currentSession.value?.checkpoints?.find(c => c.id === checkpointId)
    if (cp && !cp.hasFiles) {
      cp.hasFiles = true
      persistSessions()
    }
  }

  /**
   * 在「改文件工具执行前」备份目标文件（写时复制，幂等）。
   * 未授权工作目录则跳过（工具本身随后会报错引导用户）。
   */
  async function backupFile(checkpointId: string, relPath: string): Promise<void> {
    const session = currentSession.value
    const workspaceId = session?.workspaceId
    if (!session || !workspaceId || !relPath) return
    await invoke('agent_checkpoint_backup', {
      sessionId: session.id,
      checkpointId,
      workspaceId,
      relPath,
    })
  }

  /** 清空当前会话的全部检查点与文件备份（清空对话时调用） */
  async function clearCheckpoints(): Promise<void> {
    const session = currentSession.value
    if (!session) return
    session.checkpoints = []
    persistSessions()
    try {
      await invoke('agent_checkpoint_clear_session', { sessionId: session.id })
    } catch { /* ignore */ }
  }

  /** 恢复某检查点记录的角色与视觉状态 */
  async function restoreCharacterCheckpoint(cp: Checkpoint) {
    const charStore = useCharacterStore()
    if (
      cp.characterId &&
      cp.characterId !== charStore.currentId &&
      charStore.availableList.includes(cp.characterId)
    ) {
      try {
        await charStore.loadCharacter(cp.characterId, true)
      } catch (err) {
        log.warn('回档恢复角色失败（保持当前角色）: %s', (err as Error).message)
      }
    }
    if (cp.visualState) charStore.applyVisualState(cp.visualState)
  }

  /**
   * 回档到某条消息：还原工作区文件 + 恢复视觉状态 + 截断该消息及其后的对话。
   * @param messageId 目标用户消息 id（= 检查点 id）
   * @returns 是否成功执行
   */
  async function rollbackTo(messageId: string): Promise<boolean> {
    const session = currentSession.value
    if (!session) return false
    const chatStore = useChatStore()

    // 进行中的生成先取消，避免回调写入将被截断的上下文
    if (chatStore.isProcessing) chatStore.cancelResponse()

    const msgs = chatStore.messages
    const idx = msgs.findIndex(m => m.id === messageId)
    if (idx < 0) {
      log.warn('回档目标消息不存在: %s', messageId)
      return false
    }

    const cps = session.checkpoints ?? []
    // 该点及其后、且有文件备份的检查点，按消息顺序「从新到旧」传给 Rust
    const fileCpIdsNewestFirst = cps
      .map(cp => ({ cp, mi: msgs.findIndex(m => m.id === cp.id) }))
      .filter(x => x.mi >= idx && x.cp.hasFiles)
      .sort((a, b) => b.mi - a.mi)
      .map(x => x.cp.id)

    // 1. 还原文件
    if (fileCpIdsNewestFirst.length > 0) {
      try {
        await invoke('agent_checkpoint_rollback', {
          sessionId: session.id,
          checkpointIds: fileCpIdsNewestFirst,
        })
      } catch (e) {
        log.error('回档还原文件失败: %s', (e as Error).message)
      }
    }

    // 2. 恢复目标检查点的视觉状态 / 角色
    const targetCp = cps.find(c => c.id === messageId)
    if (targetCp) await restoreCharacterCheckpoint(targetCp)

    // 3. 截断对话到目标消息之前，并丢弃 >= 目标的检查点
    const kept = msgs.slice(0, idx)
    session.messages = [...kept]
    session.checkpoints = cps.filter(cp => {
      const mi = msgs.findIndex(m => m.id === cp.id)
      return mi >= 0 && mi < idx
    })
    session.characterId = useCharacterStore().currentId
    session.characterState = useCharacterStore().getVisualStateSnapshot()
    session.updatedAt = Date.now()
    persistSessions()

    // 4. 重建 chat 上下文（loadMessages 会按 say 范式重放消息）
    chatStore.loadMessages(kept)

    log.info('已回档到消息 %s（保留 %d 条，还原 %d 个文件检查点）',
      messageId, kept.length, fileCpIdsNewestFirst.length)
    return true
  }

  return {
    // 状态
    sessions,
    currentSessionId,
    ready,
    persistError,
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
    // 回档检查点
    beginCheckpoint,
    markCheckpointFiles,
    backupFile,
    clearCheckpoints,
    rollbackTo,
  }
})
