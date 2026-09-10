import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway, type FileApprovalRequest } from './approvalGateway'

const request = (id: string): FileApprovalRequest => ({
  kind: 'file',
  id,
  toolName: 'write_file',
  args: { path: `${id}.txt` },
  path: `${id}.txt`,
  allowedDecisions: ['allow', 'allow-session', 'reject'],
})

describe('ApprovalGateway', () => {
  it('projects one pending request and clears it after a valid decision', async () => {
    const gateway = new ApprovalGateway()
    const seen: Array<string | null> = []
    gateway.subscribe(value => seen.push(value?.id ?? null))

    const decision = gateway.request(request('one'), new AbortController().signal)
    expect(gateway.current()?.id).toBe('one')
    expect(gateway.resolve('allow-session')).toBe(true)

    await expect(decision).resolves.toBe('allow-session')
    expect(gateway.current()).toBeNull()
    expect(seen).toEqual([null, 'one', null])
  })

  it('rejects on abort and ignores decisions not allowed by the request', async () => {
    const controller = new AbortController()
    const gateway = new ApprovalGateway()
    const command = { ...request('command'), kind: 'command' as const, summary: 'npm test', details: {}, allowedDecisions: ['allow', 'reject'] as const }
    const decision = gateway.request(command, controller.signal)

    expect(gateway.resolve('allow-session')).toBe(false)
    controller.abort()

    await expect(decision).resolves.toBe('reject')
    expect(gateway.current()).toBeNull()
  })

  it('rejects the previous request when a new one replaces it', async () => {
    const gateway = new ApprovalGateway()
    const first = gateway.request(request('first'), new AbortController().signal)
    const second = gateway.request(request('second'), new AbortController().signal)

    await expect(first).resolves.toBe('reject')
    expect(gateway.current()?.id).toBe('second')
    gateway.resolve('allow')
    await expect(second).resolves.toBe('allow')
  })

  it('times out through the same rejection path', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const gateway = new ApprovalGateway(100, onTimeout)
    const decision = gateway.request(request('slow'), new AbortController().signal)

    await vi.advanceTimersByTimeAsync(100)

    await expect(decision).resolves.toBe('reject')
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ id: 'slow' }))
    expect(gateway.current()).toBeNull()
    vi.useRealTimers()
  })
})
