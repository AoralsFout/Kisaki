import { describe, expect, it, vi } from 'vitest'
import {
  CharacterPackWorkflow,
  type CharacterPackWorkflowPorts,
} from './characterPackWorkflow'

function ports(overrides: Partial<CharacterPackWorkflowPorts> = {}): CharacterPackWorkflowPorts {
  return {
    selectImportPath: vi.fn(async () => 'incoming.zip'),
    selectExportPath: vi.fn(async () => 'outgoing.zip'),
    importPack: vi.fn(async () => ({ imported: ['alice'], skipped: ['kisaki'] })),
    exportPack: vi.fn(async () => undefined),
    refreshDisplayData: vi.fn(async () => undefined),
    bustImageCache: vi.fn(),
    emitCharactersChanged: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('CharacterPackWorkflow', () => {
  it('按命令、刷新、缓存、广播顺序完成合法导入', async () => {
    const calls: string[] = []
    const p = ports({
      importPack: vi.fn(async path => {
        calls.push(`import:${path}`)
        return { imported: ['alice'], skipped: [] }
      }),
      refreshDisplayData: vi.fn(async () => { calls.push('refresh') }),
      bustImageCache: vi.fn(() => { calls.push('cache') }),
      emitCharactersChanged: vi.fn(async () => { calls.push('broadcast') }),
    })

    const result = await new CharacterPackWorkflow(p).importCharacterPack()

    expect(result).toEqual({ status: 'succeeded', operation: 'import', imported: ['alice'], skipped: [] })
    expect(calls).toEqual(['import:incoming.zip', 'refresh', 'cache', 'broadcast'])
  })

  it('将损坏包或 Rust 命令失败归一为 command 失败且不刷新', async () => {
    const p = ports({ importPack: vi.fn(async () => { throw 'zip 解析失败' }) })

    await expect(new CharacterPackWorkflow(p).importCharacterPack()).resolves.toMatchObject({
      status: 'failed', operation: 'import', step: 'command', reason: 'zip 解析失败',
    })
    expect(p.refreshDisplayData).not.toHaveBeenCalled()
    expect(p.bustImageCache).not.toHaveBeenCalled()
    expect(p.emitCharactersChanged).not.toHaveBeenCalled()
  })

  it('拒绝损坏的导入返回值并保留结构化诊断', async () => {
    const p = ports({ importPack: vi.fn(async () => ({ imported: ['ok'] })) })

    await expect(new CharacterPackWorkflow(p).importCharacterPack()).resolves.toMatchObject({
      status: 'failed', operation: 'import', step: 'result-validation',
    })
    expect(p.refreshDisplayData).not.toHaveBeenCalled()
  })

  it('导入选择取消时不调用命令、刷新或广播', async () => {
    const p = ports({ selectImportPath: vi.fn(async () => null) })

    await expect(new CharacterPackWorkflow(p).importCharacterPack()).resolves.toEqual({
      status: 'cancelled', operation: 'import',
    })
    expect(p.importPack).not.toHaveBeenCalled()
    expect(p.refreshDisplayData).not.toHaveBeenCalled()
  })

  it('导出成功只调用选择器和命令，并返回成功结果', async () => {
    const p = ports()

    await expect(new CharacterPackWorkflow(p).exportCharacterPack('alice')).resolves.toEqual({
      status: 'succeeded', operation: 'export',
    })
    expect(p.selectExportPath).toHaveBeenCalledWith('alice')
    expect(p.exportPack).toHaveBeenCalledWith('alice', 'outgoing.zip')
  })

  it('区分导出取消与导出失败', async () => {
    const cancelled = ports({ selectExportPath: vi.fn(async () => undefined) })
    await expect(new CharacterPackWorkflow(cancelled).exportCharacterPack('alice')).resolves.toEqual({
      status: 'cancelled', operation: 'export',
    })
    expect(cancelled.exportPack).not.toHaveBeenCalled()

    const failed = ports({ exportPack: vi.fn(async () => { throw new Error('目标不可写') }) })
    await expect(new CharacterPackWorkflow(failed).exportCharacterPack('alice')).resolves.toMatchObject({
      status: 'failed', operation: 'export', step: 'command', reason: '目标不可写',
    })
  })

  it('导入后置刷新失败时返回对应步骤且不广播', async () => {
    const p = ports({ refreshDisplayData: vi.fn(async () => { throw new Error('扫描失败') }) })

    await expect(new CharacterPackWorkflow(p).importCharacterPack()).resolves.toMatchObject({
      status: 'failed', operation: 'import', step: 'refresh-display-data', reason: '扫描失败',
    })
    expect(p.bustImageCache).not.toHaveBeenCalled()
    expect(p.emitCharactersChanged).not.toHaveBeenCalled()
  })

  it('busy 期间阻止重复提交，并在首个操作结束后释放锁', async () => {
    let resolveImport!: (value: unknown) => void
    const importFinished = new Promise<unknown>(resolve => { resolveImport = resolve })
    const p = ports({ importPack: vi.fn(() => importFinished) })
    const workflow = new CharacterPackWorkflow(p)

    const first = workflow.importCharacterPack()
    await Promise.resolve()
    await expect(workflow.importCharacterPack()).resolves.toEqual({
      status: 'busy', operation: 'import', activeOperation: 'import',
    })
    expect(workflow.busy).toBe(true)

    resolveImport({ imported: [], skipped: [] })
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })
    expect(workflow.busy).toBe(false)
  })

  it('busy 期间也阻止相反方向的提交', async () => {
    let resolveExport!: () => void
    const exportFinished = new Promise<void>(resolve => { resolveExport = resolve })
    const p = ports({ exportPack: vi.fn(() => exportFinished) })
    const workflow = new CharacterPackWorkflow(p)
    const first = workflow.exportCharacterPack('alice')
    await Promise.resolve()

    await expect(workflow.importCharacterPack()).resolves.toEqual({
      status: 'busy', operation: 'import', activeOperation: 'export',
    })
    resolveExport()
    await expect(first).resolves.toMatchObject({ status: 'succeeded' })
  })
})
