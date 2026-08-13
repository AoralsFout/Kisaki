/**
 * ChatContext 上下文裁剪回归测试
 *
 * 重点验证「回合感知裁剪」：裁剪后消息序列仍满足 OpenAI 协议——
 * system 开头、非 system 首条为 user、每条 tool 回执紧跟其 assistant(tool_calls)，
 * 不产生孤儿 tool 或「以 assistant 开头」的非法序列。
 */
import { describe, it, expect } from 'vitest'
import { ChatContext } from '../context'

describe('ChatContext 上下文裁剪（回合感知）', () => {
  it('裁剪后保持合法消息序列：system 开头、无孤儿 tool、不以 assistant 开头', () => {
    // 用极小 token 预算强制在多轮后触发裁剪
    const ctx = new ChatContext({ maxContextTokens: 50 })
    ctx.setSystemPrompt('你是一个测试助手。', 'ja-JP', 'zh-CN', 'illustration')

    for (let round = 0; round < 5; round++) {
      ctx.addUserMessage(`第 ${round} 轮问题 ` + 'x'.repeat(20))
      ctx.addAssistantToolCall([{
        id: `t${round}`,
        type: 'function',
        function: { name: 'say', arguments: JSON.stringify({ voice: '台词', display: '台词' }) },
      }])
      ctx.addToolResult(`t${round}`, '已说出')
    }

    const msgs = ctx.getMessages()

    // 首条必须是 system
    expect(msgs[0].role).toBe('system')
    // 非 system 的第一条必须是 user（不能以 assistant/tool 开头）
    const firstNonSystem = msgs.find((m) => m.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')
    // 每条 tool 消息必须紧跟在其 assistant(tool_calls) 之后（配对，无孤儿）
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].role === 'tool') {
        expect(msgs[i - 1].role).toBe('assistant')
        expect(msgs[i - 1].tool_calls).toBeTruthy()
      }
    }
  })

  it('estimatedTokens 计入 tool_calls 参数体', () => {
    const ctx = new ChatContext({ maxContextTokens: 1000000 })
    ctx.setSystemPrompt('助手', 'ja-JP', 'zh-CN', 'illustration')
    const base = ctx.estimatedTokens

    ctx.addUserMessage('hi')
    const afterUser = ctx.estimatedTokens

    // 追加一条带超长 arguments 的 tool_call（1000 字符），应显著增加 token 估算
    ctx.addAssistantToolCall([{
      id: 't',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x'.repeat(1000) }) },
    }])
    const afterToolCall = ctx.estimatedTokens

    // 纯 user 消息只带来 ~4 token 结构开销；tool_call 的 1000 字符 arguments 应带来 >200
    const toolCallDelta = afterToolCall - afterUser
    expect(toolCallDelta).toBeGreaterThan(200)
    expect(base).toBeGreaterThan(0)
  })
})
