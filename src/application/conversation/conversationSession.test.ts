/**
 * ConversationSession 的基线行为测试。
 *
 * 这一份只证明编排真的跑起来了：送出与提交、取消、两条工具路径、轮次上限、
 * 失败与拒绝的终态分类、后台语音不越界、缺端口显式失败。
 * 逐条对齐 A–U 行为清单的完整套件由 #19 承担，这里不重复。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway } from '../tools/approvalGateway'
import type { ToolExecutionPolicy } from '../tools/toolExecutionCoordinator'
import { ConversationSession, type ConversationSessionPorts } from './conversationSession'
import {
  FakeToolExecutionPort,
  UNRESOLVED_VOICE,
  actionCall,
  actionTurn,
  approvalPolicyOnlyFirstTime,
  createConversationHarness,
  deferred,
  sayTurn,
  type ConversationHarness,
} from './conversationSession.testkit'

/** 让已经排队的微任务与定时器先跑完，再断言后台副作用的最终结果。 */
function flushPending(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * 跑一个回合，并在批准卡上选「本会话允许」。
 * 每个回合都要求一次批准，所以可以反复授予，用来观察授予何时失效。
 */
async function grantSessionApproval(h: ConversationHarness, sayId: string): Promise<void> {
  h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['allow-session']).prepare
  h.model.enqueue(sayTurn(
    sayId,
    { voice: 'おわった', display: '好了' },
    [actionCall('read_file', `${sayId}-action`)],
  ))
  const sending = h.session.send({ text: 'hi', images: [] })
  await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
  h.toolExecution.gateway.resolve('allow-session')
  await sending
}

describe('ConversationSession', () => {
  describe('送出与提交', () => {
    it('把用户消息落库、建检查点、提交 say 回执与 assistant 消息', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

      const result = await h.session.send({ text: '  你好呀  ', images: [] })

      expect(result).toEqual({
        status: 'success',
        requestId: 'request-1',
        turnsUsed: 1,
        partial: false,
        fallbackUsed: false,
      })
      expect(h.facts.accepted).toHaveLength(1)
      expect(h.facts.accepted[0]).toMatchObject({
        sessionId: 'session-1',
        messageId: 'user-message-1',
        text: '你好呀',
      })
      expect(h.context.userMessages[0].text).toBe('你好呀')
      expect(h.facts.assistantMessages[0]).toMatchObject({
        requestId: 'request-1',
        sessionId: 'session-1',
        display: '你好',
        voice: 'こんにちは',
        source: 'say',
      })
      // §U：用户消息落库 → 检查点 → 工具调用落库 → say 回执 → assistant 提交。
      expect(h.facts.events.slice(0, 5)).toEqual([
        'accept:user-message-1',
        'checkpoint:user-message-1',
        'toolCalls:request-1:0',
        'toolResult:say-1:succeeded',
        'assistant:say',
      ])
    })

    it('纯图片消息用文案端口补出正文', async () => {
      const h = createConversationHarness()
      const image = { id: 'img-1', name: 'a.png', mimeType: 'image/png', size: 10, dataUrl: 'data:,' }
      h.model.enqueue({ type: 'done', text: '' })

      await h.session.send({ text: '   ', images: [image] })

      expect(h.facts.accepted[0].text).toBe('[仅图片]')
      expect(h.facts.accepted[0].images).toEqual([image])
    })

    it('未授权工作区时，请求消息尾部追加一条 system 提示', async () => {
      const h = createConversationHarness()
      h.facts.workspace = null
      h.model.enqueue(sayTurn('say-1', { voice: 'やあ', display: '嗨' }))

      await h.session.send({ text: 'hi', images: [] })

      const sent = h.model.requests[0].messages
      expect(sent[sent.length - 1]).toMatchObject({ role: 'system' })
      expect(String(sent[sent.length - 1].content)).toContain('工作区')
      // 提示只进本次请求，不进模型上下文。
      expect(h.context.requestedTools).toHaveLength(1)
      expect(h.context.conversation.some(message => message.role === 'system')).toBe(false)
    })

    it('say 内容为空时不交付回复，落到兜底气泡', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', {}))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'empty-response' })
      expect(h.facts.assistantMessages).toHaveLength(0)
      expect(h.session.projection().bubbleText).toBe('[没有可交付的回复]')
    })

    it('模型不交付任何回复时按空回复收尾', async () => {
      const h = createConversationHarness()
      h.model.enqueue({ type: 'done', text: '   ' })

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'empty-response', turnsUsed: 1 })
      expect(h.session.projection().bubbleText).toBe('[没有可交付的回复]')
    })
  })

  describe('两条工具路径', () => {
    it('文本兜底路径：正文当显示文本，合成 say 只进模型上下文', async () => {
      const h = createConversationHarness()
      h.model.enqueue({ type: 'done', text: '喵' })

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', fallbackUsed: true, partial: false })
      expect(h.facts.assistantMessages[0]).toMatchObject({ display: '喵', source: 'text-fallback' })
      // 合成 say：实时上下文里是 say 调用，会话事实里不是服务端工具调用。
      expect(h.context.toolCallLog).toHaveLength(1)
      expect(h.context.toolCallLog[0][0].function.name).toBe('say')
      expect(h.context.toolResultLog).toEqual([{ callId: 'say-synthetic-1', content: '已说出' }])
      expect(h.facts.events).not.toContain('toolCalls:request-1:0')
    })

    it('文本形式的工具调用与原生调用走同一条批次路径', async () => {
      const h = createConversationHarness()
      h.catalog.textToolCalls = [{ id: 'text-call-1', name: 'read_file', arguments: {} }]
      h.model.enqueue({ type: 'done', text: '调用 read_file' })
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', turnsUsed: 2, fallbackUsed: false })
      expect(h.toolExecution.executed.map(call => call.id)).toEqual(['text-call-1'])
      expect(h.facts.events).toContain('toolCalls:request-1:0')
    })

    it('动作工具执行前备份检查点文件', async () => {
      const h = createConversationHarness()
      h.toolExecution.prepare = async call => ({ call, checkpointPath: 'notes.txt' })
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.toolExecution.checkpointed).toEqual(['notes.txt'])
      expect(h.facts.events).toContain('backup:notes.txt')
      expect(h.facts.events).toContain('markCheckpoint:user-message-1')
    })
  })

  describe('取消', () => {
    it('用户取消：结果与状态机同时落到 cancelled', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: '迟到的回复' }
      })

      const sending = h.session.send({ text: '写点什么', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))
      h.session.cancel('user-cancelled')
      gate.resolve()

      await expect(sending).resolves.toEqual({
        status: 'cancelled',
        requestId: 'request-1',
        turnsUsed: 1,
        reason: 'user-cancelled',
      })
      expect(h.session.projection().runState).toBe('cancelled')
      expect(h.session.projection().bubbleText).toBe('')
      expect(h.facts.assistantMessages).toHaveLength(0)
      expect(h.voice.cancelled).toContainEqual({ reason: 'user-cancelled', resetDedupe: true })
    })

    it('被新回合顶替的旧回合以 cancelled 收尾，且不覆盖新回合的投影', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: '迟到的回复' }
      })
      const stale = h.session.send({ text: '第一条', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))
      h.session.cancel('user-cancelled')

      h.model.enqueue(sayTurn('say-1', { voice: 'はい', display: '好的' }))
      const fresh = await h.session.send({ text: '第二条', images: [] })
      gate.resolve()

      await expect(stale).resolves.toMatchObject({ status: 'cancelled', reason: 'user-cancelled' })
      expect(fresh).toMatchObject({ status: 'success' })
      // 旧回合的解码结果不得写回新回合的气泡。
      expect(h.session.projection().bubbleText).toBe('好的')
      expect(h.facts.assistantMessages).toHaveLength(1)
    })
  })

  describe('终态分类', () => {
    it('触达轮次上限仍未交付时是 turn-limit', async () => {
      const h = createConversationHarness({ maxToolTurns: 2 })
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(actionTurn('read_file', 'action-2'))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toEqual({ status: 'turn-limit', requestId: 'request-1', turnsUsed: 2 })
      expect(h.session.projection().bubbleText).toBe('[没有可交付的回复]')
    })

    it('工具失败让同批的 say 让位，下一轮交付后整体标为 partial', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', {
        role: 'tool',
        tool_call_id: 'action-1',
        content: '工具执行失败: 读不了',
        ok: false,
        retryable: true,
      })
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'よんだ', display: '读好了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', partial: true, turnsUsed: 2 })
      expect(h.facts.events).toContain('toolResult:action-1:failed')
      expect(h.facts.recordedResults.find(item => item.callId === 'say-1')).toMatchObject({
        status: 'rejected',
        code: 'SAY_DEFERRED',
        content: expect.stringContaining('工具失败'),
      })
    })

    it('用户拒绝时不执行、记为 rejected，并让 say 让位', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', {
        role: 'tool',
        tool_call_id: 'action-1',
        content: '用户已拒绝文件操作，未执行。',
        ok: false,
        code: 'USER_REJECTED',
        retryable: false,
      })
      h.model.enqueue(sayTurn('say-1', { voice: 'やめた', display: '那算了' }, [actionCall('read_file', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'やめた', display: '那算了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', turnsUsed: 2 })
      expect(h.facts.events).toContain('toolResult:action-1:rejected')
      // say 被推迟，理由取「用户跳过该操作」而不是「工具失败」。
      expect(h.facts.recordedResults.find(item => item.callId === 'say-1')).toMatchObject({
        status: 'rejected',
        code: 'SAY_DEFERRED',
        content: expect.stringContaining('用户跳过'),
      })
    })

    it('模型调用失败时报错并保留具体错误提示', async () => {
      const h = createConversationHarness()
      h.model.enqueue(() => { throw new Error('上游 500') })

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'model-failure', turnsUsed: 1 })
      expect(h.session.projection().runState).toBe('failed')
      expect(h.session.projection().bubbleText).toBe('[错误] 上游 500')
    })
  })

  describe('守卫', () => {
    it('重入与空输入在任何副作用之前返回', async () => {
      const h = createConversationHarness()
      await expect(h.session.send({ text: '   ', images: [] })).resolves.toMatchObject({
        status: 'failed', reason: 'empty-input', requestId: null,
      })
      expect(h.facts.events).toEqual([])

      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: 'ok' }
      })
      const sending = h.session.send({ text: '第一条', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))
      await expect(h.session.send({ text: '第二条', images: [] })).resolves.toMatchObject({
        status: 'failed', reason: 'reentrant',
      })
      gate.resolve()
      await sending
    })

    it('网络不可用时气泡提示，且回合已建、语音已取消', async () => {
      const h = createConversationHarness()
      h.network.online = false

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'network-unavailable' })
      expect(h.session.projection().bubbleText).toBe('[网络不可用]')
      expect(h.session.projection().runState).toBe('failed')
      expect(h.voice.cancelled).toContainEqual({ reason: 'new-message', resetDedupe: false })
      // 守卫失败时用户消息还没有落库。
      expect(h.facts.events).toEqual([])
    })

    it('API 未配置时气泡提示', async () => {
      const h = createConversationHarness()
      h.model.ready = false

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'invalid-configuration' })
      expect(h.session.projection().bubbleText).toBe('[API 未配置]')
    })

    it('会话保存失败时不提交模型上下文，但用户消息留在界面之外', async () => {
      const h = createConversationHarness()
      h.facts.acceptResult = false

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'session-persistence-failed' })
      expect(h.session.projection().bubbleText).toBe('[错误] 会话保存失败')
      expect(h.context.userMessages).toHaveLength(0)
      expect(h.model.requests).toHaveLength(0)
    })

    it('检查点失败时报错，但已落库的用户消息保留在历史里', async () => {
      const h = createConversationHarness()
      h.facts.checkpointError = new Error('Cannot checkpoint a stale session')

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'session-persistence-failed' })
      expect(h.facts.accepted).toHaveLength(1)
      expect(h.context.userMessages).toHaveLength(1)
    })
  })

  describe('后台语音准备', () => {
    it('不阻塞回合完成：提交之后才异步回填并播放', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

      const result = await h.session.send({ text: 'hi', images: [] })
      expect(result).toMatchObject({ status: 'success' })

      await vi.waitFor(() => expect(h.voice.played).toHaveLength(1))
      expect(h.voice.played[0]).toMatchObject({
        requestId: 'request-1',
        text: 'こんにちは',
        voiceId: 'voice-1',
        voiceLanguage: 'ja-JP',
      })
      const events = h.facts.events
      expect(events.indexOf('assistant:say')).toBeLessThan(events.indexOf('revise:assistant-message-1'))
    })

    it('新回合顶替时在途的语音准备被中止，且不再回填或播放', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      let voiceSignal: AbortSignal | undefined
      h.translate.handler = async (text, targetLang, context) => {
        voiceSignal = context.signal
        await gate.promise
        return `${targetLang}:${text}`
      }
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: '第一条', images: [] })
      expect(voiceSignal?.aborted).toBe(false)

      h.model.enqueue(sayTurn('say-2', { voice: 'やあ', display: '嗨' }))
      await h.session.send({ text: '第二条', images: [] })

      expect(voiceSignal?.aborted).toBe(true)
      gate.resolve()
      await flushPending()
      // 作废的只有一个回合之后才兑现的翻译：它不再回填，也不再播放。
      expect(h.facts.revisions.map(revision => revision.messageId)).not.toContain('assistant-message-1')
      expect(h.voice.played.map(request => request.requestId)).not.toContain('request-1')
    })

    it('用户取消一并中止正在准备的后台语音', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      let voiceSignal: AbortSignal | undefined
      h.translate.handler = async (text, targetLang, context) => {
        voiceSignal = context.signal
        await gate.promise
        return `${targetLang}:${text}`
      }
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })

      h.session.cancel('user-cancelled')

      expect(voiceSignal?.aborted).toBe(true)
      gate.resolve()
      await flushPending()
      expect(h.facts.revisions).toHaveLength(0)
    })
  })

  describe('批准与自动允许', () => {
    it('会话内允许后，同轮后续工具批次带上自动允许标记', async () => {
      const h = createConversationHarness()
      const seen: boolean[] = []
      h.session.subscribe(projection => { seen.push(projection.autoExecSession) })
      const policy = approvalPolicyOnlyFirstTime(['allow', 'allow-session', 'reject'])
      h.toolExecution.prepare = policy.prepare
      h.model.enqueue(sayTurn(
        'say-1',
        { voice: 'おわった', display: '好了' },
        [actionCall('read_file', 'action-1'), actionCall('read_file', 'action-2')],
      ))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
      h.toolExecution.gateway.resolve('allow-session')
      await sending

      expect(h.toolExecution.sessionApprovals).toBe(1)
      expect(h.toolExecution.executed.map(call => call.id)).toEqual(['action-1', 'action-2'])
      expect(h.toolExecution.contexts[0].sessionApproval).toBe(false)
      expect(h.toolExecution.contexts[1].sessionApproval).toBe(true)
      // 决策一落地就必须能被订阅者看见，诊断面板读的就是它。
      expect(h.session.projection().autoExecSession).toBe(true)
      expect(seen).toContain(true)
      expect(seen[0]).toBe(false)
    })

    it('用户主动停止不撤销授予，清空对话与会话切换都撤销', async () => {
      const h = createConversationHarness()
      const seen: boolean[] = []
      h.session.subscribe(projection => { seen.push(projection.autoExecSession) })
      expect(h.session.projection().autoExecSession).toBe(false)

      await grantSessionApproval(h, 'say-1')
      expect(h.session.projection().autoExecSession).toBe(true)

      h.session.cancel('user-cancelled')
      expect(h.session.projection().autoExecSession).toBe(true)

      h.session.cancel('session-changed')
      expect(h.session.projection().autoExecSession).toBe(false)

      await grantSessionApproval(h, 'say-2')
      expect(h.session.projection().autoExecSession).toBe(true)

      h.session.cancel('messages-cleared')
      expect(h.session.projection().autoExecSession).toBe(false)
    })
  })

  describe('等待批准', () => {
    /** 每次都要求批准；一回合一张卡，用来观察等待态挂在哪个回合头上。 */
    const alwaysAsk: ToolExecutionPolicy['prepare'] = async call => ({
      call,
      approval: {
        id: `approval-${call.id}`,
        toolName: call.name,
        args: call.arguments,
        kind: 'file',
        path: 'notes.txt',
        allowedDecisions: ['allow'],
      },
    })

    it('等待期间投影是 awaiting-approval，批准后先回到 executing-tools', async () => {
      const h = createConversationHarness()
      const states: string[] = []
      h.session.subscribe(projection => { states.push(projection.runState) })
      h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['allow']).prepare
      h.model.enqueue(sayTurn(
        'say-1',
        { voice: 'かいた', display: '写好了' },
        [actionCall('read_file', 'action-1')],
      ))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())

      // 用户还在看批准卡：界面必须停在「等待批准」，而不是「正在执行工具」。
      expect(h.session.projection().runState).toBe('awaiting-approval')

      h.toolExecution.gateway.resolve('allow')
      await sending

      expect(states).toContain('awaiting-approval')
      // 批准之后先回到执行态，再走向终态。
      expect(states.lastIndexOf('executing-tools')).toBeGreaterThan(states.indexOf('awaiting-approval'))
      expect(h.session.projection().runState).toBe('completed')
    })

    it('用户拒绝同样退出 awaiting-approval', async () => {
      const h = createConversationHarness()
      const states: string[] = []
      h.session.subscribe(projection => { states.push(projection.runState) })
      h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['reject']).prepare
      h.model.enqueue(sayTurn(
        'say-1',
        { voice: 'かいた', display: '写好了' },
        [actionCall('read_file', 'action-1')],
      ))
      h.model.enqueue(sayTurn('say-2', { voice: 'やめた', display: '那算了' }))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
      expect(h.session.projection().runState).toBe('awaiting-approval')

      h.toolExecution.gateway.resolve('reject')
      await sending

      expect(states.lastIndexOf('executing-tools')).toBeGreaterThan(states.indexOf('awaiting-approval'))
      expect(h.facts.events).toContain('toolResult:action-1:rejected')
      expect(h.session.projection().runState).toBe('completed')
    })

    it('批准超时被自动拒绝后也退出 awaiting-approval', async () => {
      // 缩短网关自己的 5 分钟超时；超时走的是与 rejectPending 同一条 finish('reject')。
      const timedOutExecution = new FakeToolExecutionPort(new ApprovalGateway(10))
      const h = createConversationHarness({}, { toolExecution: timedOutExecution })
      const states: string[] = []
      h.session.subscribe(projection => { states.push(projection.runState) })
      timedOutExecution.prepare = alwaysAsk
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(sayTurn('say-2', { voice: 'やめた', display: '那算了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success' })
      expect(h.facts.events).toContain('toolResult:action-1:rejected')
      expect(states).toContain('awaiting-approval')
      expect(states.lastIndexOf('executing-tools')).toBeGreaterThan(states.indexOf('awaiting-approval'))
    })

    it('取消让等待态直接落到 cancelled', async () => {
      const h = createConversationHarness()
      h.toolExecution.prepare = alwaysAsk
      h.model.enqueue(actionTurn('read_file', 'action-1'))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
      expect(h.session.projection().runState).toBe('awaiting-approval')

      h.session.cancel('user-cancelled')
      await expect(sending).resolves.toMatchObject({ status: 'cancelled' })

      // 取消中止回合信号，网关随之清空待决；待批准请求不会留在界面上。
      expect(h.toolExecution.gateway.current()).toBeNull()
      expect(h.session.projection().runState).toBe('cancelled')
    })

    it('终结的回合不会被迟到的待决事件拉回非终态', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'はい', display: '好的' }))
      await h.session.send({ text: 'hi', images: [] })
      expect(h.session.projection().runState).toBe('completed')

      const controller = new AbortController()
      void h.toolExecution.gateway.request({
        id: 'approval-late',
        toolName: 'read_file',
        args: {},
        kind: 'file',
        path: 'notes.txt',
        allowedDecisions: ['allow'],
      }, controller.signal)

      expect(h.session.projection().runState).toBe('completed')
      // 收尾：清掉这条请求带的超时定时器，同时验证迟到的「待决清除」也是空操作。
      h.toolExecution.gateway.rejectPending()
      expect(h.session.projection().runState).toBe('completed')
    })

    it('被顶替的回合不会被新回合的批准卡牵动', async () => {
      const h = createConversationHarness()
      const statesByRun = new Map<string | null, string[]>()
      h.session.subscribe(projection => {
        statesByRun.set(projection.runId, [...(statesByRun.get(projection.runId) ?? []), projection.runState])
      })
      h.toolExecution.prepare = alwaysAsk
      h.model.enqueue(actionTurn('read_file', 'action-a'))

      const stale = h.session.send({ text: '第一条', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
      expect(h.session.projection()).toMatchObject({ runId: 'request-1', runState: 'awaiting-approval' })

      h.session.cancel('user-cancelled')
      h.model.enqueue(actionTurn('read_file', 'action-b'))
      h.model.enqueue(sayTurn('say-b', { voice: 'はい', display: '好的' }))
      const fresh = h.session.send({ text: '第二条', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())

      // 新回合自己的批准卡：等待态必须挂在新回合头上，旧回合不再回来。
      expect(h.session.projection()).toMatchObject({ runId: 'request-2', runState: 'awaiting-approval' })
      await expect(stale).resolves.toMatchObject({ status: 'cancelled' })
      const staleStates = statesByRun.get('request-1') ?? []
      const cancelledAt = staleStates.indexOf('cancelled')
      expect(cancelledAt).toBeGreaterThanOrEqual(0)
      // 落到终态之后，旧回合一直停在终态 —— 新回合的批准卡没有把它牵回等待态。
      expect(staleStates.slice(cancelledAt).every(state => state === 'cancelled')).toBe(true)

      h.toolExecution.gateway.resolve('allow')
      await expect(fresh).resolves.toMatchObject({ status: 'success' })
      expect(h.session.projection()).toMatchObject({ runId: 'request-2', runState: 'completed' })
    })
  })

  describe('投影', () => {
    it('订阅时立刻回调当前投影，并在回合推进时继续回调', async () => {
      const h = createConversationHarness()
      const seen: string[] = []
      const unsubscribe = h.session.subscribe(projection => { seen.push(projection.runState) })
      expect(seen).toEqual(['idle'])

      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })

      expect(seen[0]).toBe('idle')
      expect(seen).toContain('streaming')
      expect(seen[seen.length - 1]).toBe('completed')
      const projection = h.session.projection()
      expect(projection.runId).toBe('request-1')
      expect(projection.context).toEqual(h.context.statsValue)
      unsubscribe()
    })

    it('工具活动按发生顺序进入投影', async () => {
      const h = createConversationHarness()
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.session.projection().toolActivities).toEqual([
        { id: 'action-1', name: 'read_file', status: 'done' },
      ])
    })

    it('被取消的回合把气泡与思考清空，但不改工具活动残留', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: 'late' }
      })
      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))

      h.session.cancel('user-cancelled')

      expect(h.session.projection()).toMatchObject({ bubbleText: '', thinking: '', typing: false })
      gate.resolve()
      await sending
    })
  })

  describe('缺端口', () => {
    it('少一个端口时构造失败并点出是哪一个', () => {
      const h = createConversationHarness()
      const ports = { ...h.ports } as Partial<ConversationSessionPorts>
      delete ports.voice

      expect(() => new ConversationSession(ports as ConversationSessionPorts))
        .toThrowError('ConversationSession 缺少端口：voice（语音播放入口）')
    })

    it('端口少一个方法时构造失败并点出是哪一个', () => {
      const h = createConversationHarness()
      const ports = {
        ...h.ports,
        session: { ...h.facts.asPort(), commitAssistantMessage: undefined },
      } as unknown as ConversationSessionPorts

      expect(() => new ConversationSession(ports))
        .toThrowError('ConversationSession 的 session 端口（会话事实）缺少方法：commitAssistantMessage()')
    })

    it('可调参数给错值时当场失败', () => {
      const h = createConversationHarness()
      expect(() => new ConversationSession(h.ports, { maxToolTurns: 0 }))
        .toThrowError('ConversationSession 的 maxToolTurns 必须是正整数：0')
    })
  })
})
