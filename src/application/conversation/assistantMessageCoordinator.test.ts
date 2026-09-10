import { describe, expect, it, vi } from 'vitest'
import { AssistantMessageCoordinator, type AssistantMessageCommitPort } from './assistantMessageCoordinator'

function port(): AssistantMessageCommitPort {
  return {
    commit: vi.fn(async () => 'message-1'),
    revise: vi.fn(async () => true),
  }
}

describe('AssistantMessageCoordinator', () => {
  it('publishes AssistantCommitted only after the commit port succeeds', async () => {
    const adapter = port()
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    const event = await coordinator.commit({
      requestId: 'request-1',
      sessionId: 'session-1',
      display: 'hello',
      voice: 'hello',
      playbackText: 'hello',
      source: 'say',
    })

    expect(adapter.commit).toHaveBeenCalledOnce()
    expect(event).toMatchObject({ type: 'assistant-committed', messageId: 'message-1' })
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('does not publish when the commit port rejects a stale session', async () => {
    const adapter = port()
    vi.mocked(adapter.commit).mockResolvedValue(null)
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    await expect(coordinator.commit({
      requestId: 'request-1',
      sessionId: 'stale',
      display: 'hello',
      source: 'say',
    })).resolves.toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not publish before the asynchronous commit boundary finishes', async () => {
    let release!: (messageId: string) => void
    const adapter = port()
    vi.mocked(adapter.commit).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    const committing = coordinator.commit({
      requestId: 'request-1',
      sessionId: 'session-1',
      display: 'hello',
      source: 'say',
    })
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()

    release('message-1')
    await committing
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes revisions after persistence and validates their payload', async () => {
    const adapter = port()
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)
    const revision = {
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      voice: 'prepared voice',
      playbackText: 'prepared voice',
    }

    await expect(coordinator.revise(revision)).resolves.toMatchObject({ type: 'assistant-revised', ...revision })
    expect(adapter.revise).toHaveBeenCalledWith(revision)
    expect(listener).toHaveBeenCalledOnce()
    await expect(coordinator.revise({
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    })).rejects.toThrow('must contain display or voice')
  })
})
