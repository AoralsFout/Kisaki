import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import type { ChatContextSnapshot, ChatMessage as ProtocolMessage } from '../ai'
import type { ChatMessage } from './chat'
import { setChatSessionPort, useChatStore } from './chat'
import { useCharacterStore, type CharacterVisualState } from './character'
import { DEFAULT_POSE } from '../character/poses'
import { SessionApplicationService } from '../application/session/sessionApplicationService'
import type {
  CommitAssistantMessage,
  ReviseAssistantMessage,
} from '../application/conversation/assistantMessageCoordinator'
import type {
  ConversationSessionSnapshot,
  RecordedToolCall,
  SessionCheckpoint,
} from '../domain/conversation/events'
import { SessionAggregate } from '../domain/conversation/sessionAggregate'
import { TauriSessionRepository } from '../infrastructure/session/tauriSessionRepository'
import { MemorySessionRepository } from '../infrastructure/session/memorySessionRepository'
import { createLogger } from '../utils/logger'

const log = createLogger('SessionStore')

/** UI-only projection. Only ConversationSessionSnapshot is persisted. */
export interface Session {
  id: string
  name: string
  messages: ChatMessage[]
  context: ChatContextSnapshot
  characterId?: string
  characterLocked: boolean
  workspaceRoot: string | null
  workspaceId: string | null
  checkpoints: SessionCheckpoint[]
  createdAt: number
  updatedAt: number
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
    service = new SessionApplicationService({
      repository: new TauriSessionRepository(),
      now: Date.now,
      nextId,
    })
    try {
      await service.initialize('新对话')
    } catch (error) {
      // Browser previews have no Tauri command channel. Keep a volatile v2 document;
      // never read or rewrite the legacy session formats.
      log.warn('session.persistence_unavailable', '会话文件接口不可用，使用内存会话', error)
      persistError.value = true
      service = new SessionApplicationService({
        repository: new MemorySessionRepository(),
        now: Date.now,
        nextId,
      })
      await service.initialize('新对话')
    }
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

  async function restoreCharacter(session: Session, checkpoint?: SessionCheckpoint | null): Promise<void> {
    const charStore = useCharacterStore()
    const checkpointCharacter = checkpoint?.character ?? null
    const characterId = checkpointCharacter?.characterId ?? session.characterId
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
    if (checkpointCharacter) {
      charStore.applyVisualState({
        emotion: checkpointCharacter.emotion,
        stance: checkpointCharacter.stance,
        costume: checkpointCharacter.costume,
        screenPose: checkpointCharacter.screenPose,
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
  }

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
    } catch { /* projection already exposes the persistence error */ }
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

  setChatSessionPort({
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
  })

  return {
    sessions,
    currentSessionId,
    ready,
    persistError,
    currentSession,
    sessionList,
    canChangeCharacter,
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
