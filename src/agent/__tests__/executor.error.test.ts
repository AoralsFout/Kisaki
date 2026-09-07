import { describe, expect, it } from 'vitest'
import { executeToolCall, toolErrorMessage } from '../executor'
import { register } from '../registry'

describe('tool error normalization', () => {
  it('preserves string rejections returned by Tauri invoke', async () => {
    register({
      definition: {
        type: 'function',
        function: { name: 'test_string_error', description: '', parameters: { type: 'object' } },
      },
      handler: async () => { throw 'window.hide not allowed' },
    })

    const result = await executeToolCall({ id: 'call-1', name: 'test_string_error', arguments: {} })
    expect(result.content).toBe('工具执行错误: window.hide not allowed')
  })

  it('handles Error, structured, null, and undefined values', () => {
    expect(toolErrorMessage(new Error('boom'))).toBe('boom')
    expect(toolErrorMessage({ code: 403 })).toBe('{"code":403}')
    expect(toolErrorMessage(null)).toBe('未知错误')
    expect(toolErrorMessage(undefined)).toBe('未知错误')
  })
})
