import { describe, expect, it, vi } from 'vitest'
import {
  ConversationCoordinator,
  ConversationRun,
  isConversationRunActive,
  isConversationRunUsingTools,
} from './conversationRun'

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
})
