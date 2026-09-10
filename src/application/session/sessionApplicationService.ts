import type { ConversationSessionSnapshot, SessionDocument } from '../../domain/conversation/events'
import { SessionAggregate } from '../../domain/conversation/sessionAggregate'
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

  private async persist(): Promise<void> {
    await this.dependencies.repository.save(this.snapshot())
  }

  private async commit<T>(mutation: () => T): Promise<T> {
    const before = this.snapshot()
    const result = mutation()
    try {
      await this.persist()
      return result
    } catch (error) {
      this.collection = SessionCollection.restore(before)
      throw error
    }
  }

  private requireCollection(): SessionCollection {
    if (!this.collection) throw new Error('Session application service is not initialized')
    return this.collection
  }
}
