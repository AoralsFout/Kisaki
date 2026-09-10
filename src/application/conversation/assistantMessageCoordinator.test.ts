import { describe, expect, it, vi } from 'vitest'
import { AssistantMessageCoordinator, type AssistantMessageCommitPort } from './assistantMessageCoordinator'

function port(): AssistantMessageCommitPort {
  return {
    commit: vi.fn(() => 'message-1'),
    revise: vi.fn(() => true),
  }
}

describe('AssistantMessageCoordinator', () => {
  it('publishes AssistantCommitted only after the commit port succeeds', () => {
    const adapter = port()
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    const event = coordinator.commit({
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

  it('does not publish when the commit port rejects a stale session', () => {
    const adapter = port()
    vi.mocked(adapter.commit).mockReturnValue(null)
    const coordinator = new AssistantMessageCoordinator(adapter)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    expect(coordinator.commit({
      requestId: 'request-1',
      sessionId: 'stale',
      display: 'hello',
      source: 'say',
    })).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes revisions after persistence and validates their payload', () => {
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

    expect(coordinator.revise(revision)).toMatchObject({ type: 'assistant-revised', ...revision })
    expect(adapter.revise).toHaveBeenCalledWith(revision)
    expect(listener).toHaveBeenCalledOnce()
    expect(() => coordinator.revise({
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    })).toThrow('must contain display or voice')
  })
})
