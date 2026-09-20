import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { CharacterFilePort } from '../../application/character/characterFilePort'

/** 可注入的 Tauri invoke 形状，便于适配器单测而不启动 Tauri。 */
export type CharacterInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

/**
 * 把现有 Tauri 角色文件命令适配为应用层端口。
 * 命令名和参数名只允许出现在这一层，保存编排器不感知协议细节。
 */
export function createTauriCharacterFilePort(
  invokeCommand: CharacterInvoke = tauriInvoke as CharacterInvoke,
): CharacterFilePort {
  return {
    writePrompt(characterId, content) {
      return invokeCommand('write_character_file', {
        id: characterId,
        filename: 'prompt.txt',
        content,
      }).then(() => undefined)
    },
    writeDefinition(characterId, content) {
      return invokeCommand('write_character_file', {
        id: characterId,
        filename: 'character.json',
        content,
      }).then(() => undefined)
    },
    saveImage(characterId, filename, dataBase64) {
      return invokeCommand('save_character_image', {
        id: characterId,
        filename,
        dataBase64,
      }).then(() => undefined)
    },
    deleteImage(characterId, filename) {
      return invokeCommand('delete_character_image', {
        id: characterId,
        filename,
      }).then(() => undefined)
    },
  }
}
