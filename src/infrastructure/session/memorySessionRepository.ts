import type { SessionRepository } from '../../application/session/sessionRepository'
import type { SessionDocument } from '../../domain/conversation/events'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 浏览器预览下 Tauri 持久化 API 不可用时的易失兜底实现。 */
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
