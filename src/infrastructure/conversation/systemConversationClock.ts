/**
 * 时钟与 id 生成的真机适配器。
 *
 * 取代回合内对 `Date.now()` / `performance.now()` / `crypto.randomUUID()` 的现场调用，
 * 使回合测试可以换成可预期的假实现。
 *
 * id 形态与迁移前逐字一致：它们会写进会话时间线、检查点与遥测，改形态等于引入数据迁移。
 */
import type { ConversationClock, ConversationIdKind } from '../../application/conversation/conversationSession'

/** 用户消息 id 的随机后缀长度（迁移前 `slice(2, 8)`）。 */
const USER_MESSAGE_SUFFIX_LENGTH = 6

/** 合成 say 调用 id 的随机后缀长度（迁移前 `slice(2, 6)`，比用户消息短两位）。 */
const SAY_SYNTHETIC_SUFFIX_LENGTH = 4

/** 原始来源；缺省即宿主环境实现，注入值供测试与别的宿主使用。 */
export interface SystemConversationClockSources {
  /** 墙钟；缺省 `Date.now`。 */
  wallClock?: () => number
  /** 单调时钟；缺省 `performance.now()`。 */
  monotonicClock?: () => number
  /** 请求 id；缺省 `crypto.randomUUID()`。 */
  uuid?: () => string
  /** 低熵随机后缀；缺省 `Math.random().toString(36)` 截取。 */
  suffix?: (length: number) => string
}

function randomSuffix(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length)
}

export class SystemConversationClock implements ConversationClock {
  private readonly wallClock: () => number
  private readonly monotonicClock: () => number
  private readonly uuid: () => string
  private readonly suffix: (length: number) => string

  constructor(sources: SystemConversationClockSources = {}) {
    this.wallClock = sources.wallClock ?? Date.now
    this.monotonicClock = sources.monotonicClock ?? (() => performance.now())
    this.uuid = sources.uuid ?? (() => globalThis.crypto.randomUUID())
    this.suffix = sources.suffix ?? randomSuffix
  }

  now(): number {
    return this.wallClock()
  }

  monotonic(): number {
    return this.monotonicClock()
  }

  nextId(kind: ConversationIdKind): string {
    switch (kind) {
      case 'request':
        return this.uuid()
      case 'user-message':
        return `${this.wallClock()}-${this.suffix(USER_MESSAGE_SUFFIX_LENGTH)}`
      case 'say-synthetic':
        return `say_fallback_${this.wallClock()}_${this.suffix(SAY_SYNTHETIC_SUFFIX_LENGTH)}`
    }
  }
}
