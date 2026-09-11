/**
 * Chat Store 核心逻辑单元测试
 *
 * 覆盖：
 * - addMessage / clearMessages / resetContext 消息管理
 * - showBubbleText / hideBubble 气泡控制
 * - toggleInput / openInput / closeInput 输入框控制
 *
 * say 机制的纯函数（`parseSayArgs` / `resolveSayContent` / `resolveContentFallback` 等）
 * 随回合编排搬到了 `src/application/conversation/`，断言随之搬到那边各自的测试文件；
 * 本文件不再经 store 的再导出读它们。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { composeApplication } from '../../compositionRoot'

// 所有使用 useChatStore 的测试前都需要激活 Pinia。
// store 已退化为投影 + 命令转发，命令要经组合根装配出的对话对象图；
// 装配是幂等的，只有第一次真正构建对象图。
beforeEach(async () => {
  setActivePinia(createPinia())
  await composeApplication()
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

  it('assistant 消息记录角色身份快照；无身份来源或 user 消息不记录', async () => {
    const { useChatStore, setChatCharacterIdentity } = await import('../chat')
    setChatCharacterIdentity(() => ({ id: 'kisaki', name: 'Kisaki' }))
    const store = useChatStore()
    store.addMessage('assistant', '回复1')
    expect(store.messages[0].charId).toBe('kisaki')
    expect(store.messages[0].charName).toBe('Kisaki')

    // 身份来源返回 null（如角色未加载）：字段缺省，界面回退展示
    setChatCharacterIdentity(() => null)
    store.addMessage('assistant', '回复2')
    expect(store.messages[1].charId).toBeUndefined()
    expect(store.messages[1].charName).toBeUndefined()

    // user 消息不记录身份快照
    store.addMessage('user', '提问')
    expect(store.messages[2].charId).toBeUndefined()
    expect(store.messages[2].charName).toBeUndefined()

    setChatCharacterIdentity(() => null)
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
