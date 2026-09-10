import { describe, expect, it, vi } from 'vitest'
import { CharacterRuntime, type CharacterRenderer, type CharacterSelection } from './characterRuntime'

function character(overrides: Partial<CharacterSelection> = {}): CharacterSelection {
  return {
    id: 'alice',
    render: 'illustration',
    capabilities: {
      emotions: ['neutral', 'happy'],
      stances: ['idle', 'wave'],
      costumes: ['default', 'formal'],
      screenPoses: ['center', 'left'],
    },
    defaults: {
      emotion: 'neutral',
      stance: 'idle',
      costume: 'default',
      screenPose: 'center',
    },
    ...overrides,
  }
}

describe('CharacterRuntime', () => {
  it('accepts commands before renderer readiness and applies only the latest snapshot on attach', async () => {
    const runtime = new CharacterRuntime()
    runtime.selectCharacter(character())
    runtime.setLook({ emotion: 'happy' })
    const renderer: CharacterRenderer = { apply: vi.fn() }

    runtime.attachRenderer('illustration', renderer)
    await runtime.whenRendererSettled('illustration')

    expect(renderer.apply).toHaveBeenCalledOnce()
    expect(renderer.apply).toHaveBeenCalledWith(expect.objectContaining({
      characterId: 'alice',
      look: expect.objectContaining({ emotion: 'happy' }),
      revision: 2,
    }))
  })

  it('routes updates only to the active renderer kind', async () => {
    const runtime = new CharacterRuntime()
    const illustration: CharacterRenderer = { apply: vi.fn() }
    const live2d: CharacterRenderer = { apply: vi.fn() }
    runtime.attachRenderer('illustration', illustration)
    runtime.attachRenderer('live2d', live2d)

    runtime.selectCharacter(character())
    runtime.setLook({ stance: 'wave' })
    await runtime.whenRendererSettled('illustration')

    expect(illustration.apply).toHaveBeenCalledTimes(2)
    expect(live2d.apply).not.toHaveBeenCalled()

    runtime.selectCharacter(character({ id: 'live', render: 'live2d' }))
    await runtime.whenRendererSettled('live2d')
    expect(live2d.apply).toHaveBeenCalledOnce()
  })

  it('validates the complete next state before changing it', () => {
    const runtime = new CharacterRuntime()
    runtime.selectCharacter(character())
    const before = runtime.snapshot()

    expect(() => runtime.setLook({ emotion: 'missing' })).toThrow('Unsupported emotion')
    expect(runtime.snapshot()).toEqual(before)
  })

  it('serializes renderer applications and isolates renderer failures', async () => {
    const applied: number[] = []
    const errors: unknown[] = []
    const renderer: CharacterRenderer = {
      apply: vi.fn(async snapshot => {
        applied.push(snapshot.revision)
        if (snapshot.revision === 1) throw new Error('renderer failed')
      }),
    }
    const runtime = new CharacterRuntime(error => errors.push(error))
    runtime.attachRenderer('illustration', renderer)
    runtime.selectCharacter(character())
    runtime.setLook({ costume: 'formal' })
    await runtime.whenRendererSettled('illustration')

    expect(applied).toEqual([1, 2])
    expect(errors).toHaveLength(1)
    expect(runtime.snapshot().look?.costume).toBe('formal')
  })

  it('returns detached snapshots and disposes an attached renderer once', async () => {
    const renderer: CharacterRenderer = { apply: vi.fn(), dispose: vi.fn() }
    const runtime = new CharacterRuntime()
    runtime.selectCharacter(character())
    const detach = runtime.attachRenderer('illustration', renderer)
    await runtime.whenRendererSettled('illustration')
    const snapshot = runtime.snapshot()
    snapshot.look!.emotion = 'mutated'

    detach()
    detach()
    await Promise.resolve()

    expect(runtime.snapshot().look?.emotion).toBe('neutral')
    expect(renderer.dispose).toHaveBeenCalledOnce()
  })

  it('adopts renderer-discovered capabilities and normalizes unsupported state', () => {
    const runtime = new CharacterRuntime()
    runtime.selectCharacter(character())

    runtime.updateCapabilities({ emotions: ['smile', 'angry'] })

    expect(runtime.snapshot()).toMatchObject({
      look: { emotion: 'smile' },
      capabilities: { emotions: ['smile', 'angry'] },
      revision: 2,
    })
  })
})
