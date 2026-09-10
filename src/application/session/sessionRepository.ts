import type { SessionDocument } from '../../domain/conversation/events'

/** Persistence port. Implementations may use Tauri, memory, or test fixtures. */
export interface SessionRepository {
  load(): Promise<SessionDocument | null>
  save(document: SessionDocument): Promise<void>
}
