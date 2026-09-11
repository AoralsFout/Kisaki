import { invoke } from '@tauri-apps/api/core'
import type { SessionRepository } from '../../application/session/sessionRepository'
import type { SessionDocument } from '../../domain/conversation/events'
import { SessionCollection } from '../../domain/conversation/sessionCollection'

/** 只持久化严格的 v2 会话文档；旧版文件有意忽略。 */
export class TauriSessionRepository implements SessionRepository {
  async load(): Promise<SessionDocument | null> {
    const raw = await invoke<string | null>('sessions_v2_load')
    if (raw === null) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Session v2 file contains invalid JSON')
    }
    return SessionCollection.restore(parsed).snapshot()
  }

  async save(document: SessionDocument): Promise<void> {
    const validated = SessionCollection.restore(document).snapshot()
    await invoke('sessions_v2_save', { data: JSON.stringify(validated) })
  }

  async clear(): Promise<void> {
    await invoke('sessions_v2_clear')
  }
}
