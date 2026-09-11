/**
 * 组合根集成测试。
 *
 * 只证明两件事：组合根装配出的对话回合真的可用；缺装配时立刻失败，
 * 而不是静默空转（spec user story 26）。逐轮行为由 conversationSession.test.ts 与 #19 负责。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SAY_TOOL_NAME } from './agent'
import { ConversationSession, type ConversationSessionPorts } from './application/conversation/conversationSession'
import type { ConversationModelClient } from './application/conversation/conversationSession'
import type { ConversationVoiceRequest } from './application/conversation/conversationSession'
import type { ProtocolToolCall } from './application/conversation/toolCallBatch'
import { composeApplication, composeConversationAssembly, conversationAssembly } from './compositionRoot'
import { useSessionStore } from './stores/session'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

/** 11 个端口的名字，与 ConversationSessionPorts 的键一一对应。 */
const PORT_NAMES: readonly (keyof ConversationSessionPorts)[] = [
  'model',
  'translate',
  'character',
  'context',
  'session',
  'tools',
  'toolExecution',
  'voice',
  'clock',
  'network',
  'texts',
]

/** 一条 say 回合的脚本化模型：不碰网络，只回一个 say 调用。 */
function scriptedModel(): ConversationModelClient {
  const call: ProtocolToolCall = {
    id: 'say-1',
    type: 'function',
    function: {
      name: SAY_TOOL_NAME,
      arguments: JSON.stringify({ voice: 'hello', display: 'hello' }),
    },
  }
  return {
    configuration: () => ({ ready: true, model: 'composition-test' }),
    call: async () => ({ type: 'tools', calls: [call] }),
  }
}

describe('组合根装配', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    invokeMock.mockReset()
    invokeMock.mockImplementation((command: string) => {
      if (command === 'sessions_v2_load') return Promise.resolve(null)
      return Promise.resolve()
    })
    await composeApplication()
  })

  it('装配出 11 个端口的对话回合，缺一不可', () => {
    const assembly = conversationAssembly()

    expect(Object.keys(assembly.ports).sort()).toEqual([...PORT_NAMES].sort())
    expect(assembly.session).toBeInstanceOf(ConversationSession)
    for (const name of PORT_NAMES) expect(assembly.ports[name]).toBeTruthy()
  })

  it('缺任一端口时构造立刻失败，并点出缺的是哪个', () => {
    const complete = conversationAssembly().ports

    for (const name of PORT_NAMES) {
      const incomplete: Record<string, unknown> = { ...complete }
      delete incomplete[name]
      expect(() => new ConversationSession(incomplete as unknown as ConversationSessionPorts))
        .toThrowError(`ConversationSession 缺少端口：${name}`)
    }
  })

  it('端口在但少一个方法时同样失败，不会静默空转', () => {
    const complete = conversationAssembly().ports
    // 走原型链：适配器的方法长在原型上，展开赋值会连其余方法一起丢掉。
    const textsWithoutError = Object.create(complete.texts) as Record<string, unknown>
    textsWithoutError.error = undefined

    expect(() => new ConversationSession(
      { ...complete, texts: textsWithoutError } as unknown as ConversationSessionPorts,
    )).toThrowError('缺少方法：error()')
  })

  it('装配出的对话回合可用：一条 say 回合走完并落进当前会话', async () => {
    const played: ConversationVoiceRequest[] = []
    const assembly = await composeConversationAssembly({
      model: scriptedModel(),
      translate: { translate: async text => text },
      voice: { play: request => played.push(request), cancel: () => {} },
    })
    await useSessionStore().init()

    const result = await assembly.session.send({ text: '你好', images: [] })

    expect(result.status).toBe('success')
    expect(useSessionStore().currentSession?.messages.map(message => message.text))
      .toEqual(['你好', 'hello'])
    expect(invokeMock).toHaveBeenCalledWith('sessions_v2_save', expect.anything())
    // 语音订阅接在装配好的 voice 端口上：回复提交之后的独立副作用，不阻塞回合，
    // 因此它在 send() 返回之后才落地。
    await vi.waitFor(() => expect(played.map(request => request.text)).toEqual(['hello']))
  })
})
