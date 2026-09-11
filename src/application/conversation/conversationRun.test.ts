import { describe, expect, it, vi } from 'vitest'
import {
  ConversationCoordinator,
  ConversationRun,
  type ConversationToolTurnPorts,
  isConversationRunActive,
  isConversationRunUsingTools,
} from './conversationRun'

function toolTurnPorts(events: string[]): ConversationToolTurnPorts {
  return {
    session: {
      recordToolCalls: async step => {
        events.push(`persist-calls:${JSON.stringify(step.calls[0]?.arguments)}`)
        return true
      },
      recordToolResult: async result => {
        events.push(`persist-result:${result.callId}`)
        return true
      },
    },
    modelContext: {
      addToolCalls: calls => events.push(`context-calls:${calls[0]?.id}`),
      addToolResult: callId => events.push(`context-result:${callId}`),
      addToolImages: toolCallIds => events.push(`context-images:${toolCallIds}`),
    },
  }
}

describe('ConversationRun', () => {
  it('owns the valid request lifecycle and timestamps terminal state', () => {
    let now = 10
    const run = new ConversationRun('request-1', () => now++)
    const states: string[] = []
    run.subscribe(snapshot => states.push(snapshot.state))

    run.transition('preparing')
    run.transition('streaming')
    run.transition('executing-tools')
    run.transition('streaming')
    run.transition('finalizing')
    run.transition('completed')

    expect(states).toEqual([
      'idle',
      'preparing',
      'streaming',
      'executing-tools',
      'streaming',
      'finalizing',
      'completed',
    ])
    expect(run.snapshot()).toMatchObject({ startedAt: 10, finishedAt: 15, revision: 6 })
    expect(run.signal.aborted).toBe(false)
  })

  it('rejects invalid transitions instead of creating boolean combinations', () => {
    const run = new ConversationRun('request-1')
    expect(() => run.transition('executing-tools')).toThrow('idle -> executing-tools')
    run.transition('preparing')
    expect(() => run.transition('completed')).toThrow('preparing -> completed')
  })

  it('makes cancellation the source of the abort signal', () => {
    const run = new ConversationRun('request-1')
    const abort = vi.fn()
    run.signal.addEventListener('abort', abort)
    run.transition('preparing')

    run.cancel('user')
    run.cancel('duplicate')

    expect(run.snapshot()).toMatchObject({ state: 'cancelled', reason: 'user' })
    expect(run.signal.aborted).toBe(true)
    expect(abort).toHaveBeenCalledOnce()
  })

  it('derives UI projections from states', () => {
    expect(isConversationRunActive('preparing')).toBe(true)
    expect(isConversationRunActive('completed')).toBe(false)
    expect(isConversationRunUsingTools('awaiting-approval')).toBe(true)
    expect(isConversationRunUsingTools('executing-tools')).toBe(true)
    expect(isConversationRunUsingTools('streaming')).toBe(false)
  })
})

describe('ConversationCoordinator', () => {
  it('supersedes the old run and refuses stale projection updates', () => {
    const coordinator = new ConversationCoordinator()
    const first = coordinator.start('first')
    const second = coordinator.start('second')

    expect(first.snapshot()).toMatchObject({ state: 'cancelled', reason: 'superseded' })
    expect(first.signal.aborted).toBe(true)
    expect(coordinator.isCurrent('second')).toBe(true)
    expect(coordinator.mayProject('first')).toBe(false)
    expect(coordinator.transition('first', 'streaming')).toBe(false)
    expect(coordinator.transition('second', 'streaming')).toBe(true)
    expect(second.snapshot().state).toBe('streaming')
  })

  it('publishes one canonical state stream to presentation consumers', () => {
    const coordinator = new ConversationCoordinator()
    const states: Array<string | null> = []
    coordinator.subscribe(snapshot => states.push(snapshot?.state ?? null))

    coordinator.start('request-1')
    coordinator.transition('request-1', 'streaming')
    coordinator.transition('request-1', 'awaiting-approval')
    coordinator.transition('request-1', 'executing-tools')
    coordinator.cancelActive('user')

    expect(states).toEqual([
      null,
      'idle',
      'preparing',
      'streaming',
      'awaiting-approval',
      'executing-tools',
      'cancelled',
    ])
  })

  it('owns model turn iteration and stops when the workflow completes', async () => {
    const coordinator = new ConversationCoordinator()
    coordinator.start('request-1')
    const turns: number[] = []

    const result = await coordinator.runTurns('request-1', 5, async turn => {
      turns.push(turn)
      return turn === 1 ? 'complete' : 'continue'
    })

    expect(result).toEqual({ status: 'completed', turnsUsed: 2 })
    expect(turns).toEqual([0, 1])
  })

  it('classifies cancellation and failures without terminalizing presentation early', async () => {
    const coordinator = new ConversationCoordinator()
    coordinator.start('cancelled')
    const cancelled = await coordinator.runTurns('cancelled', 2, async () => {
      coordinator.cancelActive('user')
      return 'continue'
    })
    expect(cancelled).toEqual({ status: 'cancelled', turnsUsed: 1 })

    coordinator.start('failed')
    const error = new Error('network')
    const failed = await coordinator.runTurns('failed', 2, async () => { throw error })
    expect(failed).toEqual({ status: 'failed', turnsUsed: 1, error })
    expect(coordinator.mayProject('failed')).toBe(true)
  })

  it('reports the safety limit when every turn requests continuation', async () => {
    const coordinator = new ConversationCoordinator()
    coordinator.start('request-1')
    await expect(coordinator.runTurns('request-1', 2, async () => 'continue')).resolves.toEqual({
      status: 'turn-limit',
      turnsUsed: 2,
    })
  })

  it('owns canonical tool persistence before live model-context projection', async () => {
    const events: string[] = []
    const coordinator = new ConversationCoordinator(Date.now, toolTurnPorts(events))
    coordinator.start('request-1')

    await coordinator.commitToolCalls('request-1', {
      sessionId: 'session-1',
      stepId: 'request-1:0',
      calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{invalid' },
      }],
    })
    await coordinator.commitToolResult('request-1', {
      sessionId: 'session-1',
      callId: 'call-1',
      content: 'done',
      status: 'succeeded',
    })

    expect(events).toEqual([
      'persist-calls:{"_raw":"{invalid","_invalid":true}',
      'context-calls:call-1',
      'persist-result:call-1',
      'context-result:call-1',
    ])
  })

  it('does not let a superseded run project after asynchronous persistence', async () => {
    const contextCalls = vi.fn()
    let resolvePersistence!: (recorded: boolean) => void
    const persistence = new Promise<boolean>(resolve => { resolvePersistence = resolve })
    const ports = toolTurnPorts([])
    ports.session.recordToolCalls = () => persistence
    ports.modelContext.addToolCalls = contextCalls
    const coordinator = new ConversationCoordinator(Date.now, ports)
    coordinator.start('old')

    const pending = coordinator.commitToolCalls('old', {
      sessionId: 'session-old',
      stepId: 'old:0',
      calls: [{
        id: 'call-old',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
    })
    coordinator.start('new')
    resolvePersistence(true)

    await expect(pending).rejects.toMatchObject({ name: 'ConversationRunOwnershipError', runId: 'old' })
    expect(contextCalls).not.toHaveBeenCalled()
  })

  it('keeps synthetic exchanges and tool images behind current-run ownership', () => {
    const events: string[] = []
    const coordinator = new ConversationCoordinator(Date.now, toolTurnPorts(events))
    coordinator.start('request-1')
    coordinator.appendSyntheticToolExchange('request-1', {
      id: 'say-fallback',
      type: 'function',
      function: { name: 'say', arguments: '{}' },
    }, 'spoken')
    coordinator.appendToolImages('request-1', 'read-1', [])
    coordinator.start('request-2')

    expect(() => coordinator.appendToolImages('request-1', 'stale', [])).toThrowError(
      expect.objectContaining({ name: 'ConversationRunOwnershipError', runId: 'request-1' }),
    )
    expect(events).toEqual([
      'context-calls:say-fallback',
      'context-result:say-fallback',
      'context-images:read-1',
    ])
  })
})
