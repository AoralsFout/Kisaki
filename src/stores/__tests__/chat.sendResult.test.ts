/**
 * 对话 store 的发送结果契约。
 *
 * 回合的守卫、编排与终态分类都在 `ConversationSession` 里，本文件只验证 store 那一层：
 * 返回值、界面消息列表、气泡与运行态是否如约跟随投影。
 *
 * 与迁移前的写法相比，这里：
 *  - 不 mock `src/ai` 模块，模型调用经 `ConversationSession` 的端口替身驱动；
 *  - 不手工拼 11 方法的会话事实端口字面量，用模块测试套件共用的假端口；
 *  - 不依赖 `setActivePinia`，每个用例自己传一个 Pinia 实例；
 *  - 不从日志缓冲区推断状态 —— 后台语音是否被作废，直接看它拿到的中止信号。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, type Pinia } from 'pinia'
import {
  actionCall,
  approvalPolicyOnlyFirstTime,
  createConversationHarness,
  deferred,
  sayTurn,
  type ConversationHarness,
} from '../../application/conversation/conversationSession.testkit'
import { ChatContextModelContext } from '../../infrastructure/conversation/chatContextModelContext'
import type { ConversationAssembly } from '../../compositionRoot'

/**
 * store 经 `conversationAssembly()` 取对话对象图。本文件把它换成一个
 * 「真实 ConversationSession + 假端口」的对象图：回合编排是真的，
 * 外部世界（模型、翻译、会话事实、语音）全部可控。
 */
const { assemblyRef } = vi.hoisted(() => ({
  assemblyRef: { current: null as unknown as ConversationAssembly },
}))

vi.mock('../../compositionRoot', () => ({
  conversationAssembly: () => {
    if (!assemblyRef.current) throw new Error('组合根尚未装配对话回合：composeApplication() 未执行')
    return assemblyRef.current
  },
}))

let pinia: Pinia
let h: ConversationHarness

/** store 在装配之后实例化，且不经全局激活的 Pinia。 */
async function chatStore() {
  const { useChatStore } = await import('../chat')
  return useChatStore(pinia)
}

beforeEach(() => {
  pinia = createPinia()
  h = createConversationHarness()
  // 除审批用例之外都不授权工作区：与会话事实端口未注入时的旧行为一致。
  h.facts.workspace = null
  assemblyRef.current = {
    ports: h.ports,
    session: h.session,
    context: new ChatContextModelContext(),
    approvalGateway: h.toolExecution.gateway,
  }
})

describe('send result contract', () => {
  it('离线时不发模型调用、不留消息，气泡提示网络不可用', async () => {
    h.network.online = false
    const store = await chatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages).toHaveLength(0)
    expect(store.isProcessing).toBe(false)
    expect(h.model.requests).toHaveLength(0)
    expect(store.currentBubbleText).toBe('[网络不可用]')
  })

  it('模型调用失败时保留已接收的用户消息，气泡带具体错误', async () => {
    h.model.enqueue(() => { throw new Error('connection failed') })
    const store = await chatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages.some(m => m.role === 'user' && m.text === 'draft')).toBe(true)
    expect(store.messages.filter(m => m.role === 'assistant')).toHaveLength(0)
    expect(store.isProcessing).toBe(false)
    expect(store.currentBubbleText).toBe('[错误] connection failed')
    expect(store.conversationRunState).toBe('failed')
  })

  it('模型空回复按失败收尾，不产生助手消息', async () => {
    h.model.enqueue({ type: 'done', text: '' })
    const store = await chatStore()
    expect(await store.sendMessage('draft')).toBe(false)
    expect(store.messages.filter(m => m.role === 'assistant')).toHaveLength(0)
    expect(store.isProcessing).toBe(false)
    expect(store.currentBubbleText).toBe('[没有可交付的回复]')
  })

  it('say 交付后按成功收尾，台词与显示文本都进界面列表', async () => {
    h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))
    const store = await chatStore()
    expect(await store.sendMessage('draft')).toBe(true)
    expect(store.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'draft'],
      ['assistant', '你好'],
    ])
    expect(store.messages.find(message => message.role === 'assistant')?.voice).toBe('こんにちは')
    expect(store.isProcessing).toBe(false)
    expect(store.conversationRunState).toBe('completed')
  })

  it('流式正文立即进入气泡，think 内容不泄漏', async () => {
    const store = await chatStore()
    const snapshots: string[] = []
    h.model.enqueue(request => {
      request.onChunk('<thi'); snapshots.push(store.currentBubbleText)
      request.onChunk('nk>分析中'); snapshots.push(store.currentBubbleText)
      request.onChunk('</think>你'); snapshots.push(store.currentBubbleText)
      request.onChunk('好'); snapshots.push(store.currentBubbleText)
      return sayTurn('say-stream-1', { voice: '你好', display: '你好' })
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(snapshots).toEqual(['', '', '你', '你好'])
    expect(store.currentBubbleText).toBe('你好')
    expect(store.currentThinking).toBe('分析中')
    expect(store.isProcessing).toBe(false)
  })

  it('每个工具轮次都重新隐藏 think 内容', async () => {
    const store = await chatStore()
    const secondTurnSnapshots: string[] = []
    h.model.enqueue(request => {
      request.onChunk('<think>第一轮分析</think>')
      return { type: 'tools', calls: [actionCall('read_file')] }
    })
    h.model.enqueue(request => {
      request.onChunk('<thi'); secondTurnSnapshots.push(store.currentBubbleText)
      request.onChunk('nk>第二轮分析'); secondTurnSnapshots.push(store.currentBubbleText)
      request.onChunk('</think>'); secondTurnSnapshots.push(store.currentBubbleText)
      return sayTurn('say-after-tool', { voice: '完成', display: '完成' })
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(h.model.requests).toHaveLength(2)
    expect(secondTurnSnapshots).toEqual(['', '', ''])
    expect(store.currentBubbleText).toBe('完成')
    expect(store.currentThinking).toBe('第二轮分析')
  })

  it('say 参数的流式预览早于工具调用完成', async () => {
    const store = await chatStore()
    const snapshots: string[] = []
    h.model.enqueue(request => {
      request.onToolCallDelta([{
        id: 'say-stream-args-1',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"こんにちは","display":"你' },
      }])
      snapshots.push(store.currentBubbleText)
      request.onToolCallDelta([{
        id: 'say-stream-args-1',
        type: 'function',
        function: { name: 'say', arguments: '{"voice":"こんにちは","display":"你好"}' },
      }])
      snapshots.push(store.currentBubbleText)
      return sayTurn('say-stream-args-1', { voice: 'こんにちは', display: '你好' })
    })

    expect(await store.sendMessage('draft')).toBe(true)
    expect(snapshots).toEqual(['你', '你好'])
    expect(store.currentBubbleText).toBe('你好')
  })

  it('交付显示文本后立即解锁输入，不等语音准备', async () => {
    const store = await chatStore()
    const gate = deferred()
    h.translate.handler = async (text, targetLang) => {
      await gate.promise
      return `${targetLang}:${text}`
    }
    h.model.enqueue(sayTurn('say-voice-later', { display: '你好' }))

    expect(await store.sendMessage('draft')).toBe(true)
    expect(store.isProcessing).toBe(false)
    expect(store.currentBubbleText).toBe('你好')
    expect(h.translate.calls.length).toBeGreaterThan(0)

    gate.resolve()
    await vi.waitFor(() => {
      expect(store.messages.find(message => message.role === 'assistant')?.voice).toBe('ja-JP:你好')
    })
  })

  it('清空对话会作废仍在准备中的后台语音：不再回填、不再播放', async () => {
    const store = await chatStore()
    const gate = deferred()
    let voiceSignal: AbortSignal | undefined
    h.translate.handler = async (text, targetLang, context) => {
      voiceSignal = context.signal
      await gate.promise
      return `${targetLang}:${text}`
    }
    h.model.enqueue(sayTurn('say-cleared-before-voice', { display: '稍后清空' }))

    expect(await store.sendMessage('draft')).toBe(true)
    // 语音准备挂在翻译上，此刻仍属于这个回合。
    expect(voiceSignal?.aborted).toBe(false)
    expect(h.facts.assistantMessages).toHaveLength(1)

    store.clearMessages()
    // 直接观察状态：语音准备拿到的那个中止信号被中止，而不是去读日志缓冲区。
    expect(voiceSignal?.aborted).toBe(true)
    expect(store.messages).toHaveLength(0)
    expect(store.currentBubbleText).toBe('')

    gate.resolve()
    await gate.promise
    await Promise.resolve()
    // 越界的语音准备既不回填，也不播放。
    expect(h.facts.revisions).toHaveLength(0)
    expect(h.voice.played).toHaveLength(0)
  })

  it('等待文件操作确认时取消会解除等待并清理运行态', async () => {
    const store = await chatStore()
    h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['allow', 'reject']).prepare
    h.model.enqueue({
      type: 'tools',
      calls: [{
        id: 'write-awaiting-confirmation',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'pending' }) },
      }],
    })

    const sending = store.sendMessage('write a note')
    await vi.waitFor(() => {
      expect(store.pendingApproval?.id).toBe('approval-1')
    })
    expect(store.conversationRunState).toBe('awaiting-approval')
    expect(store.isUsingTools).toBe(true)

    store.cancelResponse()
    await sending

    expect(store.pendingApproval).toBeNull()
    expect(store.isProcessing).toBe(false)
    expect(store.isUsingTools).toBe(false)
    expect(store.conversationRunState).toBe('cancelled')
    expect(store.currentBubbleText).toBe('')
    // 等待被解除，工具一次也没执行。
    expect(h.toolExecution.executed).toHaveLength(0)
  })
})
