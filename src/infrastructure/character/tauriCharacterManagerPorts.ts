import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { emit as tauriEmit } from '@tauri-apps/api/event'
import { open as tauriOpen } from '@tauri-apps/plugin-dialog'
import { bustImageCache, initCharacterDataDir } from '../../character/loader'
import { loadLive2DManifest } from '../../character/live2d/manifest'
import { createTauriCharacterFilePort, type CharacterInvoke } from './tauriCharacterFilePort'
import type { CharacterManagerPorts } from '../../application/character/characterManagerPorts'

/** 角色管理组合根所需的 Tauri 协议适配；业务编排不依赖 invoke。 */
export type TauriCharacterManagerPorts = CharacterManagerPorts

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
    appearanceFiles: files,
    initializeDataDir: initCharacterDataDir,
    bustImageCache,
    loadLive2dManifest: loadLive2DManifest,
    pickLive2dModel: async () => {
      const selected = await tauriOpen({ directory: true, multiple: false })
      return typeof selected === 'string' ? selected : null
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
