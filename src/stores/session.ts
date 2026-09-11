import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import type { ChatContextSnapshot, ChatMessage as ProtocolMessage } from '../ai'
import type { ChatMessage } from './chat'
import { useChatStore } from './chat'
import type { ChatSessionPort } from '../application/conversation/chatSessionPort'
import type { SessionServiceFactory } from '../application/session/sessionServiceAssembly'
import { useCharacterStore, type CharacterVisualState } from './character'
import { DEFAULT_POSE } from '../character/poses'
import type { PoseKey } from '../character/poses'
import type { SessionApplicationService } from '../application/session/sessionApplicationService'
import type {
  CommitAssistantMessage,
  ReviseAssistantMessage,
} from '../application/conversation/assistantMessageCoordinator'
import type {
  CharacterLookSnapshot,
  ConversationSessionSnapshot,
  RecordedToolCall,
  SessionCheckpoint,
} from '../domain/conversation/events'
import { SessionAggregate } from '../domain/conversation/sessionAggregate'
import { createLogger } from '../utils/logger'

const log = createLogger('SessionStore')

/** 仅用于 UI 的投影。真正持久化的只有 ConversationSessionSnapshot。 */
export interface Session {
  id: string
  name: string
  messages: ChatMessage[]
  context: ChatContextSnapshot
  characterId?: string
  characterLocked: boolean
  /** 会话记住的角色外观；加载该会话时恢复，null = 尚未记录 */
  character: CharacterLookSnapshot | null
  workspaceRoot: string | null
  workspaceId: string | null
  checkpoints: SessionCheckpoint[]
  createdAt: number
  updatedAt: number
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 会话服务装配工厂。由组合根在启动时注入。
 *
 * store 不再自己构造仓储适配器、也不再自己决定真机持久化还是内存兜底：
 * 那是装配决策，归属组合根；这里只消费装配结果。
 */
let createSessionService: SessionServiceFactory | null = null

/** 由组合根注入会话服务装配；传 null 恢复「缺装配」状态。 */
export function setSessionServiceFactory(factory: SessionServiceFactory | null): void {
  createSessionService = factory
}

function toProtocolSnapshot(snapshot: ConversationSessionSnapshot): ChatContextSnapshot {
  const aggregate = SessionAggregate.restore(snapshot)
  const messages: ProtocolMessage[] = aggregate.projectModelContext()
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
      tool_calls: message.toolCalls?.map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }))
  const summarized = new Set(snapshot.contextState.summarizedEventIds)
  const summarizedRounds = snapshot.timeline.filter(event => (
    event.type === 'user-message-accepted' && summarized.has(event.eventId)
  )).length
  return {
    version: 1,
    messages,
    rollingSummary: snapshot.contextState.summary ?? '',
    summarizedRounds,
  }
}

function toView(snapshot: ConversationSessionSnapshot, workspaceRoot: string | null): Session {
  const aggregate = SessionAggregate.restore(snapshot)
  const messages: ChatMessage[] = aggregate.projectTranscript().map(message => ({
    id: message.id,
    role: message.role,
    text: message.text,
    voice: message.voice,
    images: message.images,
    timestamp: message.occurredAt,
    charId: message.role === 'assistant' ? snapshot.characterId ?? undefined : undefined,
  }))
  return {
    id: snapshot.id,
    name: snapshot.title,
    messages,
    context: toProtocolSnapshot(snapshot),
    characterId: snapshot.characterId ?? undefined,
    characterLocked: snapshot.characterLocked,
    character: snapshot.character,
    workspaceRoot,
    workspaceId: snapshot.workspaceGrantId,
    checkpoints: snapshot.checkpoints,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const currentSessionId = ref('')
  const ready = ref(false)
  const persistError = ref(false)
  const workspaceRoots = new Map<string, string>()
  let service: SessionApplicationService | null = null
  let initializing: Promise<void> | null = null
  /** true = 正在套用会话/检查点外观，期间的角色变化不写回会话 */
  let restoringCharacter = false

  const currentSession = computed(() => (
    sessions.value.find(session => session.id === currentSessionId.value) ?? null
  ))
  const sessionList = computed(() => [...sessions.value].sort((a, b) => a.createdAt - b.createdAt))
  const canChangeCharacter = computed(() => Boolean(currentSession.value && !currentSession.value.characterLocked))

  function requireService(): SessionApplicationService {
    if (!service) throw new Error('SessionStore is not initialized')
    return service
  }

  function refreshProjection(): void {
    const document = requireService().snapshot()
    currentSessionId.value = document.currentSessionId
    sessions.value = document.sessions.map(snapshot => (
      toView(snapshot, workspaceRoots.get(snapshot.id) ?? null)
    ))
  }

  async function runCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation()
      refreshProjection()
      persistError.value = false
      return result
    } catch (error) {
      persistError.value = true
      log.error('session.command_failed', '会话命令执行失败', error)
      throw error
    }
  }

  async function initializeService(): Promise<void> {
    // 仓储选择（真机持久化 / 内存兜底）由组合根做出，这里只消费装配结果；
    // 缺装配时显式失败，而不是悄悄退回某个默认实现。
    if (!createSessionService) throw new Error('SessionStore 缺少会话服务装配：组合根未注入')
    const assembly = await createSessionService({ now: Date.now, nextId })
    service = assembly.service
    persistError.value = assembly.degraded
  }

  async function resolveWorkspace(snapshot: ConversationSessionSnapshot): Promise<void> {
    if (!snapshot.workspaceGrantId) {
      workspaceRoots.delete(snapshot.id)
      return
    }
    try {
      const path = await invoke<string>('agent_resolve_workspace', {
        workspaceId: snapshot.workspaceGrantId,
      })
      workspaceRoots.set(snapshot.id, path)
    } catch (error) {
      workspaceRoots.delete(snapshot.id)
      log.warn('session.workspace_grant_expired', '工作目录授权已失效，需要重新选择', error, {
        session_id: snapshot.id,
      })
      await runCommand(() => requireService().setWorkspaceGrant(snapshot.id, null))
    }
  }

  /**
   * 旧版会话没有记录外观：退回最近一次检查点记下的外观，
   * 总比把用户设置的情绪/位置直接丢掉更接近原状。
   */
  function latestCheckpointLook(session: Session): CharacterLookSnapshot | null {
    for (let index = session.checkpoints.length - 1; index >= 0; index -= 1) {
      const character = session.checkpoints[index].character
      if (character) return character
    }
    return null
  }

  function sameLook(left: CharacterLookSnapshot | null, right: CharacterLookSnapshot): boolean {
    return left !== null
      && left.emotion === right.emotion
      && left.stance === right.stance
      && left.costume === right.costume
      && left.screenPose === right.screenPose
  }

  /**
   * 把当前角色外观写回指定会话（默认当前会话）。外观变化时由 watch 触发，
   * 因此「设置后不切会话就关窗」也不会丢。
   */
  async function persistCharacterState(sessionId = currentSessionId.value): Promise<void> {
    const charStore = useCharacterStore()
    // 恢复过程中角色会先被重置再套用会话外观，中间的过渡值不能写回会话。
    if (restoringCharacter || !service || !charStore.data) return
    const session = sessions.value.find(candidate => candidate.id === sessionId)
    if (!session) return
    const look = charStore.getVisualStateSnapshot()
    if (sameLook(session.character, look)) return
    try {
      await runCommand(() => requireService().setCharacterState(sessionId, look))
    } catch {
      // runCommand 已记录持久化失败并置 persistError，外观本身仍然生效。
    }
  }

  async function restoreCharacter(session: Session, checkpoint?: SessionCheckpoint | null): Promise<void> {
    const charStore = useCharacterStore()
    const checkpointCharacter = checkpoint?.character ?? null
    const characterId = checkpointCharacter?.characterId ?? session.characterId
    restoringCharacter = true
    try {
      if (
        characterId
        && characterId !== charStore.currentId
        && charStore.availableList.includes(characterId)
      ) {
        try {
          await charStore.loadCharacter(characterId, true)
        } catch (error) {
          log.warn('session.character_restore_failed', '恢复会话角色失败，保持当前角色', error)
        }
      }
      // 优先级：回档检查点 > 会话记住的外观 > 旧会话的最近检查点 > 角色默认。
      const look = checkpointCharacter ?? session.character ?? latestCheckpointLook(session)
      if (look) {
        charStore.applyVisualState({
          emotion: look.emotion,
          stance: look.stance,
          costume: look.costume,
          screenPose: look.screenPose as PoseKey,
        } as CharacterVisualState)
        return
      }
      const data = charStore.data
      if (data) {
        charStore.applyVisualState({
          emotion: data.emotions[0] ?? '',
          stance: data.poses[0] ?? '',
          costume: data.costumes[0] ?? '',
          screenPose: DEFAULT_POSE,
        })
      }
    } finally {
      restoringCharacter = false
    }
  }

  // 外观一变就写回当前会话，这样切走、切回甚至直接关窗都不会丢状态。
  const charStore = useCharacterStore()
  watch(
    () => [
      charStore.currentId,
      charStore.currentEmotion,
      charStore.currentStance,
      charStore.currentCostume,
      charStore.currentScreenPose,
    ],
    () => { void persistCharacterState() },
  )

  function loadCurrentChat(): void {
    const session = currentSession.value
    useChatStore().loadMessages(session?.messages ?? [], session?.context ?? null)
  }

  async function init(): Promise<void> {
    if (ready.value) return
    if (initializing) return initializing
    initializing = (async () => {
      await initializeService()
      const document = requireService().snapshot()
      await Promise.all(document.sessions.map(resolveWorkspace))
      refreshProjection()
      loadCurrentChat()
      if (currentSession.value) await restoreCharacter(currentSession.value)
      ready.value = true
      log.info('session.initialized', 'v2 会话已初始化', { session_count: sessions.value.length })
    })().finally(() => { initializing = null })
    return initializing
  }

  function nextSessionName(): string {
    const pattern = /^新对话(?:\s*(\d+))?$/
    let next = 2
    for (const session of sessions.value) {
      const match = session.name.match(pattern)
      if (!match) continue
      next = Math.max(next, (match[1] ? Number(match[1]) : 1) + 1)
    }
    return `新对话 ${next}`
  }

  async function createSession(name?: string): Promise<Session> {
    await persistCharacterState()
    const created = await runCommand(() => requireService().create({
      title: name?.trim() || nextSessionName(),
      characterId: useCharacterStore().currentId,
    }))
    loadCurrentChat()
    if (currentSession.value) await restoreCharacter(currentSession.value)
    return sessions.value.find(session => session.id === created.id)!
  }

  async function switchSession(sessionId: string): Promise<boolean> {
    if (sessionId === currentSessionId.value) return true
    const target = sessions.value.find(session => session.id === sessionId)
    if (!target) return false
    const previousId = currentSessionId.value
    // 先把当前外观落回原会话，再切：切换过程中 currentSession 已指向目标会话。
    await persistCharacterState(previousId)
    currentSessionId.value = sessionId
    useChatStore().loadMessages(target.messages, target.context)
    try {
      await runCommand(() => requireService().switchTo(sessionId))
      if (currentSession.value) await restoreCharacter(currentSession.value)
      return true
    } catch {
      currentSessionId.value = previousId
      loadCurrentChat()
      return false
    }
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    if (sessions.value.length <= 1 || !sessions.value.some(session => session.id === sessionId)) return false
    const wasCurrent = sessionId === currentSessionId.value
    try {
      await runCommand(() => requireService().delete(sessionId))
    } catch {
      return false
    }
    workspaceRoots.delete(sessionId)
    void invoke('agent_checkpoint_clear_session', { sessionId }).catch(() => {})
    if (wasCurrent) {
      loadCurrentChat()
      if (currentSession.value) await restoreCharacter(currentSession.value)
    }
    return true
  }

  async function renameSession(sessionId: string, newName: string): Promise<boolean> {
    const name = newName.trim()
    if (!name || !sessions.value.some(session => session.id === sessionId)) return false
    try {
      await runCommand(() => requireService().rename(sessionId, name))
      return true
    } catch {
      return false
    }
  }

  function getSessionById(sessionId: string): Session | undefined {
    return sessions.value.find(session => session.id === sessionId)
  }

  async function bindCurrentCharacter(): Promise<void> {
    const sessionId = currentSessionId.value
    if (!sessionId) return
    await runCommand(() => requireService().bindCharacter(sessionId, useCharacterStore().currentId))
    // 换角色会清空会话记录的外观（旧标签对新角色无意义），随后写回新角色的。
    await persistCharacterState(sessionId)
  }

  async function setWorkspace(grant: { id: string; path: string }): Promise<void> {
    const session = currentSession.value
    if (!session) return
    const previousId = session.workspaceId
    await runCommand(() => requireService().setWorkspaceGrant(session.id, grant.id))
    workspaceRoots.set(session.id, grant.path)
    refreshProjection()
    if (previousId && previousId !== grant.id) {
      void invoke('agent_revoke_workspace', { workspaceId: previousId }).catch(() => {})
    }
  }

  async function clearWorkspace(): Promise<void> {
    const session = currentSession.value
    if (!session) return
    const workspaceId = session.workspaceId
    await runCommand(() => requireService().setWorkspaceGrant(session.id, null))
    workspaceRoots.delete(session.id)
    refreshProjection()
    if (workspaceId) void invoke('agent_revoke_workspace', { workspaceId }).catch(() => {})
  }

  async function acceptUserMessage(message: {
    sessionId: string
    messageId: string
    text: string
    images: Array<{ id: string; name: string; mimeType: string; size: number; dataUrl: string }>
  }): Promise<boolean> {
    const { sessionId, ...accepted } = message
    if (sessionId !== currentSessionId.value) return false
    try {
      await runCommand(() => requireService().acceptUserMessage(
        sessionId,
        accepted,
        useCharacterStore().currentId || null,
      ))
      return currentSessionId.value === sessionId
    } catch {
      return false
    }
  }

  async function beginCheckpoint(sessionId: string, messageId: string): Promise<string> {
    if (sessionId !== currentSessionId.value) throw new Error('Cannot checkpoint a stale session')
    const charStore = useCharacterStore()
    const look = charStore.getVisualStateSnapshot()
    await runCommand(() => requireService().addCheckpoint(sessionId, {
      id: messageId,
      userMessageId: messageId,
      createdAt: Date.now(),
      hasWorkspaceChanges: false,
      character: {
        characterId: charStore.currentId || null,
        emotion: look.emotion,
        stance: look.stance,
        costume: look.costume,
        screenPose: look.screenPose,
      },
    }))
    return messageId
  }

  async function backupFile(sessionId: string, checkpointId: string, relPath: string): Promise<void> {
    const session = currentSession.value
    if (!session?.workspaceId || session.id !== sessionId || !relPath) return
    await invoke('agent_checkpoint_backup', {
      sessionId: session.id,
      checkpointId,
      workspaceId: session.workspaceId,
      relPath,
    })
  }

  async function markCheckpointFiles(sessionId: string, checkpointId: string): Promise<void> {
    if (sessionId !== currentSessionId.value) return
    await runCommand(() => requireService().markCheckpointWorkspaceChanges(
      sessionId,
      checkpointId,
    ))
  }

  async function recordToolCalls(step: {
    sessionId: string
    stepId: string
    calls: RecordedToolCall[]
    visibleText?: string
  }): Promise<boolean> {
    const { sessionId, ...recorded } = step
    if (sessionId !== currentSessionId.value) return false
    try {
      await runCommand(() => requireService().recordToolCalls(sessionId, recorded))
      return currentSessionId.value === sessionId
    } catch {
      return false
    }
  }

  async function recordToolResult(result: {
    sessionId: string
    callId: string
    content: string
    status: 'succeeded' | 'failed' | 'rejected'
    code?: string
  }): Promise<boolean> {
    const { sessionId, ...recorded } = result
    if (sessionId !== currentSessionId.value) return false
    try {
      await runCommand(() => requireService().recordToolResult(sessionId, recorded))
      return currentSessionId.value === sessionId
    } catch {
      return false
    }
  }

  async function commitAssistantMessage(message: CommitAssistantMessage): Promise<string | null> {
    if (message.sessionId !== currentSessionId.value) return null
    const messageId = nextId()
    try {
      await runCommand(() => requireService().commitAssistantMessage(message.sessionId, {
        messageId,
        display: message.display,
        voice: message.voice,
        source: message.source,
      }))
      return message.sessionId === currentSessionId.value ? messageId : null
    } catch {
      return null
    }
  }

  async function reviseAssistantMessage(message: ReviseAssistantMessage): Promise<boolean> {
    if (message.sessionId !== currentSessionId.value) return false
    try {
      await runCommand(() => requireService().reviseAssistantMessage(message.sessionId, {
        messageId: message.messageId,
        display: message.display,
        voice: message.voice,
      }))
      return message.sessionId === currentSessionId.value
    } catch {
      return false
    }
  }

  async function clearConversation(sessionId: string): Promise<void> {
    if (sessionId !== currentSessionId.value) return
    try {
      await runCommand(() => requireService().clearConversation(sessionId))
      await invoke('agent_checkpoint_clear_session', { sessionId }).catch(() => {})
    } catch { /* 投影层已暴露持久化错误 */ }
  }

  async function rollbackTo(messageId: string): Promise<boolean> {
    const session = currentSession.value
    if (!session || !session.messages.some(message => message.id === messageId && message.role === 'user')) return false
    const chatStore = useChatStore()
    if (chatStore.isProcessing) chatStore.cancelResponse()
    let result
    try {
      result = await runCommand(() => requireService().rollbackToUserMessage(session.id, messageId))
    } catch {
      return false
    }
    if (result.workspaceCheckpointIdsNewestFirst.length > 0) {
      try {
        await invoke('agent_checkpoint_rollback', {
          sessionId: session.id,
          checkpointIds: result.workspaceCheckpointIdsNewestFirst,
        })
      } catch (error) {
        log.error('session.rollback_files_failed', '回档已提交，但工作区文件恢复失败', error)
      }
    }
    if (currentSession.value) await restoreCharacter(currentSession.value, result.targetCheckpoint)
    loadCurrentChat()
    return true
  }

  /**
   * 把本 store 的会话命令暴露为 ChatSessionPort。
   *
   * 这里只提供端口工厂，不自己注入：谁在什么时机把它接到 ChatStore 上由组合根决定
   * （见 SessionStoreChatSessionPort）。端口读取的都是 ref 现值，解析时机不影响行为。
   */
  function createChatSessionPort(): ChatSessionPort {
    return {
      currentSessionId: () => currentSessionId.value,
      workspaceGrantId: () => currentSession.value?.workspaceId ?? null,
      acceptUserMessage,
      recordToolCalls,
      recordToolResult,
      commitAssistantMessage,
      reviseAssistantMessage,
      beginCheckpoint,
      backupFile,
      markCheckpointFiles,
      clearConversation,
    }
  }

  return {
    sessions,
    currentSessionId,
    ready,
    persistError,
    currentSession,
    sessionList,
    canChangeCharacter,
    createChatSessionPort,
    init,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    getSessionById,
    bindCurrentCharacter,
    setWorkspace,
    clearWorkspace,
    rollbackTo,
  }
})
