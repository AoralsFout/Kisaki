import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionList from './SessionList.vue'
import ChatHistory from './ChatHistory.vue'

const stores = vi.hoisted(() => ({
  sessions: [{ id: 'a', name: 'Named session', messages: [], updatedAt: 0 }, { id: 'b', name: 'Other', messages: [], updatedAt: 0 }],
  remove: vi.fn(), clear: vi.fn(), currentId: 'a',
}))
vi.mock('../stores/session', () => ({ useSessionStore: () => ({
  sessionList: stores.sessions,
  get currentSessionId() { return stores.currentId },
  get currentSession() { return stores.sessions.find(s => s.id === stores.currentId) },
  getSessionById: (id: string) => stores.sessions.find(s => s.id === id),
  deleteSession: stores.remove,
}) }))
vi.mock('../stores/chat', () => ({ useChatStore: () => ({ messages: [], contextStats: { utilization: 0, estimatedTokens: 0, maxContextTokens: 100 }, clearMessages: stores.clear }) }))
// 聊天面板读取当前角色名做旧数据回退展示；此处无需真实角色 store
vi.mock('../character', () => ({ useCharacterStore: () => ({ name: 'Kisaki' }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string, args?: unknown) => key + (args ? JSON.stringify(args) : '') }) }))
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); stores.currentId = 'a' })

describe('destructive operation confirmation', () => {
  it('names the session, cancel does nothing, confirm deletes exactly the selected session', async () => {
    const wrapper = mount(SessionList, { props: { visible: true } })
    await wrapper.get('.btn-danger').trigger('click')
    await flushPromises()
    expect(stores.remove).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Named session')
    document.querySelector<HTMLButtonElement>('.safety-actions button')!.click()
    await flushPromises()
    expect(stores.remove).not.toHaveBeenCalled()
    await wrapper.get('.btn-danger').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('.safety-actions .primary')!.click()
    expect(stores.remove).toHaveBeenCalledExactlyOnceWith('a')
    wrapper.unmount()
  })

  it('does not clear another session if it changes while confirmation is open', async () => {
    const wrapper = mount(ChatHistory, { props: { visible: true } })
    await wrapper.get('.btn-clear').trigger('click')
    await flushPromises()
    expect(stores.clear).not.toHaveBeenCalled()
    stores.currentId = 'b'
    document.querySelector<HTMLButtonElement>('.safety-actions .primary')!.click()
    expect(stores.clear).not.toHaveBeenCalled()
    await flushPromises()
    await wrapper.get('.btn-clear').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('.safety-actions .primary')!.click()
    expect(stores.clear).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
