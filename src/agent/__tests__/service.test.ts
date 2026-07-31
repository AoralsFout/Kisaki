/**
 * 文本工具调用提取（兜底方案）单元测试
 *
 * 覆盖：简单调用、嵌套 JSON 参数、字符串内的花括号/引号、
 * 畸形调用跳过、strip 语义。
 */
import { describe, it, expect } from 'vitest'
import { agentService } from '../service'

describe('extractTextToolCalls（兜底文本调用解析）', () => {
  it('提取简单工具调用', () => {
    const calls = agentService.extractTextToolCalls(
      '请调用 calculator({"expression":"1+2"}) 完成计算',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('calculator')
    expect(calls[0].arguments).toEqual({ expression: '1+2' })
  })

  it('支持嵌套 JSON 参数（旧正则无法解析的场景）', () => {
    const text =
      'write_file({"path":"notes/a.json","content":{"title":"x","nested":{"ok":true}},"opts":{"mode":"json"}})'
    const calls = agentService.extractTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('write_file')
    expect(calls[0].arguments).toEqual({
      path: 'notes/a.json',
      content: { title: 'x', nested: { ok: true } },
      opts: { mode: 'json' },
    })
  })

  it('字符串值里的花括号不干扰括号匹配', () => {
    const text = 'say 前情提要：角色说 "好想见 {你}"。然后 set_character_emotion({"emotion":"开心"})'
    // say 不在注册表 → 不提取；set_character_emotion 应正常提取
    const calls = agentService.extractTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('set_character_emotion')
    expect(calls[0].arguments).toEqual({ emotion: '开心' })
  })

  it('字符串里的转义引号不破坏解析', () => {
    const text = 'calculator({"expression":"1+\\"2\\""})'
    const calls = agentService.extractTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ expression: '1+"2"' })
  })

  it('缺失右括号的畸形调用被跳过', () => {
    const calls = agentService.extractTextToolCalls(
      'calculator({"expression":"1+2"}) 然后 calculator({"expression":"2+3"',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ expression: '1+2' })
  })

  it('非工具名不提取', () => {
    const calls = agentService.extractTextToolCalls('random_function({"a":1})')
    expect(calls).toHaveLength(0)
  })
})

describe('stripTextToolCalls（从文本移除调用）', () => {
  it('移除简单调用', () => {
    const stripped = agentService.stripTextToolCalls(
      '请调用 calculator({"expression":"1+2"}) 完成计算',
    )
    expect(stripped).toBe('请调用  完成计算')
  })

  it('移除嵌套 JSON 调用', () => {
    const stripped = agentService.stripTextToolCalls(
      'write_file({"path":"a","content":{"nested":{"v":1}}}) 完成',
    )
    expect(stripped).toBe('完成')
  })

  it('无调用时原样返回（去除首尾空白）', () => {
    expect(agentService.stripTextToolCalls('  普通文本  ')).toBe('普通文本')
  })
})
