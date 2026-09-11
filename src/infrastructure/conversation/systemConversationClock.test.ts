import { describe, expect, it } from 'vitest'
import { SystemConversationClock } from './systemConversationClock'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const USER_MESSAGE_ID = /^\d+-\w{1,6}$/
const SAY_SYNTHETIC_ID = /^say_fallback_\d+_\w{1,4}$/

describe('SystemConversationClock', () => {
  it('为每种用途生成既有的 id 形态', () => {
    const clock = new SystemConversationClock()

    expect(clock.nextId('request')).toMatch(UUID_V4)
    expect(clock.nextId('user-message')).toMatch(USER_MESSAGE_ID)
    expect(clock.nextId('say-synthetic')).toMatch(SAY_SYNTHETIC_ID)
  })

  it('同一用途连续生成也不重复', () => {
    const clock = new SystemConversationClock()
    const userMessageIds = new Set(Array.from({ length: 50 }, () => clock.nextId('user-message')))
    const requestIds = new Set(Array.from({ length: 50 }, () => clock.nextId('request')))

    expect(userMessageIds.size).toBe(50)
    expect(requestIds.size).toBe(50)
  })

  it('把墙钟读数带进 id，使 id 可回推到发生时刻', () => {
    const clock = new SystemConversationClock({ wallClock: () => 1730000000000, suffix: () => 'abc123' })

    expect(clock.now()).toBe(1730000000000)
    expect(clock.nextId('user-message')).toBe('1730000000000-abc123')
    expect(clock.nextId('say-synthetic')).toBe('say_fallback_1730000000000_abc123')
  })

  it('按后缀长度分别取随机串，合成 say 的比用户消息短两位', () => {
    const lengths: number[] = []
    const clock = new SystemConversationClock({
      wallClock: () => 1,
      suffix: (length) => {
        lengths.push(length)
        return 'x'.repeat(length)
      },
    })

    expect(clock.nextId('user-message')).toBe('1-xxxxxx')
    expect(clock.nextId('say-synthetic')).toBe('say_fallback_1_xxxx')
    expect(lengths).toEqual([6, 4])
  })

  it('单调时钟读数是可作差的毫秒数', () => {
    const clock = new SystemConversationClock({ monotonicClock: () => 42.5 })

    expect(clock.monotonic()).toBe(42.5)
    // 缺省来源在浏览器环境里必须可用，否则耗时遥测会全部变成 NaN。
    expect(new SystemConversationClock().monotonic()).toBeTypeOf('number')
  })
})
