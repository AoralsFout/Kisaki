import { describe, expect, it } from 'vitest'
import { characterErrorReason } from './characterError'

describe('characterErrorReason', () => {
  it('归一 Error、字符串、undefined 与可序列化对象', () => {
    expect(characterErrorReason(new Error('失败'))).toBe('失败')
    expect(characterErrorReason('后端失败')).toBe('后端失败')
    expect(characterErrorReason(undefined)).toBe('undefined')
    expect(characterErrorReason({ code: 'E_IO' })).toBe('{"code":"E_IO"}')
  })

  it('循环对象使用稳定字符串兜底', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(characterErrorReason(value)).toBe('[object Object]')
  })
})
