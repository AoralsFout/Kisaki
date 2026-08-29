/**
 * ChatContext 上下文裁剪回归测试
 *
 * 重点验证「回合感知裁剪」：裁剪后消息序列仍满足 OpenAI 协议——
 * system 开头、非 system 首条为 user、每条 tool 回执紧跟其 assistant(tool_calls)，
 * 不产生孤儿 tool 或「以 assistant 开头」的非法序列。
 */
import { describe, it, expect } from 'vitest'
import { ChatContext, ContextBudgetError } from '../context'

describe('ChatContext 上下文裁剪（回合感知）', () => {
  it('系统提示明确 say 只能作为最后的单独终止调用', () => {
    const ctx = new ChatContext({ maxContextTokens: 100000 })
    ctx.setSystemPrompt('助手', 'ja-JP', 'zh-CN', 'illustration')
    ctx.addUserMessage('完成一个需要多步工具调用的任务')

    const system = ctx.getMessages()[0].content
    expect(system).toContain('say 是终止当前工具循环的最终提交动作')
    expect(system).toContain('不要把 say 与任何其他工具放在同一批调用中')
    expect(system).toContain('必须先完成所有必要的工具调用、读取工具结果并验证任务结果')
    expect(system).toContain('最后单独调用一次 say')
  })

  it('系统提示把 voice 限制为可朗读文字、空格和半角逗号', () => {
    const ctx = new ChatContext({ maxContextTokens: 100000 })
    ctx.setSystemPrompt('助手', 'zh-CN', 'zh-CN', 'live2d')
    ctx.addUserMessage('告诉我版本和日期')

    const system = ctx.getMessages()[0].content
    expect(system).toContain('半角逗号 , 逗号是唯一允许的标点和分句符号')
    expect(system).toContain('禁止阿拉伯数字、罗马数字和数学符号')
    expect(system).toContain('日期、时间、版本号、金额和运算式完整念出来')
    expect(system).toContain('display 不受这些语音字符限制')
  })

  it('裁剪后保持合法消息序列：system 开头、无孤儿 tool、不以 assistant 开头', () => {
    // 用回合上限强制裁剪，避免测试依赖 system prompt 的具体长度。
    const ctx = new ChatContext({ maxRounds: 2, maxContextTokens: 100000 })
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
    expect(ctx.getStats().summarizedRounds).toBe(3)
    expect(msgs[msgs.length - 1]?.role).not.toBe('system')
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

  it('每次请求前把工具定义计入预算，无法容纳时给出明确错误', () => {
    const ctx = new ChatContext({ maxContextTokens: 2000 })
    ctx.setSystemPrompt('助手', 'zh-CN', 'zh-CN', 'illustration')
    ctx.addUserMessage('hi')
    const hugeTools = [{ type: 'function', function: { name: 'huge', description: 'x'.repeat(10000) } }]
    expect(() => ctx.getMessages(hugeTools)).toThrow(ContextBudgetError)
    expect(ctx.getStats().toolDefinitionTokens).toBeGreaterThan(3000)
  })

  it('工具结果压缩保留头尾而不是只保留开头', () => {
    const ctx = new ChatContext({ maxContextTokens: 100000 })
    ctx.addUserMessage('运行测试')
    ctx.addAssistantToolCall([{
      id: 'cmd', type: 'function', function: { name: 'run_process', arguments: '{}' },
    }])
    ctx.addToolResult('cmd', `HEAD-${'x'.repeat(3000)}-TAIL`)
    const tool = ctx.getMessages().find(m => m.role === 'tool')
    expect(tool?.content).toContain('HEAD-')
    expect(tool?.content).toContain('-TAIL')
    expect(tool?.content).toContain('省略')
  })

  it('持久化协议上下文会脱敏，并可在新上下文中恢复工具事实', () => {
    const ctx = new ChatContext({ maxContextTokens: 100000 })
    ctx.addUserMessage('读取配置')
    ctx.addAssistantToolCall([{
      id: 'read', type: 'function', function: {
        name: 'read_file', arguments: JSON.stringify({ path: 'a.txt', apiKey: 'sk-secret-secret-secret' }),
      },
    }])
    ctx.addToolResult('read', 'token=very-secret-value\n读取成功')
    const snapshot = ctx.exportSnapshot()
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret-secret-secret')
    expect(JSON.stringify(snapshot)).not.toContain('very-secret-value')

    const restored = new ChatContext({ maxContextTokens: 100000 })
    expect(restored.importSnapshot(snapshot)).toBe(true)
    const msgs = restored.getMessages()
    expect(msgs.some(m => m.role === 'assistant' && m.tool_calls?.[0]?.function.name === 'read_file')).toBe(true)
    expect(msgs.some(m => m.role === 'tool' && m.tool_call_id === 'read')).toBe(true)
  })
})
