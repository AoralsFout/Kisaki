/**
 * 会话管理 Store 单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from '../session'
import { useChatStore } from '../chat'
import type { ChatMessage } from '../chat'

// 模拟 localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  it('首次启动时自动创建默认会话', async () => {
    const store = useSessionStore()
    expect(store.ready).toBe(false)
    await store.init()
    expect(store.ready).toBe(true)
    expect(store.sessionList).toHaveLength(1)
    expect(store.currentSession).not.toBeNull()
    expect(store.currentSession!.name).toBe('新对话')
    expect(store.currentSession!.messages).toEqual([])
  })

  it('本地存储写入失败时置 persistError 并记录日志', async () => {
    const store = useSessionStore()
    await store.init()
    expect(store.persistError).toBe(false)

    // 模拟配额耗尽：setItem 抛 QuotaExceededError
    const originalSetItem = localStorageMock.setItem.getMockImplementation()
    localStorageMock.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    store.createSession()

    expect(store.persistError).toBe(true)
    localStorageMock.setItem.mockImplementation(originalSetItem!)
  })

  it('可以创建新会话', async () => {
    const store = useSessionStore()
    await store.init()

    const s = store.createSession()
    expect(store.sessionList).toHaveLength(2)
    expect(s.name).toBe('新对话 2')
    expect(s.messages).toEqual([])
  })

  it('可以创建指定名称的会话', async () => {
    const store = useSessionStore()
    await store.init()

    store.createSession('工作记录')
    const named = store.getSessionById(
      store.sessionList.find(s => s.name === '工作记录')!.id,
    )
    expect(named).not.toBeNull()
    expect(named!.name).toBe('工作记录')
  })

  it('切换会话时保存当前消息并加载目标消息', async () => {
    const store = useSessionStore()
    await store.init()

    const chat = useChatStore()
    chat.loadMessages([
      { id: '1', role: 'user', text: '你好', timestamp: Date.now() },
    ])
    // 手动保存（loadMessages 仅加载到 ChatStore，需主动持久化）
    store.saveCurrentSession()

    // 确保当前会话有消息
    expect(store.currentSession!.messages).toHaveLength(1)

    // 创建新会话
    const s2 = store.createSession('新会话 2')
    // 切换到新会话
    store.switchSession(s2.id)

    expect(store.currentSessionId).toBe(s2.id)
    // 当前会话已保存（之前的会话应有消息）
    const orig = store.getSessionById(
      store.sessionList.find(s => s.name === '新对话')!.id,
    )
    expect(orig!.messages).toHaveLength(1)

    // 新会话消息为空
    expect(chat.messages).toHaveLength(0)
  })

  it('不能删除最后一个会话', async () => {
    const store = useSessionStore()
    await store.init()
    expect(store.sessionList).toHaveLength(1)

    const ok = store.deleteSession(store.currentSessionId)
    expect(ok).toBe(false)
    expect(store.sessionList).toHaveLength(1)
  })

  it('可以删除非当前会话', async () => {
    const store = useSessionStore()
    await store.init()
    store.createSession()
    expect(store.sessionList).toHaveLength(2)

    // 删除非当前会话
    const otherId = store.sessionList.find(s => s.id !== store.currentSessionId)!.id
    const ok = store.deleteSession(otherId)
    expect(ok).toBe(true)
    expect(store.sessionList).toHaveLength(1)
  })

  it('可以重命名会话', async () => {
    const store = useSessionStore()
    await store.init()

    const ok = store.renameSession(store.currentSessionId, '重命名测试')
    expect(ok).toBe(true)
    expect(store.currentSession!.name).toBe('重命名测试')
  })

  it('拒绝空名称重命名', async () => {
    const store = useSessionStore()
    await store.init()

    const ok = store.renameSession(store.currentSessionId, '  ')
    expect(ok).toBe(false)
    expect(store.currentSession!.name).toBe('新对话')
  })

  it('数据持久化到 localStorage', async () => {
    const store = useSessionStore()
    await store.init()
    store.createSession()
    store.createSession()

    // 验证写入了 localStorage
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'deskpet-sessions',
      expect.any(String),
    )
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'deskpet-current-session',
      expect.any(String),
    )

    // 验证存储的会话数量（取最后一次写入）
    const allCalls = localStorageMock.setItem.mock.calls as Array<[string, string]>
    const sessionCalls = allCalls.filter(([k]) => k === 'deskpet-sessions')
    const saved = JSON.parse(sessionCalls[sessionCalls.length - 1][1])
    expect(saved).toHaveLength(3)
  })

  it('从 localStorage 恢复会话', async () => {
    // 预先存储数据
    const now = Date.now()
    const sessions = [
      { id: 's1', name: '会话 A', messages: [
        { id: 'm1', role: 'user', text: '测试1', timestamp: now },
      ] as ChatMessage[], createdAt: now, updatedAt: now },
      { id: 's2', name: '会话 B', messages: [], createdAt: now, updatedAt: now },
    ]
    localStorageMock.setItem('deskpet-sessions', JSON.stringify(sessions))
    localStorageMock.setItem('deskpet-current-session', JSON.stringify('s2'))

    const store = useSessionStore()
    await store.init()

    expect(store.ready).toBe(true)
    expect(store.sessionList).toHaveLength(2)
    expect(store.currentSessionId).toBe('s2')
    expect(store.currentSession!.name).toBe('会话 B')

    // 验证消息加载到 ChatStore
    const chat = useChatStore()
    expect(chat.messages).toHaveLength(0) // 会话 B 没有消息
  })

  it('从 localStorage 恢复时自动加载消息到 ChatStore', async () => {
    const now = Date.now()
    const sessions = [
      { id: 's1', name: '有历史', messages: [
        { id: 'm1', role: 'user', text: '你好', timestamp: now },
        { id: 'm2', role: 'assistant', text: '嘿', timestamp: now },
      ] as ChatMessage[], createdAt: now, updatedAt: now },
    ]
    localStorageMock.setItem('deskpet-sessions', JSON.stringify(sessions))
    localStorageMock.setItem('deskpet-current-session', JSON.stringify('s1'))

    const store = useSessionStore()
    await store.init()

    const chat = useChatStore()
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[0].text).toBe('你好')
    expect(chat.messages[1].text).toBe('嘿')
  })

  it('会话列表按创建时间正序排列', async () => {
    const store = useSessionStore()
    await store.init()

    store.createSession('旧会话')
    // 模拟不同时间
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    store.createSession('新会话')
    vi.useRealTimers()

    const list = store.sessionList
    // 最早的（默认）应排在首位
    expect(list[0].name).toBe('新对话')
    // 最新的排最后
    expect(list[list.length - 1].name).toBe('新会话')
  })

  it('saveCurrentSession 保存 ChatStore 消息', async () => {
    const store = useSessionStore()
    await store.init()

    const chat = useChatStore()
    chat.addMessage('user', '测试消息')
    chat.addMessage('assistant', '回复')

    store.saveCurrentSession()
    expect(store.currentSession!.messages).toHaveLength(2)
  })

  it('保存脱敏协议上下文，但不长期持久化思考过程', async () => {
    const store = useSessionStore()
    await store.init()
    const chat = useChatStore()
    chat.loadMessages([
      { id: 'u1', role: 'user', text: '继续任务', timestamp: 1 },
      { id: 'a1', role: 'assistant', text: '已完成', thinking: '内部推理', voice: '完成しました', timestamp: 2 },
    ])

    store.saveCurrentSession()

    expect(store.currentSession!.messages[1].thinking).toBeUndefined()
    expect(store.currentSession!.context?.version).toBe(1)
    expect(store.currentSession!.context?.messages.some(m => m.role === 'tool')).toBe(true)
  })
})
