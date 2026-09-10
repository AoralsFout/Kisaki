import type {
  AssistantMessageCommitted,
  ConversationImage,
  ConversationSessionSnapshot,
  RecordedToolCall,
  SessionCheckpoint,
  SessionDocument,
  ToolExecutionCompleted,
} from '../../domain/conversation/events'
import {
  SessionAggregate,
  type EventIdentity,
  type SessionRollbackResult,
} from '../../domain/conversation/sessionAggregate'
import { SessionCollection } from '../../domain/conversation/sessionCollection'
import type { SessionRepository } from './sessionRepository'

export interface SessionApplicationDependencies {
  repository: SessionRepository
  now: () => number
  nextId: () => string
}

export interface CreateSessionCommand {
  title: string
  characterId?: string | null
  workspaceGrantId?: string | null
}

/**
 * Coordinates session-list commands and persistence.
 * Presentation code observes snapshots; it never mutates aggregates directly.
 */
export class SessionApplicationService {
  private collection: SessionCollection | null = null
  private commandTail: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: SessionApplicationDependencies) {}

  async initialize(defaultTitle: string): Promise<SessionDocument> {
    const saved = await this.dependencies.repository.load()
    if (saved) {
      this.collection = SessionCollection.restore(saved)
      return this.snapshot()
    }

    const session = SessionAggregate.create({
      id: this.dependencies.nextId(),
      title: defaultTitle,
      now: this.dependencies.now(),
    })
    this.collection = SessionCollection.create(session)
    try {
      await this.persist()
    } catch (error) {
      this.collection = null
      throw error
    }
    return this.snapshot()
  }

  snapshot(): SessionDocument {
    return this.requireCollection().snapshot()
  }

  current(): ConversationSessionSnapshot {
    return this.requireCollection().current().snapshot()
  }

  async create(command: CreateSessionCommand): Promise<ConversationSessionSnapshot> {
    const session = SessionAggregate.create({
      id: this.dependencies.nextId(),
      title: command.title,
      characterId: command.characterId,
      workspaceGrantId: command.workspaceGrantId,
      now: this.dependencies.now(),
    })
    return this.commit(() => {
      this.requireCollection().add(session)
      return session.snapshot()
    })
  }

  async switchTo(sessionId: string): Promise<ConversationSessionSnapshot> {
    return this.commit(() => {
      this.requireCollection().switchTo(sessionId)
      return this.current()
    })
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).rename(title, this.dependencies.now())
    })
  }

  async delete(sessionId: string): Promise<ConversationSessionSnapshot> {
    return this.commit(() => {
      this.requireCollection().delete(sessionId)
      return this.current()
    })
  }

  async bindCharacter(sessionId: string, characterId: string | null): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).bindCharacter(characterId, this.dependencies.now())
    })
  }

  async setWorkspaceGrant(sessionId: string, workspaceGrantId: string | null): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).setWorkspaceGrant(workspaceGrantId, this.dependencies.now())
    })
  }

  async acceptUserMessage(
    sessionId: string,
    message: { messageId: string; text: string; images?: ConversationImage[] },
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).acceptUserMessage(this.eventIdentity(), message)
    })
  }

  async recordToolCalls(
    sessionId: string,
    step: { stepId: string; calls: RecordedToolCall[]; visibleText?: string },
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).recordToolCalls(this.eventIdentity(), step)
    })
  }

  async recordToolResult(
    sessionId: string,
    result: Omit<ToolExecutionCompleted, keyof EventIdentity | 'type'>,
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).recordToolResult(this.eventIdentity(), result)
    })
  }

  async commitAssistantMessage(
    sessionId: string,
    message: Omit<AssistantMessageCommitted, keyof EventIdentity | 'type'>,
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).commitAssistantMessage(this.eventIdentity(), message)
    })
  }

  async reviseAssistantMessage(
    sessionId: string,
    revision: { messageId: string; display?: string; voice?: string },
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).reviseAssistantMessage(this.eventIdentity(), revision)
    })
  }

  async compactContext(
    sessionId: string,
    compaction: { summary: string; summarizedEventIds: string[] },
  ): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).compactContext(this.eventIdentity(), compaction)
    })
  }

  async addCheckpoint(sessionId: string, checkpoint: SessionCheckpoint): Promise<void> {
    await this.commit(() => {
      this.requireCollection().get(sessionId).addCheckpoint(checkpoint, this.dependencies.now())
    })
  }

  async rollbackToUserMessage(sessionId: string, messageId: string): Promise<SessionRollbackResult> {
    return this.commit(() => (
      this.requireCollection().get(sessionId).rollbackToUserMessage(messageId, this.dependencies.now())
    ))
  }

  private async persist(): Promise<void> {
    await this.dependencies.repository.save(this.snapshot())
  }

  private async commit<T>(mutation: () => T): Promise<T> {
    const operation = this.commandTail.then(async () => {
      const before = this.snapshot()
      try {
        const result = mutation()
        await this.persist()
        return result
      } catch (error) {
        this.collection = SessionCollection.restore(before)
        throw error
      }
    })
    this.commandTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private eventIdentity(): EventIdentity {
    return {
      eventId: this.dependencies.nextId(),
      occurredAt: this.dependencies.now(),
    }
  }

  private requireCollection(): SessionCollection {
    if (!this.collection) throw new Error('Session application service is not initialized')
    return this.collection
  }
}
