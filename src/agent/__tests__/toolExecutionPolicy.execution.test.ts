import { beforeEach, describe, expect, it } from 'vitest'
import { register } from '../registry'
import { toolExecutionPolicy } from '../toolExecutionPolicy'
import { setAutoExecFiles, setScreenCaptureEnabled } from '../toolPolicy'
import type { Tool } from '../tool'

function registerPolicyTool(name: string, policy: Tool['policy']): void {
  register({
    policy,
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  })
}

const context = (change: Partial<{ sessionApproval: boolean; workspaceGrantId: string | null }> = {}) => ({
  signal: new AbortController().signal,
  sessionApproval: false,
  workspaceGrantId: 'grant-A',
  ...change,
})

describe('toolExecutionPolicy', () => {
  beforeEach(() => localStorage.clear())

  it('fails the workspace precondition before creating approval or checkpoint work', async () => {
    registerPolicyTool('test_workspace_write', {
      requiresWorkspace: true,
      approval: 'file-session',
      checkpointArgument: 'path',
    })

    await expect(toolExecutionPolicy.prepare(
      { id: 'one', name: 'test_workspace_write', arguments: { path: 'a.txt' } },
      context({ workspaceGrantId: null }),
    )).rejects.toMatchObject({ code: 'WORKSPACE_NOT_SET', retryable: true })
  })

  it('derives file approval and checkpoint from the tool descriptor', async () => {
    registerPolicyTool('test_file_write', {
      requiresWorkspace: true,
      approval: 'file-session',
      checkpointArgument: 'path',
    })

    const prepared = await toolExecutionPolicy.prepare(
      { id: 'two', name: 'test_file_write', arguments: { path: 'b.txt' } },
      context(),
    )

    expect(prepared.approval).toMatchObject({ kind: 'file', path: 'b.txt' })
    expect(prepared.checkpointPath).toBe('b.txt')
  })

  it('skips file approval for global or session approval without skipping checkpoint', async () => {
    registerPolicyTool('test_auto_write', {
      approval: 'file-session',
      checkpointArgument: 'path',
    })
    setAutoExecFiles(true)
    const global = await toolExecutionPolicy.prepare(
      { id: 'global', name: 'test_auto_write', arguments: { path: 'g.txt' } },
      context(),
    )
    setAutoExecFiles(false)
    const session = await toolExecutionPolicy.prepare(
      { id: 'session', name: 'test_auto_write', arguments: { path: 's.txt' } },
      context({ sessionApproval: true }),
    )

    expect(global.approval).toBeUndefined()
    expect(global.checkpointPath).toBe('g.txt')
    expect(session.approval).toBeUndefined()
    expect(session.checkpointPath).toBe('s.txt')
  })

  it('checks screen capture permission before requesting approval', async () => {
    registerPolicyTool('test_capture', { approval: 'screen-capture' })
    setScreenCaptureEnabled(false)

    await expect(toolExecutionPolicy.prepare(
      { id: 'screen', name: 'test_capture', arguments: {} },
      context(),
    )).rejects.toMatchObject({ code: 'SCREEN_CAPTURE_DISABLED' })
  })
})
