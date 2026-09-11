/**
 * 会话服务的装配契约。
 *
 * 「真机持久化还是内存兜底」「用哪个仓储适配器」是装配决策，归属组合根；
 * SessionStore 只按这份契约索要装配结果，因此它既不认识仓储实现，
 * 也不需要 import 组合根。
 */
import type { SessionApplicationService } from './sessionApplicationService'

/** 装配结果：服务本身，以及真机持久化是否已降级。 */
export interface SessionServiceAssembly {
  service: SessionApplicationService
  /** true = 真机持久化不可用，已换成易失的内存实现。展示层据此提示用户。 */
  degraded: boolean
}

/** 装配所需的 store 侧输入：id 形态与时钟仍由 SessionStore 提供。 */
export interface SessionServiceInputs {
  now: () => number
  nextId: () => string
}

/** 由组合根注入 SessionStore 的会话服务装配工厂。 */
export type SessionServiceFactory = (inputs: SessionServiceInputs) => Promise<SessionServiceAssembly>
