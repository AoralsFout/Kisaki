import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { emit as tauriEmit } from '@tauri-apps/api/event'
import type { CharacterAppearanceLive2DImportPort } from '../../application/character/characterAppearance'
import type { CharacterCreationPorts } from '../../application/character/characterCreation'
import type { CharacterFilePort } from '../../application/character/characterFilePort'
import { createTauriCharacterFilePort, type CharacterInvoke } from './tauriCharacterFilePort'

/** 角色管理组合根所需的 Tauri 协议适配；业务编排不依赖 invoke。 */
export interface TauriCharacterManagerPorts {
  files: CharacterFilePort
  live2d: CharacterAppearanceLive2DImportPort
  creationFiles: CharacterCreationPorts['files']
  deleteCharacter: (characterId: string) => Promise<void>
  broadcastCharactersChanged: () => Promise<void>
}

export function createTauriCharacterManagerPorts(
  invokeCommand: CharacterInvoke = tauriInvoke as CharacterInvoke,
): TauriCharacterManagerPorts {
  const files = createTauriCharacterFilePort(invokeCommand)
  return {
    files,
    creationFiles: {
      writePrompt: files.writePrompt,
      writeDefinition: files.writeDefinition,
    },
    live2d: {
      importLive2dModel(characterId, sourceDirectory) {
        return invokeCommand('import_live2d_model', {
          id: characterId,
          srcDir: sourceDirectory,
        }).then(value => String(value))
      },
    },
    deleteCharacter(characterId) {
      return invokeCommand('delete_character', { id: characterId }).then(() => undefined)
    },
    async broadcastCharactersChanged() {
      await tauriEmit('characters-changed')
    },
  }
}

export const tauriCharacterManagerPorts = createTauriCharacterManagerPorts()
