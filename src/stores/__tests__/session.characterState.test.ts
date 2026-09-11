/**
 * 会话与角色外观的边界：加载会话要恢复该会话记住的情绪/位置，
 * 外观变化要写回会话，且恢复过程不能因为标签不属于当前角色而中断会话命令。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type {
  CharacterLookSnapshot,
  ConversationSessionSnapshot,
  SessionDocument,
} from '../../domain/conversation/events'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../../character/loader', () => ({
  listCharacterSummaries: vi.fn(),
  loadCharacterJson: vi.fn(),
  imageUrl: vi.fn((id: string, file: string) => `${id}/${file}`),
  clearCache: vi.fn(),
}))

import { listCharacterSummaries, loadCharacterJson } from '../../character/loader'
import { useCharacterStore } from '../character'
import { useCharacterController } from '../../character/controller'
import { useChatStore } from '../chat'
import { useSessionStore } from '../session'

/** 对应 characters/kisaki/character.json：每个（姿势, 服装）一张图，每张图含多个情绪。 */
const kisaki = {
  id: 'kisaki',
  name: 'Kisaki',
  description: '',
  version: 2,
  prompt: 'kisaki prompt',
  render: 'illustration' as const,
  poses: ['侧立', '正立'],
  emotions: ['待机', '开心', '坏笑'],
  costumes: ['校服', '常服'],
  images: [
    { file: 'a.png', pose: '侧立', costume: '校服', emotions: ['待机', '开心', '坏笑'] },
    { file: 'b.png', pose: '正立', costume: '校服', emotions: ['待机', '开心'] },
  ],
}

/** 对应 characters/miku/character.json：live2d 角色，完全没有立绘标签。 */
const miku = {
  id: 'miku',
  name: '初音未来',
  description: '',
  version: 2,
  prompt: 'miku prompt',
  render: 'live2d' as const,
  poses: [],
  emotions: [],
  costumes: [],
  images: [],
}

function session(
  id: string,
  characterId: string,
  createdAt: number,
  character: CharacterLookSnapshot | null = null,
): ConversationSessionSnapshot {
  return {
    id, title: id, characterId, characterLocked: false, character,
    workspaceGrantId: null, timeline: [], checkpoints: [],
    contextState: { summary: null, summarizedEventIds: [] }, createdAt, updatedAt: createdAt,
  }
}

function useTauri(sessions: ReturnType<typeof session>[]) {
  const document: SessionDocument = {
    schemaVersion: 2,
    currentSessionId: sessions[0].id,
    sessions,
  }
  const saves: SessionDocument[] = []
  invokeMock.mockImplementation((command: string, args?: { data?: string }) => {
    if (command === 'sessions_v2_load') return Promise.resolve(JSON.stringify(document))
    if (command === 'sessions_v2_save') {
      saves.push(JSON.parse(args?.data ?? '{}') as SessionDocument)
      return Promise.resolve()
    }
    if (command === 'agent_resolve_workspace') return Promise.resolve('C:\\ws')
    return Promise.resolve()
  })
  return { saves }
}

function savedCharacter(saves: SessionDocument[], sessionId: string) {
  const last = [...saves].reverse().find(save => save.sessions.some(item => item.id === sessionId))
  return last?.sessions.find(item => item.id === sessionId)?.character ?? null
}

/** 复刻 startup.ts 的顺序：会话先于角色初始化。 */
async function start(preferredId: string) {
  const charStore = useCharacterStore()
  const sessionStore = useSessionStore()
  await sessionStore.init().catch(() => {})
  await charStore.init(preferredId)
  useChatStore()
  return { charStore, sessionStore }
}

describe('session character look', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    vi.clearAllMocks()
    vi.mocked(listCharacterSummaries).mockResolvedValue([
      { id: 'kisaki', name: 'Kisaki', render: 'illustration' },
      { id: 'miku', name: 'Miku', render: 'live2d' },
    ])
    vi.mocked(loadCharacterJson).mockImplementation(async (id: string) => (
      id === 'miku' ? { ...miku } : { ...kisaki }
    ))
  })

  it('restores the look a session was left in when switching back to it', async () => {
    const { saves } = useTauri([session('s1', 'kisaki', 1), session('s2', 'kisaki', 2)])
    const { charStore, sessionStore } = await start('kisaki')
    useCharacterController().init()

    await sessionStore.switchSession('s2')
    expect(charStore.setVisualLook({ emotion: '开心' })).toBe(true)
    expect(charStore.setScreenPose('half-right')).toBe(true)
    await nextTick()

    expect(savedCharacter(saves, 's2')).toMatchObject({ emotion: '开心', screenPose: 'half-right' })

    await sessionStore.switchSession('s1')
    expect(charStore.getRuntimeSnapshot().look).toMatchObject({ emotion: '待机' })

    await sessionStore.switchSession('s2')
    expect(charStore.getRuntimeSnapshot().look).toMatchObject({
      emotion: '开心',
      screenPose: 'half-right',
    })
    // 切走的往返过程不能把 s2 记住的外观冲掉
    expect(savedCharacter(saves, 's2')).toMatchObject({ emotion: '开心', screenPose: 'half-right' })
  })

  it('restores a stored look that the current character cannot render instead of failing', async () => {
    useTauri([
      session('s1', 'kisaki', 1),
      session('s2', 'kisaki', 2, { emotion: 'Chijing', stance: '', costume: '', screenPose: 'full-left' }),
    ])
    const { charStore, sessionStore } = await start('kisaki')
    useCharacterController().init()

    // 标签来自别的角色：忽略无法渲染的部分，但不阻断切换，也不影响后续设置
    expect(await sessionStore.switchSession('s2')).toBe(true)
    expect(charStore.getRuntimeSnapshot().look).toMatchObject({
      emotion: '待机',
      stance: '侧立',
      screenPose: 'full-left',
    })
    expect(charStore.setVisualLook({ emotion: '开心' })).toBe(true)
  })

  it('keeps Live2D sessions switchable once the model has published its capabilities', async () => {
    useTauri([session('s1', 'miku', 1), session('s2', 'miku', 2)])
    const { charStore, sessionStore } = await start('miku')
    charStore.attachRenderer('live2d', { apply: () => {}, execute: () => true })
    charStore.updateRuntimeCapabilities({
      emotions: ['Chijing', 'Saihong'],
      emotionDescriptions: { Chijing: '吃惊', Saihong: '腮红' },
      motions: [],
    })

    expect(await sessionStore.switchSession('s2')).toBe(true)
    expect(charStore.getRuntimeSnapshot().look).toMatchObject({ emotion: 'Chijing' })
    expect(charStore.setVisualLook({ emotion: 'Saihong' })).toBe(true)
  })

  it('applies the session look that arrives before the character is selected', async () => {
    useTauri([
      session('s1', 'kisaki', 1, { emotion: '坏笑', stance: '正立', costume: '校服', screenPose: 'headshot-left' }),
    ])
    // 角色 store 尚未加载：外观先进入 pending，选角后应用
    await useSessionStore().init().catch(() => {})
    expect(useCharacterStore().getRuntimeSnapshot().look).toBeNull()

    await useCharacterStore().init('kisaki')

    expect(useCharacterStore().getRuntimeSnapshot().look).toMatchObject({
      emotion: '坏笑',
      stance: '正立',
      screenPose: 'headshot-left',
    })
  })

  it('falls back to the latest checkpoint for sessions written before looks were stored', async () => {
    const legacy = session('s1', 'kisaki', 1)
    legacy.characterLocked = true
    legacy.timeline = [{
      type: 'user-message-accepted', eventId: 'event-user', occurredAt: 2,
      messageId: 'u1', text: 'hi', images: [],
    }] as SessionDocument['sessions'][number]['timeline']
    legacy.checkpoints = [{
      id: 'u1', userMessageId: 'u1', createdAt: 2, hasWorkspaceChanges: false,
      character: {
        characterId: 'kisaki', emotion: '坏笑', stance: '正立', costume: '校服', screenPose: 'headshot-left',
      },
    }] as SessionDocument['sessions'][number]['checkpoints']
    useTauri([legacy])

    const { charStore } = await start('kisaki')

    expect(charStore.getRuntimeSnapshot().look).toMatchObject({
      emotion: '坏笑',
      stance: '正立',
      screenPose: 'headshot-left',
    })
  })

  it('drops a stored look that belongs to another character', async () => {
    useTauri([
      session('s1', 'kisaki', 1, { emotion: '开心', stance: '侧立', costume: '校服', screenPose: 'full-center' }),
      session('s2', 'miku', 2, { emotion: '开心', stance: '侧立', costume: '校服', screenPose: 'full-center' }),
    ])
    const { charStore, sessionStore } = await start('kisaki')

    await sessionStore.switchSession('s2')

    // miku 没有立绘标签：'' 兜底，不能把 kisaki 的标签硬塞进去
    expect(charStore.currentId).toBe('miku')
    expect(charStore.getRuntimeSnapshot().look).toMatchObject({ emotion: '', stance: '', costume: '' })
  })
})
