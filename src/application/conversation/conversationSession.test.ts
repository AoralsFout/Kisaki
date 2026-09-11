/**
 * ConversationSession 的行为测试。
 *
 * 基线部分（#16）证明编排真的跑起来了：送出与提交、取消、两条工具路径、轮次上限、
 * 失败与拒绝的终态分类、后台语音不越界、缺端口显式失败。
 * 下半部分（#19）把覆盖面推到 A–U 行为清单的完整验收面，并按风险优先补上
 * §T 里「当时完全没有测试」的行为。
 *
 * 断言只穿过 send / cancel / projection / subscribe 这条缝：断言的是「送一条输入后
 * 发生了什么」，不比对内部调用了哪些方法、以什么顺序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribe, type LogEntry } from '../../utils/logger'
import { ConversationSession, type ConversationSessionPorts } from './conversationSession'
import {
  UNRESOLVED_VOICE,
  actionCall,
  actionTurn,
  approvalPolicyOnlyFirstTime,
  createConversationHarness,
  deferred,
  gatedVoiceTranslation,
  sayTurn,
  toolImage,
  toolResult,
  type ConversationHarness,
} from './conversationSession.testkit'

import type { ConversationImage } from '../../domain/conversation/events'

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

  // ── A：守卫 ────────────────────────────────────────────

  describe('守卫', () => {
    it('A2 空输入：文本为空且无图片时，投影一动不动地返回', async () => {
      const h = createConversationHarness()
      const seen: string[] = []
      h.session.subscribe(projection => { seen.push(projection.bubbleText) })

      await expect(h.session.send({ text: '', images: [] })).resolves.toEqual({
        status: 'failed', requestId: null, turnsUsed: 0, reason: 'empty-input',
      })
      await expect(h.session.send({ text: '   \n ', images: [] })).resolves.toMatchObject({
        reason: 'empty-input',
      })

      // 订阅时的那一次之后没有别的回调：没有建回合、没有取消语音、没有清活动列表。
      expect(seen).toEqual([''])
      expect(h.session.projection()).toMatchObject({ runId: null, runState: 'idle', bubbleText: '' })
      expect(h.voice.cancelled).toEqual([])
      expect(h.facts.events).toEqual([])
    })

    it('A1 重入：已有回合进行中时直接拒绝，不触碰正在播放的语音', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: 'ok' }
      })
      const sending = h.session.send({ text: '第一条', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))

      await expect(h.session.send({ text: '第二条', images: [] })).resolves.toEqual({
        status: 'failed', requestId: null, turnsUsed: 0, reason: 'reentrant',
      })
      expect(h.model.requests).toHaveLength(1)
      // 重入守卫在任何副作用之前返回：第一条消息取消播放的那一次仍然只有一条。
      expect(h.voice.cancelled).toEqual([{ reason: 'new-message', resetDedupe: false }])

      gate.resolve()
      await expect(sending).resolves.toMatchObject({ status: 'success' })
    })

    it('A3 在线守卫失败时：回合已建、语音已取消、活动列表已重置，用户消息未落库', async () => {
      const h = createConversationHarness()
      h.network.online = false

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toEqual({
        status: 'failed', requestId: 'request-1', turnsUsed: 0, reason: 'network-unavailable',
      })
      expect(h.session.projection()).toMatchObject({
        runId: 'request-1',
        runState: 'failed',
        bubbleText: '[网络不可用]',
        typing: false,
        toolActivities: [],
      })
      // §U：守卫晚于语音取消，因此这两条副作用在失败时已经发生。
      expect(h.voice.cancelled).toEqual([{ reason: 'new-message', resetDedupe: false }])
      expect(h.facts.events).toEqual([])
      expect(h.model.requests).toHaveLength(0)
    })

    it('A4 配置守卫失败时：回合已建、语音已取消，用户消息未落库', async () => {
      const h = createConversationHarness()
      h.model.ready = false

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toEqual({
        status: 'failed', requestId: 'request-1', turnsUsed: 0, reason: 'invalid-configuration',
      })
      expect(h.session.projection()).toMatchObject({
        runId: 'request-1',
        runState: 'failed',
        bubbleText: '[API 未配置]',
        typing: false,
      })
      expect(h.voice.cancelled).toEqual([{ reason: 'new-message', resetDedupe: false }])
      expect(h.facts.events).toEqual([])
      expect(h.model.requests).toHaveLength(0)
    })
  })

  // ── B/C：用户消息事务与检查点 ──────────────────────────

  describe('用户消息事务与检查点', () => {
    it('B1/B3/B4 纯图片消息：落库的正文是文案端口的兜底文案，图片原样带上', async () => {
      const h = createConversationHarness()
      const image: ConversationImage = { id: 'img-1', name: 'a.png', mimeType: 'image/png', size: 10, dataUrl: 'data:,' }
      h.model.enqueue(sayTurn('say-1', { voice: 'みた', display: '看到了' }))

      await h.session.send({ text: '  ', images: [image] })

      expect(h.facts.accepted[0]).toEqual({
        sessionId: 'session-1',
        messageId: 'user-message-1',
        text: '[仅图片]',
        images: [image],
      })
      expect(h.context.userMessages[0]).toEqual({ text: '[仅图片]', images: [image] })
    })

    it('C2 检查点失败：不再装配工具清单、不发起模型调用，但已落库的用户消息保留', async () => {
      const h = createConversationHarness()
      h.facts.checkpointError = new Error('Cannot checkpoint a stale session')

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toEqual({
        status: 'failed', requestId: 'request-1', turnsUsed: 0, reason: 'session-persistence-failed',
      })
      expect(h.session.projection()).toMatchObject({ runState: 'failed', bubbleText: '[错误] 会话保存失败' })
      expect(h.facts.accepted).toHaveLength(1)
      expect(h.context.userMessages).toHaveLength(1)
      expect(h.catalog.contexts).toEqual([])
      expect(h.model.requests).toHaveLength(0)
    })

    it('§U 顺序：用户消息 → 检查点 → 工具调用落库 → 工具结果 → say 回执 → assistant 提交', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.events.slice(0, 6)).toEqual([
        'accept:user-message-1',
        'checkpoint:user-message-1',
        'toolCalls:request-1:0',
        'toolResult:action-1:succeeded',
        'toolResult:say-1:succeeded',
        'assistant:say',
      ])
    })
  })

  // ── G/H：工具批次 ─────────────────────────────────────

  describe('工具批次', () => {
    it('G4 文本兜底调用端到端：参数 JSON 化落库，剥离后的正文作为 visibleText', async () => {
      const h = createConversationHarness()
      h.catalog.textToolCalls = [{ id: 'text-call-1', name: 'read_file', arguments: { path: 'notes.txt' } }]
      h.catalog.strippedText = '好的，我来读。'
      h.model.enqueue({ type: 'done', text: 'read_file({"path":"notes.txt"})' })
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', turnsUsed: 2, fallbackUsed: false })
      expect(h.catalog.extracted).toEqual(['read_file({"path":"notes.txt"})'])
      expect(h.facts.recordedCalls[0]).toEqual({
        sessionId: 'session-1',
        stepId: 'request-1:0',
        visibleText: '好的，我来读。',
        calls: [{ id: 'text-call-1', name: 'read_file', arguments: { path: 'notes.txt' } }],
      })
      expect(h.toolExecution.executed.map(call => call.id)).toEqual(['text-call-1'])
    })

    it('H6 原生调用参数不是 JSON 时：落库保留原始文本，执行侧回执参数解析失败', async () => {
      const h = createConversationHarness()
      h.model.enqueue({
        type: 'tools',
        calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{oops' } }],
      })
      h.model.enqueue(sayTurn('say-1', { voice: 'よめない', display: '读不了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedCalls[0].calls[0]).toEqual({
        id: 'call-1', name: 'read_file', arguments: { _raw: '{oops', _invalid: true },
      })
      expect(h.facts.recordedResults[0]).toEqual({
        sessionId: 'session-1',
        callId: 'call-1',
        content: '参数解析失败',
        status: 'failed',
        code: 'INVALID_TOOL_ARGUMENTS',
      })
      // 参数没解析成功的调用不会进入执行器，但失败会算进本回合的失败计数。
      expect(h.toolExecution.executed).toEqual([])
      expect(result).toMatchObject({ status: 'success', partial: true, turnsUsed: 2 })
    })

    it('I12 工具活动按结果分类：成功、失败、用户跳过', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具执行失败: 读不了', ok: false, retryable: true }))
      h.toolExecution.results.set('list_dir', toolResult('list_dir', { content: '用户已拒绝文件操作，未执行。', ok: false, code: 'USER_REJECTED', retryable: false }))
      h.model.enqueue({
        type: 'tools',
        calls: [actionCall('read_file', 'action-1'), actionCall('list_dir', 'action-2'), actionCall('get_time', 'action-3')],
      })
      h.model.enqueue(sayTurn('say-1', { voice: 'おわった', display: '好了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.session.projection().toolActivities).toEqual([
        { id: 'action-1', name: 'read_file', status: 'error' },
        { id: 'action-2', name: 'list_dir', status: 'skipped' },
        { id: 'action-3', name: 'get_time', status: 'done' },
      ])
      // 前三条是动作工具的结果分类；第四条是 say 回执。
      expect(h.facts.recordedResults.slice(0, 3).map(item => item.status))
        .toEqual(['failed', 'rejected', 'succeeded'])
      expect(h.facts.recordedResults[3]).toMatchObject({ callId: 'say-1', content: '已说出', status: 'succeeded' })
    })

    it('H8 工具输出图片超量时丢弃多余图片，并在回执后追加说明', async () => {
      const h = createConversationHarness({ maxImageCount: 1 })
      h.toolExecution.results.set('screenshot', toolResult('screenshot', {
        images: [toolImage('img-1'), toolImage('img-2')],
      }))
      h.model.enqueue(actionTurn('screenshot', 'action-1'))
      h.model.enqueue(sayTurn('say-1', { voice: 'みた', display: '看到了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedResults[0].content).toBe(
        'screenshot 完成\n部分图片未附加：单轮最多 1 张且总计不超过 20MB。',
      )
      // 只有留下来的那张进模型上下文。
      expect(h.context.toolImageLog).toEqual([
        { toolCallIds: 'action-1', images: [toolImage('img-1')] },
      ])
    })

    it('H8 工具输出图片超体积时同样丢弃并追加说明', async () => {
      const h = createConversationHarness({ maxTotalImageBytes: 2 * 1024 * 1024 })
      h.toolExecution.results.set('screenshot', toolResult('screenshot', {
        images: [toolImage('img-1', 1024 * 1024), toolImage('img-2', 1024 * 1024), toolImage('img-3', 1024 * 1024)],
      }))
      h.model.enqueue(actionTurn('screenshot', 'action-1'))
      h.model.enqueue(sayTurn('say-1', { voice: 'みた', display: '看到了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedResults[0].content).toContain('部分图片未附加：单轮最多 4 张且总计不超过 2MB。')
      expect(h.context.toolImageLog[0].images.map(image => image.id)).toEqual(['img-1', 'img-2'])
    })

    it('L3 动作工具执行前的正文被丢弃：不进气泡，也不进 assistant 消息', async () => {
      const h = createConversationHarness()
      h.model.enqueue({ type: 'tools', calls: [actionCall('read_file', 'action-1')], text: '我先读一下。' })
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }))

      await h.session.send({ text: 'hi', images: [] })

      // 正文只作为协议消息的内容落库，不成为一条 assistant 回复。
      expect(h.facts.recordedCalls[0].visibleText).toBe('我先读一下。')
      expect(h.facts.assistantMessages.map(message => message.display)).toEqual(['读好了'])
      expect(h.session.projection().bubbleText).toBe('读好了')
    })

    it('I6 会话内允许跨回合保留：下一回合的工具直接带自动允许标记', async () => {
      const h = createConversationHarness()
      const policy = approvalPolicyOnlyFirstTime(['allow-session'])
      h.toolExecution.prepare = policy.prepare
      h.model.enqueue(sayTurn('say-1', { voice: 'おわった', display: '好了' }, [actionCall('read_file', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'おわった', display: '好了' }, [actionCall('read_file', 'action-2')]))

      const first = h.session.send({ text: '第一条', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())
      h.toolExecution.gateway.resolve('allow-session')
      await first

      const second = await h.session.send({ text: '第二条', images: [] })

      expect(second).toMatchObject({ status: 'success' })
      expect(h.toolExecution.executed.map(call => call.id)).toEqual(['action-1', 'action-2'])
      expect(h.toolExecution.contexts.map(context => context.sessionApproval)).toEqual([false, true])
      expect(h.toolExecution.sessionApprovals).toBe(1)
    })
  })

  // ── H3/I3：写入失败与执行中被取消 ───────────────────────

  describe('写入失败与执行中被取消', () => {
    it('H3 工具调用写入会话失败时整轮回退为错误，且未执行、未进模型上下文', async () => {
      const h = createConversationHarness()
      h.facts.toolCallsResult = false
      h.model.enqueue(actionTurn('read_file', 'action-1'))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'model-failure', turnsUsed: 1 })
      expect(h.session.projection()).toMatchObject({
        runState: 'failed',
        bubbleText: '[错误] 工具调用未能写入当前会话',
      })
      expect(h.toolExecution.executed).toEqual([])
      expect(h.context.toolCallLog).toEqual([])
    })

    it('H3 工具结果写入会话失败时整轮回退为错误，UI 活动状态先于持久化', async () => {
      const h = createConversationHarness()
      h.facts.toolResultResult = false
      h.model.enqueue(actionTurn('read_file', 'action-1'))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'failed', reason: 'model-failure' })
      expect(h.session.projection().bubbleText).toBe('[错误] 工具结果未能写入当前会话')
      // §U：endActivity 早于 commitToolResult，因此落库失败时活动已定稿。
      expect(h.session.projection().toolActivities).toEqual([
        { id: 'action-1', name: 'read_file', status: 'done' },
      ])
    })

    it('I3 执行中被取消时不再执行后续动作，工具结果也不落库', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      let prepared = false
      h.toolExecution.prepare = async call => { prepared = true; await gate.promise; return { call } }
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(prepared).toBe(true))
      expect(h.session.projection().runState).toBe('executing-tools')

      h.session.cancel('user-cancelled')
      gate.resolve()

      await expect(sending).resolves.toMatchObject({ status: 'cancelled', reason: 'user-cancelled' })
      // 回合的中止信号传到了工具执行上下文，动作因此不会再执行。
      expect(h.toolExecution.contexts[0].signal.aborted).toBe(true)
      // 工具执行端口此时给出的 EXECUTION_CANCELLED 回执不会再落库：失去投影权的那一刻
      // 回合就结束了，本模块的取消语义是「整轮终止」而不是「逐个工具标取消」。
      expect(h.toolExecution.executed).toEqual([])
      expect(h.facts.recordedResults).toEqual([])
    })

    it('J7 批准等待期间取消：等待被解除，工具不执行，回执不落库', async () => {
      const h = createConversationHarness()
      h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['allow']).prepare
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())

      h.session.cancel('user-cancelled')

      await expect(sending).resolves.toMatchObject({ status: 'cancelled', reason: 'user-cancelled' })
      expect(h.toolExecution.gateway.current()).toBeNull()
      expect(h.toolExecution.executed).toEqual([])
      expect(h.facts.recordedResults).toEqual([])
    })
  })

  // ── K：say 让位与内容兜底 ──────────────────────────────

  describe('say 让位与内容兜底', () => {
    it('K1 图片让位：同批读出图片时 say 被推迟，理由是「先观察图片」', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('screenshot', toolResult('screenshot', { images: [toolImage('img-1')] }))
      h.model.enqueue(sayTurn('say-1', { voice: 'みた', display: '看到了' }, [actionCall('screenshot', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'みた', display: '看到了' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedResults.find(item => item.callId === 'say-1')).toEqual({
        sessionId: 'session-1',
        callId: 'say-1',
        content: '未说出：需要先观察刚读取的图片，再生成最终答复。',
        status: 'rejected',
        code: 'SAY_DEFERRED',
      })
      expect(h.context.toolImageLog).toEqual([{ toolCallIds: 'action-1', images: [toolImage('img-1')] }])
      // 让位 = 进入下一轮，消耗一次轮次预算；最终交付的是下一轮的回复。
      expect(result).toMatchObject({ status: 'success', turnsUsed: 2, partial: false })
      expect(h.facts.assistantMessages.map(message => message.display)).toEqual(['看到了'])
    })

    it('K1 优先级：既有失败又有图片时，取「先处理工具失败结果」', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具执行失败: 读不了', ok: false }))
      h.toolExecution.results.set('screenshot', toolResult('screenshot', { images: [toolImage('img-1')] }))
      h.model.enqueue(sayTurn('say-1', { voice: 'みた', display: '看到了' }, [
        actionCall('read_file', 'action-1'),
        actionCall('screenshot', 'action-2'),
      ]))
      h.model.enqueue(sayTurn('say-2', { voice: 'みた', display: '看到了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedResults.find(item => item.callId === 'say-1')?.content)
        .toBe('未说出：需要先读取并处理刚才的工具失败结果，再生成最终答复。')
    })

    it('K1 优先级：只有用户跳过时，取「先处理用户跳过该操作的结果」', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', toolResult('read_file', {
        content: '用户已拒绝文件操作，未执行。', ok: false, code: 'USER_REJECTED', retryable: false,
      }))
      h.model.enqueue(sayTurn('say-1', { voice: 'やめた', display: '那算了' }, [actionCall('read_file', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'やめた', display: '那算了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.facts.recordedResults.find(item => item.callId === 'say-1')?.content)
        .toBe('未说出：需要先读取并处理用户跳过该操作的结果，再生成最终答复。')
      // 用户跳过不计入失败计数，因此整回合不算 partial。
      expect(h.session.projection().bubbleText).toBe('那算了')
    })

    it("K1 'continue' 语义：让位消耗一次轮次预算，上限为 1 时直接落到轮次上限", async () => {
      const h = createConversationHarness({ maxToolTurns: 1 })
      h.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具执行失败: 读不了', ok: false }))
      h.model.enqueue(sayTurn('say-1', { voice: 'よめない', display: '读不了' }, [actionCall('read_file', 'action-1')]))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toEqual({ status: 'turn-limit', requestId: 'request-1', turnsUsed: 1 })
      expect(h.session.projection().bubbleText).toBe('[没有可交付的回复]')
    })

    it('K3 语言相同时 say 只有 voice：voice 直接当预览与显示文本', async () => {
      const h = createConversationHarness()
      h.character.value = { ...h.character.value, voiceLanguage: 'ja-JP', displayLanguage: 'ja-JP' }
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success', partial: false })
      expect(h.facts.assistantMessages[0]).toMatchObject({
        display: 'こんにちは', voice: 'こんにちは', source: 'say',
      })
      expect(h.session.projection().bubbleText).toBe('こんにちは')
    })

    it('K5 语言不同且 say 只有 display：预览已交付，语音在后台由显示文本补出', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { display: '你好' }))

      const result = await h.session.send({ text: 'hi', images: [] })

      expect(result).toMatchObject({ status: 'success' })
      expect(h.facts.assistantMessages[0]).toMatchObject({ display: '你好', source: 'say' })
      await vi.waitFor(() => expect(h.voice.played).toHaveLength(1))
      expect(h.voice.played[0]).toMatchObject({ text: 'ja-JP:你好', voiceLanguage: 'ja-JP' })
      expect(h.facts.revisions[0]).toMatchObject({ messageId: 'assistant-message-1', playbackText: 'ja-JP:你好' })
    })
  })

  // ── N：取消的三种触发 ──────────────────────────────────

  describe('取消的三种触发', () => {
    it('N2 会话切换：进行中的回合终止，投影与语音一起收口', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: '迟到的回复' }
      })
      const sending = h.session.send({ text: '写点什么', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))

      h.facts.sessionId = 'session-2'
      h.session.cancel('session-changed')
      gate.resolve()

      await expect(sending).resolves.toEqual({
        status: 'cancelled', requestId: 'request-1', turnsUsed: 1, reason: 'session-changed',
      })
      expect(h.session.projection()).toMatchObject({
        runState: 'cancelled', bubbleText: '', typing: false, thinking: '', autoExecSession: false,
      })
      expect(h.voice.cancelled).toContainEqual({ reason: 'session-changed', resetDedupe: true })
      // 迟到的模型输出不再产生回复。
      expect(h.facts.assistantMessages).toHaveLength(0)
    })

    it('N4 角色切换（context-reset）：进行中的回合被干净终止，迟到的输出不再写进气泡', async () => {
      const h = createConversationHarness()
      const gate = deferred()
      h.model.enqueue(async () => {
        await gate.promise
        return { type: 'done', text: '迟到的回复' }
      })
      const sending = h.session.send({ text: '写点什么', images: [] })
      await vi.waitFor(() => expect(h.model.requests).toHaveLength(1))

      h.session.cancel('context-reset')
      gate.resolve()

      await expect(sending).resolves.toMatchObject({ status: 'cancelled', reason: 'context-reset' })
      expect(h.session.projection()).toMatchObject({
        runState: 'cancelled', bubbleText: '', thinking: '', autoExecSession: false,
      })
      expect(h.voice.cancelled).toContainEqual({ reason: 'context-reset', resetDedupe: true })
      expect(h.facts.assistantMessages).toHaveLength(0)
    })

    it('N4/O11 角色切换前正在准备的后台语音一并作废：不再回填、不再播放', async () => {
      const h = createConversationHarness()
      const voice = gatedVoiceTranslation(h)
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })
      expect(voice.signal()?.aborted).toBe(false)

      h.session.cancel('context-reset')

      expect(voice.signal()?.aborted).toBe(true)
      voice.gate.resolve()
      await flushPending()

      expect(h.facts.revisions).toHaveLength(0)
      expect(h.voice.played).toHaveLength(0)
    })

    it('N3/O11 被新回合顶替：旧回合的后台语音准备作废，播放不串台', async () => {
      const h = createConversationHarness()
      const voice = gatedVoiceTranslation(h)
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: '第一条', images: [] })
      expect(voice.signal()?.aborted).toBe(false)

      h.session.cancel('user-cancelled')
      h.model.enqueue(sayTurn('say-2', { voice: 'やあ', display: '嗨' }))
      await h.session.send({ text: '第二条', images: [] })

      expect(voice.signal()?.aborted).toBe(true)
      voice.gate.resolve()
      await flushPending()

      expect(h.voice.played.map(request => request.text)).toEqual(['やあ'])
      expect(h.facts.revisions.map(revision => revision.messageId)).not.toContain('assistant-message-1')
    })

    it('空闲时取消是安全的：不制造终态，只清投影与语音', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.voice.played).toHaveLength(1))

      h.session.cancel()

      // 最后一个终态回合仍是「当前回合」，直到下一次 send。
      expect(h.session.projection()).toMatchObject({
        runId: 'request-1', runState: 'completed', bubbleText: '', typing: false, thinking: '',
      })
    })
  })

  // ── O：后台语音的边界 ──────────────────────────────────

  describe('后台语音的边界', () => {
    it('O5 语音准备期间会话已换走：不回填、不播放', async () => {
      const h = createConversationHarness()
      const voice = gatedVoiceTranslation(h)
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })

      h.facts.sessionId = 'session-2'
      voice.gate.resolve()
      await flushPending()

      expect(h.facts.revisions).toHaveLength(0)
      expect(h.voice.played).toHaveLength(0)
    })

    it('O6 语音准备期间消息已不在：不回填、不播放', async () => {
      const h = createConversationHarness()
      const voice = gatedVoiceTranslation(h)
      h.facts.reviseResult = false
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))
      await h.session.send({ text: 'hi', images: [] })

      voice.gate.resolve()
      await flushPending()

      expect(h.facts.revisions).toHaveLength(1)
      expect(h.voice.played).toHaveLength(0)
    })

    it('O9 后台语音的翻译失败：不播放，也不影响已经交付的文字回复', async () => {
      const h = createConversationHarness()
      h.translate.handler = async () => { throw new Error('翻译服务不可用') }
      h.model.enqueue(sayTurn('say-1', { voice: UNRESOLVED_VOICE, display: '你好' }))

      const result = await h.session.send({ text: 'hi', images: [] })
      await flushPending()

      expect(result).toMatchObject({ status: 'success' })
      expect(h.facts.assistantMessages[0]).toMatchObject({ display: '你好' })
      expect(h.session.projection().bubbleText).toBe('你好')
      expect(h.facts.revisions).toHaveLength(0)
      expect(h.voice.played).toHaveLength(0)
    })

    it('O1/O8 语音是提交之后的独立副作用：清洗后为空的 voice 由显示文本补出再播放', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: '   ', display: '你好' }))

      await h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.voice.played).toHaveLength(1))

      expect(h.voice.played[0]).toMatchObject({
        requestId: 'request-1', text: 'ja-JP:你好', voiceId: 'voice-1', voiceLanguage: 'ja-JP',
      })
      // 播放永远发生在 assistant 消息提交之后。
      expect(h.facts.events.indexOf('assistant:say'))
        .toBeLessThan(h.facts.events.indexOf('revise:assistant-message-1'))
    })
  })

  // ── 投影的关键节点 ────────────────────────────────────

  describe('投影的关键节点', () => {
    it('等待批准时：活动显示为「执行中」', async () => {
      const h = createConversationHarness()
      h.toolExecution.prepare = approvalPolicyOnlyFirstTime(['allow']).prepare
      const states: string[] = []
      h.session.subscribe(projection => { states.push(projection.runState) })
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))

      const sending = h.session.send({ text: 'hi', images: [] })
      await vi.waitFor(() => expect(h.toolExecution.gateway.current()).not.toBeNull())

      expect(h.session.projection().runState).toBe('executing-tools')
      expect(h.session.projection().toolActivities).toEqual([
        { id: 'action-1', name: 'read_file', status: 'running' },
      ])
      // ⚠ 已记录的实现缺陷（不在本工单修复）：批准等待期间回合没有进入 'awaiting-approval'。
      // ConversationRun 允许该转移，旧 store 也由批准网关的订阅驱动它，但 ConversationSession
      // 没有订阅批准网关，投影因此一直停在 'executing-tools'。这里断言的是当前真实行为。
      expect(states).not.toContain('awaiting-approval')

      h.toolExecution.gateway.resolve('allow')
      await expect(sending).resolves.toMatchObject({ status: 'success' })
      expect(h.session.projection()).toMatchObject({ runState: 'completed' })
      expect(h.session.projection().toolActivities).toEqual([
        { id: 'action-1', name: 'read_file', status: 'done' },
      ])
    })

    it('D2/D3 流式投影：思考与正文分别落到对应字段，think 不泄漏进气泡', async () => {
      const h = createConversationHarness()
      const seen: { bubbleText: string; typing: boolean; thinking: string }[] = []
      h.session.subscribe(projection => {
        seen.push({ bubbleText: projection.bubbleText, typing: projection.typing, thinking: projection.thinking })
      })
      h.model.enqueue(request => {
        request.onThinking('先想一下')
        request.onChunk('你')
        request.onChunk('好')
        return sayTurn('say-1', { voice: 'こんにちは', display: '你好' })
      })

      await h.session.send({ text: 'hi', images: [] })

      expect(seen).toContainEqual({ bubbleText: '你', typing: true, thinking: '先想一下' })
      expect(seen).toContainEqual({ bubbleText: '你好', typing: true, thinking: '先想一下' })
      expect(seen.every(item => !item.bubbleText.includes('先想一下'))).toBe(true)
    })

    it('D8 say 参数的流式预览早于工具调用完成就进入气泡', async () => {
      const h = createConversationHarness()
      const seen: string[] = []
      h.session.subscribe(projection => { seen.push(projection.bubbleText) })
      h.model.enqueue(request => {
        request.onToolCallDelta([{
          id: 'say-1',
          type: 'function',
          function: { name: 'say', arguments: '{"display":"你' },
        }])
        return sayTurn('say-1', { voice: 'こんにちは', display: '你好' })
      })

      await h.session.send({ text: 'hi', images: [] })

      expect(seen).toContain('你')
      expect(seen[seen.length - 1]).toBe('你好')
    })

    it('终态投影：runId 与 revision 保留到下一个回合启动', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

      await h.session.send({ text: '第一条', images: [] })

      const completed = h.session.projection()
      expect(completed).toMatchObject({ runId: 'request-1', runState: 'completed' })
      expect(completed.revision).toBeGreaterThan(0)

      h.model.enqueue(sayTurn('say-2', { voice: 'やあ', display: '嗨' }))
      await h.session.send({ text: '第二条', images: [] })

      const next = h.session.projection()
      expect(next).toMatchObject({ runId: 'request-2', runState: 'completed' })
      expect(next.revision).toBeGreaterThan(0)
    })

    it('Q1 投影的上下文统计每次都现取', async () => {
      const h = createConversationHarness()
      expect(h.session.projection().context.messageCount).toBe(0)

      h.context.statsValue = { ...h.context.statsValue, messageCount: 5 }

      expect(h.session.projection().context.messageCount).toBe(5)
    })
  })

  // ── 返回值与终态分类 ──────────────────────────────────

  describe('返回值与终态分类', () => {
    it('R1 success 与 partial_success 只在有没有工具失败上不同', async () => {
      const clean = createConversationHarness()
      clean.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))
      await expect(clean.session.send({ text: 'hi', images: [] }))
        .resolves.toMatchObject({ status: 'success', partial: false })

      const partial = createConversationHarness()
      partial.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具失败', ok: false }))
      partial.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))
      partial.model.enqueue(sayTurn('say-2', { voice: 'よんだ', display: '读好了' }))
      await expect(partial.session.send({ text: 'hi', images: [] }))
        .resolves.toMatchObject({ status: 'success', partial: true, turnsUsed: 2 })
    })

    it('R3 工具失败只进回执与活动列表，不上抛到错误气泡', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具执行失败: 读不了', ok: false }))
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(sayTurn('say-1', { voice: 'よめない', display: '读不了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(h.session.projection().bubbleText).toBe('读不了')
      expect(h.session.projection().bubbleText).not.toContain('[错误]')
    })
  })

  // ── P：遥测 ───────────────────────────────────────────

  describe('遥测', () => {
    let entries: LogEntry[]
    let unsubscribeLogger: () => void

    /**
     * 遥测是日志本身，不是从日志推断出来的状态：这里订阅结构化日志流，
     * 只挑出遥测事件比对它携带的字段，不去读缓冲区推断回合内部发生了什么。
     */
    beforeEach(() => {
      entries = []
      unsubscribeLogger = subscribe(entry => { entries.push(entry) })
    })

    afterEach(() => { unsubscribeLogger() })

    function telemetry(event: string): LogEntry[] {
      return entries.filter(entry => entry.event === event)
    }

    it('P8 起始遥测带上请求 id、文本长度、图片数与模型标识', async () => {
      const h = createConversationHarness()
      const image: ConversationImage = { id: 'img-1', name: 'a.png', mimeType: 'image/png', size: 10, dataUrl: 'data:,' }
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

      await h.session.send({ text: '你好', images: [image] })

      expect(telemetry('chat.request_started')).toEqual([
        expect.objectContaining({
          level: 'info',
          context: { requestId: 'request-1', textLength: 2, imageCount: 1, model: 'fake-model' },
        }),
      ])
    })

    it('P7 成功交付时的字段齐全，且以 info 记录', async () => {
      const h = createConversationHarness()
      h.model.enqueue(sayTurn('say-1', { voice: 'こんにちは', display: '你好' }))

      await h.session.send({ text: 'hi', images: [] })

      const record = telemetry('chat.request_completed')[0]
      expect(record.level).toBe('info')
      expect(record.context).toMatchObject({
        requestId: 'request-1',
        completionStatus: 'success',
        failed: false,
        cancelled: false,
        turnsUsed: 1,
        toolTurnLimit: 50,
        toolDefinitionCount: 2,
        toolDefinitionTokens: 7,
        modelCallCount: 1,
        toolCallCount: 0,
        toolFailureCount: 0,
        fallbackUsed: false,
        ttsStatus: 'pending',
        terminalReason: 'completed',
      })
      expect(record.context?.durationMs).toEqual(expect.any(Number))
    })

    it('P7 工具失败但仍有输出时记为 partial_success，并统计模型与工具调用次数', async () => {
      const h = createConversationHarness()
      h.toolExecution.results.set('read_file', toolResult('read_file', { content: '工具执行失败: 读不了', ok: false }))
      h.model.enqueue(sayTurn('say-1', { voice: 'よんだ', display: '读好了' }, [actionCall('read_file', 'action-1')]))
      h.model.enqueue(sayTurn('say-2', { voice: 'よんだ', display: '读好了' }))

      await h.session.send({ text: 'hi', images: [] })

      expect(telemetry('chat.request_completed')[0].context).toMatchObject({
        completionStatus: 'partial_success',
        failed: false,
        cancelled: false,
        turnsUsed: 2,
        modelCallCount: 2,
        toolCallCount: 1,
        toolFailureCount: 1,
        fallbackUsed: false,
        terminalReason: 'completed',
      })
    })

    it('P7 文本兜底路径把 fallbackUsed 记进遥测', async () => {
      const h = createConversationHarness()
      h.model.enqueue({ type: 'done', text: '喵' })

      await h.session.send({ text: 'hi', images: [] })

      expect(telemetry('chat.request_completed')[0].context).toMatchObject({
        completionStatus: 'success', fallbackUsed: true, ttsStatus: 'pending',
      })
    })

    it('P7 取消时完成状态与终态原因都是 cancelled，且以 info 记录', async () => {
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
      await sending

      const record = telemetry('chat.request_completed')[0]
      expect(record.level).toBe('info')
      expect(record.context).toMatchObject({
        completionStatus: 'cancelled', failed: false, cancelled: true, terminalReason: 'cancelled',
      })
    })

    it('P7 模型失败时以 error 级别记录，并带上具体终态原因', async () => {
      const h = createConversationHarness()
      h.model.enqueue(() => { throw new Error('上游 500') })

      await h.session.send({ text: 'hi', images: [] })

      const record = telemetry('chat.request_completed')[0]
      expect(record.level).toBe('error')
      expect(record.context).toMatchObject({
        completionStatus: 'failed', failed: true, cancelled: false, terminalReason: 'error', turnsUsed: 1,
      })
      expect(String((record.error as { message?: string } | undefined)?.message)).toBe('对话请求失败')
    })

    it('P7 触达轮次上限时遥测记为 failed / tool_turn_limit，且没有请求语音', async () => {
      const h = createConversationHarness({ maxToolTurns: 2 })
      h.model.enqueue(actionTurn('read_file', 'action-1'))
      h.model.enqueue(actionTurn('read_file', 'action-2'))

      await h.session.send({ text: 'hi', images: [] })

      expect(telemetry('chat.request_completed')[0].context).toMatchObject({
        completionStatus: 'failed',
        terminalReason: 'tool_turn_limit',
        turnsUsed: 2,
        toolTurnLimit: 2,
        ttsStatus: 'not_requested',
      })
    })
  })
})
