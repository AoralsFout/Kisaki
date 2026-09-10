import type { SessionRepository } from '../../application/session/sessionRepository'
import type { SessionDocument } from '../../domain/conversation/events'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Volatile fallback for browser previews where the Tauri persistence API is unavailable. */
export class MemorySessionRepository implements SessionRepository {
  private document: SessionDocument | null = null

  async load(): Promise<SessionDocument | null> {
    return this.document ? clone(this.document) : null
  }

  async save(document: SessionDocument): Promise<void> {
    this.document = clone(document)
  }

  async clear(): Promise<void> {
    this.document = null
  }
}
