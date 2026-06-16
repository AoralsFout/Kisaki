/**
 * Chat Store 核心逻辑单元测试
 *
 * 覆盖：
 * - splitSayCalls / parseSayArgs / resolveSayContent / resolveContentFallback —— say 机制
 * - addMessage / clearMessages / resetContext 消息管理
 * - showBubbleText / hideBubble 气泡控制
 * - toggleInput / openInput / closeInput 输入框控制
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// 所有使用 useChatStore 的测试前都需要激活 Pinia
beforeEach(() => {
  setActivePinia(createPinia())
})

// ─── say 工具调用拆分 / 解析 / 兜底 ──────────────────────────

/** 构造一个 OpenAI 风格的工具调用 */
function toolCall(name: string, args: string, id = name) {
  return { id, type: 'function' as const, function: { name, arguments: args } }
}

/** 翻译桩：把目标语言代码作为前缀返回，便于断言"是否/向哪种语言调用了翻译" */
const fakeTranslate = async (text: string, target: string) => `[${target}]${text}`

describe('splitSayCalls', () => {
  it('分出 say 与动作调用', async () => {
    const { splitSayCalls } = await import('../chat')
    const calls = [
      toolCall('set_character_emotion', '{"emotion":"开心"}'),
      toolCall('say', '{"voice":"やあ","display":"嗨"}'),
    ]
    const { sayCall, actionCalls } = splitSayCalls(calls)
    expect(sayCall?.function.name).toBe('say')
    expect(actionCalls).toHaveLength(1)
    expect(actionCalls[0].function.name).toBe('set_character_emotion')
  })

  it('多个 say 只取第一个，其余忽略', async () => {
    const { splitSayCalls } = await import('../chat')
    const calls = [toolCall('say', '{"voice":"1"}', 's1'), toolCall('say', '{"voice":"2"}', 's2')]
    const { sayCall, actionCalls } = splitSayCalls(calls)
    expect(sayCall?.id).toBe('s1')
    expect(actionCalls).toHaveLength(0)
  })

  it('无 say 时 sayCall 为 null', async () => {
    const { splitSayCalls } = await import('../chat')
    const { sayCall, actionCalls } = splitSayCalls([toolCall('get_time', '{}')])
    expect(sayCall).toBeNull()
    expect(actionCalls).toHaveLength(1)
  })
})

describe('parseSayArgs', () => {
  it('解析 voice 与 display', async () => {
    const { parseSayArgs } = await import('../chat')
    expect(parseSayArgs('{"voice":"こんにちは","display":"你好"}')).toEqual({ voice: 'こんにちは', display: '你好' })
  })

  it('缺失字段返回 undefined', async () => {
    const { parseSayArgs } = await import('../chat')
    expect(parseSayArgs('{"voice":"あ"}')).toEqual({ voice: 'あ', display: undefined })
  })

  it('非法 JSON 返回空对象', async () => {
    const { parseSayArgs } = await import('../chat')
    expect(parseSayArgs('not json')).toEqual({})
  })

  it('两端空白被裁剪', async () => {
    const { parseSayArgs } = await import('../chat')
    expect(parseSayArgs('{"voice":"  あ  "}')).toEqual({ voice: 'あ', display: undefined })
  })
})

describe('resolveSayContent', () => {
  it('两者齐全：不调翻译', async () => {
    const { resolveSayContent } = await import('../chat')
    const r = await resolveSayContent({ voice: 'やあ', display: '嗨' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: 'やあ', display: '嗨' })
  })

  it('缺 display：翻译 voice 补出', async () => {
    const { resolveSayContent } = await import('../chat')
    const r = await resolveSayContent({ voice: 'やあ' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: 'やあ', display: '[zh-CN]やあ' })
  })

  it('缺 voice：翻译 display 补出', async () => {
    const { resolveSayContent } = await import('../chat')
    const r = await resolveSayContent({ display: '嗨' }, 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '[ja-JP]嗨', display: '嗨' })
  })

  it('语言相同：互为兜底，不调翻译', async () => {
    const { resolveSayContent } = await import('../chat')
    const r = await resolveSayContent({ voice: '你好' }, 'zh-CN', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '你好', display: '你好' })
  })
})

describe('resolveContentFallback', () => {
  it('语言不同：正文当 display，翻译出 voice', async () => {
    const { resolveContentFallback } = await import('../chat')
    const r = await resolveContentFallback('你好呀', 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '[ja-JP]你好呀', display: '你好呀' })
  })

  it('语言相同：voice=display=正文', async () => {
    const { resolveContentFallback } = await import('../chat')
    const r = await resolveContentFallback('你好', 'zh-CN', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '你好', display: '你好' })
  })

  it('空正文返回空', async () => {
    const { resolveContentFallback } = await import('../chat')
    const r = await resolveContentFallback('   ', 'ja-JP', 'zh-CN', fakeTranslate)
    expect(r).toEqual({ voice: '', display: '' })
  })
})

// ─── Pinia Store 基础操作 ─────────────────────────────

describe('ChatStore - 消息管理', () => {
  beforeEach(async () => {
    // 每次测试前重置
  })

  it('addMessage 添加用户消息', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.addMessage('user', '测试消息')
    expect(store.messages.length).toBe(1)
    expect(store.messages[0].role).toBe('user')
    expect(store.messages[0].text).toBe('测试消息')
  })

  it('addMessage 添加助手消息带思考内容', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.addMessage('assistant', '回复内容', '思考过程')
    expect(store.messages.length).toBe(1)
    expect(store.messages[0].role).toBe('assistant')
    expect(store.messages[0].text).toBe('回复内容')
    expect(store.messages[0].thinking).toBe('思考过程')
  })

  it('clearMessages 清空所有消息', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.addMessage('user', '消息1')
    store.addMessage('assistant', '回复1')
    expect(store.messages.length).toBe(2)

    store.clearMessages()
    expect(store.messages.length).toBe(0)
  })

  it('resetContext 重置上下文', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.addMessage('user', '消息1')
    store.resetContext()
    // resetContext 只重置 ChatContext，不清除 messages
    expect(store.messages.length).toBe(1)
  })

  it('消息包含 id 和 timestamp', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.addMessage('user', '测试')

    const msg = store.messages[0]
    expect(msg).toHaveProperty('id')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
    expect(msg).toHaveProperty('timestamp')
    expect(typeof msg.timestamp).toBe('number')
  })
})

describe('ChatStore - 气泡控制', () => {
  it('showBubbleText 设置气泡内容', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.showBubbleText('你好！')
    expect(store.showBubble).toBe(true)
    expect(store.currentBubbleText).toBe('你好！')
    expect(store.isTyping).toBe(true) // 默认 true
  })

  it('showBubbleText 支持关闭打字指示器', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.showBubbleText('错误消息', false)
    expect(store.isTyping).toBe(false)
  })

  it('hideBubble 隐藏气泡', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.showBubbleText('显示')
    store.hideBubble()
    expect(store.showBubble).toBe(false)
    expect(store.currentBubbleText).toBe('')
    expect(store.isTyping).toBe(false)
  })
})

describe('ChatStore - 输入框控制', () => {
  it('toggleInput 切换输入框状态', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()

    expect(store.showInput).toBe(false)
    store.toggleInput()
    expect(store.showInput).toBe(true)
    store.toggleInput()
    expect(store.showInput).toBe(false)
  })

  it('openInput 打开输入框', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.openInput()
    expect(store.showInput).toBe(true)
  })

  it('closeInput 关闭输入框', async () => {
    const { useChatStore } = await import('../chat')
    const store = useChatStore()
    store.openInput()
    store.closeInput()
    expect(store.showInput).toBe(false)
  })
})
