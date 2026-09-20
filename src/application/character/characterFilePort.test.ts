import { describe, expect, it, vi } from 'vitest'
import {
  createTauriCharacterFilePort,
  type CharacterInvoke,
} from '../../infrastructure/character/tauriCharacterFilePort'

describe('createTauriCharacterFilePort', () => {
  it('把语义端口映射到既有 Tauri 文件协议', async () => {
    const invoke = vi.fn<CharacterInvoke>(async () => undefined)
    const port = createTauriCharacterFilePort(invoke)

    await port.writePrompt('kisaki', '人设')
    await port.writeDefinition('kisaki', '{"id":"kisaki"}')
    await port.saveImage('kisaki', 'new.png', 'base64')
    await port.deleteImage('kisaki', 'old.png')

    expect(invoke.mock.calls).toEqual([
      ['write_character_file', { id: 'kisaki', filename: 'prompt.txt', content: '人设' }],
      ['write_character_file', { id: 'kisaki', filename: 'character.json', content: '{"id":"kisaki"}' }],
      ['save_character_image', { id: 'kisaki', filename: 'new.png', dataBase64: 'base64' }],
      ['delete_character_image', { id: 'kisaki', filename: 'old.png' }],
    ])
  })
})
