import { describe, expect, it, vi } from 'vitest'
import { createTauriCharacterPackPort } from './tauriCharacterPackPort'

describe('createTauriCharacterPackPort', () => {
  it('映射路径选择和既有 Tauri 命令协议', async () => {
    const openDialog = vi.fn(async () => '/tmp/incoming.zip')
    const saveDialog = vi.fn(async () => '/tmp/outgoing.zip')
    const invokeCommand = vi.fn(async (command: string) => (
      command === 'import_character_pack'
        ? { imported: ['alice'], skipped: [] }
        : undefined
    ))
    const port = createTauriCharacterPackPort({ openDialog, saveDialog, invokeCommand })

    await expect(port.selectImportPath()).resolves.toBe('/tmp/incoming.zip')
    await expect(port.selectExportPath('alice')).resolves.toBe('/tmp/outgoing.zip')
    await expect(port.importPack('/tmp/incoming.zip')).resolves.toEqual({ imported: ['alice'], skipped: [] })
    await expect(port.exportPack('alice', '/tmp/outgoing.zip')).resolves.toBeUndefined()

    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }))
    expect(saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'alice.zip' }))
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'import_character_pack', { srcPath: '/tmp/incoming.zip' })
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'export_character_pack', {
      id: 'alice', destPath: '/tmp/outgoing.zip',
    })
  })

  it('将多选或取消统一转换成 null', async () => {
    const port = createTauriCharacterPackPort({
      openDialog: vi.fn(async () => ['/tmp/a.zip', '/tmp/b.zip']),
      saveDialog: vi.fn(async () => null),
      invokeCommand: vi.fn(),
    })

    await expect(port.selectImportPath()).resolves.toBeNull()
    await expect(port.selectExportPath('alice')).resolves.toBeNull()
  })
})
