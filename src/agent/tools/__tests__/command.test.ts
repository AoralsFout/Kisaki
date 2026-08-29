import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const invokeMock = vi.fn()
const listenMock = vi.fn().mockResolvedValue(() => {})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

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

import { prepareCommandExecution, runProcessTool } from '../command'
import { useSessionStore } from '../../../stores/session'

describe('结构化任务执行工具', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorageMock.clear()
    invokeMock.mockReset()
    listenMock.mockClear()
    invokeMock.mockRejectedValue(new Error('not in tauri'))
    const session = useSessionStore()
    await session.init()
    session.setWorkspace({ id: 'ws_test', path: 'C:\\work\\project' })
  })

  it('准备进程计划时注入工作区能力并保持参数边界', async () => {
    const plan = { id: 'run_1', digest: 'abc' }
    invokeMock.mockResolvedValue(plan)

    await expect(prepareCommandExecution('run_process', {
      program: 'npm', args: ['test', '--', 'a b'], cwd: 'app', timeout_secs: 20,
    })).resolves.toBe(plan)

    expect(invokeMock).toHaveBeenCalledWith('agent_prepare_execution', {
      request: {
        workspace_id: 'ws_test', kind: 'process', program: 'npm', args: ['test', '--', 'a b'],
        cwd: 'app', timeout_secs: 20, env: {}, intent: '',
      },
    })
  })

  it('模型不能绕过批准阶段直接调用 handler', async () => {
    await expect(runProcessTool.handler({ program: 'npm', args: ['test'] }))
      .rejects.toThrow(/批准/)
    expect(invokeMock).not.toHaveBeenCalledWith('agent_execute_plan', expect.anything())
  })

  it('已批准计划直接返回结构化输出，不需要再读临时文件', async () => {
    invokeMock.mockResolvedValue({
      job_id: 'run_1', status: 'completed', exit_code: 0,
      stdout_tail: 'ok', stderr_tail: '', output_ref: 'run_1.log', duration_ms: 12,
      timed_out: false, cancelled: false, truncated: false,
      changed_files: ['dist/app.js'], changes_truncated: false,
      isolation: 'workspace_unconfined',
    })
    const output = await runProcessTool.handler({
      __plan_id: 'run_1', __approval_token: 'approve_1', __display_command: 'npm test',
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_execute_plan', {
      planId: 'run_1', approvalToken: 'approve_1',
    })
    expect(output).toContain('stdout')
    expect(output).toContain('ok')
    expect(output).toContain('dist/app.js')
  })
})
