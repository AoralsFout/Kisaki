import { invoke } from '@tauri-apps/api/core'
import type { SessionRepository } from '../../application/session/sessionRepository'
import type { SessionDocument } from '../../domain/conversation/events'
import { SessionCollection } from '../../domain/conversation/sessionCollection'

/** Persists only the strict v2 session document. Legacy files are intentionally ignored. */
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
