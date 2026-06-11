/**
 * Chat Store 核心逻辑单元测试
 *
 * 覆盖：
 * - parseBilingualResponse 双语解析
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

// ─── parseBilingualResponse ──────────────────────────

describe('parseBilingualResponse', () => {
  it('解析完整的双语回复', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】こんにちは\n【译文】你好')
    expect(result.nativeText).toBe('こんにちは')
    expect(result.displayText).toBe('你好')
  })

  it('解析带空行的双语回复', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】おはようございます\n\n【译文】早上好')
    expect(result.nativeText).toBe('おはようございます')
    expect(result.displayText).toBe('早上好')
  })

  it('仅有【译文】标签时解析为 nativeText（因【译文】匹配 NATIVE_RE 通用标签模式）', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【译文】早上好')
    // 【译文】匹配通用标签模式，所以 nativeText 有值，displayText 也被提取
    expect(result.nativeText).toBe('早上好')
    expect(result.displayText).toBe('早上好')
  })

  it('仅有【语言】标签时回退为整段文本', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】こんにちは')
    // 没有【译文】标签，displayMatch 为 null，回退为整段文本
    expect(result.nativeText).toBe('【日语】こんにちは')
    expect(result.displayText).toBe('【日语】こんにちは')
  })

  it('双语标签内容为空时回退', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】\n【译文】')
    expect(result.nativeText).toBe('【日语】\n【译文】')
    expect(result.displayText).toBe('【日语】\n【译文】')
  })

  it('无任何标签时返回整段文本', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('这是一段普通的文本回复')
    expect(result.nativeText).toBe('这是一段普通的文本回复')
    expect(result.displayText).toBe('这是一段普通的文本回复')
  })

  it('空字符串', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('')
    expect(result.nativeText).toBe('')
    expect(result.displayText).toBe('')
  })

  it('多语言标签（非日语）', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【英语】Hello\n【译文】你好')
    expect(result.nativeText).toBe('Hello')
    expect(result.displayText).toBe('你好')
  })

  it('双语内容包含标点和特殊字符', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】今日は良い天気ですね！☀️\n【译文】今天天气真好！☀️')
    expect(result.nativeText).toBe('今日は良い天気ですね！☀️')
    expect(result.displayText).toBe('今天天气真好！☀️')
  })

  it('多行双语内容', async () => {
    const { parseBilingualResponse } = await import('../chat')
    const result = parseBilingualResponse('【日语】こんにちは。\nお元気ですか？\n【译文】你好。\n你好吗？')
    expect(result.nativeText).toBe('こんにちは。\nお元気ですか？')
    expect(result.displayText).toBe('你好。\n你好吗？')
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
