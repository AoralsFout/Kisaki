import type { SessionDocument } from '../../domain/conversation/events'

/** 持久化端口。实现方可以是 Tauri、内存或测试夹具。 */
export interface SessionRepository {
  load(): Promise<SessionDocument | null>
  save(document: SessionDocument): Promise<void>
}
