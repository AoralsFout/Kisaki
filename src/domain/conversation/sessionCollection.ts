import type { ConversationSessionSnapshot, SessionDocument } from './events'
import { SessionAggregate } from './sessionAggregate'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 持有新 schema 下的会话列表与当前会话选择。 */
export class SessionCollection {
  private readonly sessions = new Map<string, SessionAggregate>()
  private currentId: string

  private constructor(initial: SessionAggregate[], currentSessionId: string) {
    for (const session of initial) {
      const id = session.snapshot().id
      if (this.sessions.has(id)) throw new Error(`Duplicate session id: ${id}`)
      this.sessions.set(id, session)
    }
    if (this.sessions.size === 0) throw new Error('Session document must contain at least one session')
    if (!this.sessions.has(currentSessionId)) throw new Error(`Current session does not exist: ${currentSessionId}`)
    this.currentId = currentSessionId
  }

  static create(initial: SessionAggregate): SessionCollection {
    return new SessionCollection([initial], initial.snapshot().id)
  }

  static restore(document: unknown): SessionCollection {
    if (!isRecord(document) || document.schemaVersion !== 2) {
      throw new Error('Unsupported session document schema')
    }
    if (typeof document.currentSessionId !== 'string' || !Array.isArray(document.sessions)) {
      throw new Error('Session document is invalid')
    }
    return new SessionCollection(
      document.sessions.map(snapshot => SessionAggregate.restore(snapshot)),
      document.currentSessionId,
    )
  }

  current(): SessionAggregate {
    return this.sessions.get(this.currentId)!
  }

  get(sessionId: string): SessionAggregate {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session does not exist: ${sessionId}`)
    return session
  }

  list(): ConversationSessionSnapshot[] {
    return [...this.sessions.values()]
      .map(session => session.snapshot())
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  add(session: SessionAggregate, makeCurrent = true): void {
    const id = session.snapshot().id
    if (this.sessions.has(id)) throw new Error(`Duplicate session id: ${id}`)
    this.sessions.set(id, session)
    if (makeCurrent) this.currentId = id
  }

  switchTo(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`Session does not exist: ${sessionId}`)
    this.currentId = sessionId
  }

  delete(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`Session does not exist: ${sessionId}`)
    if (this.sessions.size === 1) throw new Error('Cannot delete the last session')
    const wasCurrent = sessionId === this.currentId
    this.sessions.delete(sessionId)
    if (wasCurrent) {
      this.currentId = [...this.sessions.values()]
        .map(session => session.snapshot())
        .reduce((latest, candidate) => candidate.updatedAt > latest.updatedAt ? candidate : latest)
        .id
    }
  }

  snapshot(): SessionDocument {
    return {
      schemaVersion: 2,
      currentSessionId: this.currentId,
      sessions: this.list(),
    }
  }
}
