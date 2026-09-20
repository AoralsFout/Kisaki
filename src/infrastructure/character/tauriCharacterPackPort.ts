import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

/** Tauri 对话框与命令端口，供组合根装配到 CharacterPackWorkflow。 */
export interface TauriCharacterPackPort {
  selectImportPath: () => Promise<string | null>
  selectExportPath: (characterId: string) => Promise<string | null>
  importPack: (sourcePath: string) => Promise<unknown>
  exportPack: (characterId: string, destinationPath: string) => Promise<void>
}

export interface TauriCharacterPackPortDependencies {
  openDialog?: (options?: Parameters<typeof open>[0]) => Promise<unknown>
  saveDialog?: (options?: Parameters<typeof save>[0]) => Promise<unknown>
  invokeCommand?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

/**
 * 仅做 Tauri 协议映射，不在此处实现 zip 校验或角色包布局逻辑。
 * 路径选择返回 null 时由应用层统一解释为取消。
 */
export function createTauriCharacterPackPort(
  dependencies: TauriCharacterPackPortDependencies = {},
): TauriCharacterPackPort {
  const openDialog = dependencies.openDialog ?? ((options) => open(options))
  const saveDialog = dependencies.saveDialog ?? ((options) => save(options))
  const invokeCommand = dependencies.invokeCommand ?? ((command, args) => invoke(command, args))

  return {
    async selectImportPath() {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: '角色包', extensions: ['zip'] }],
      })
      return typeof selected === 'string' ? selected : null
    },

    async selectExportPath(characterId) {
      const selected = await saveDialog({
        defaultPath: `${characterId}.zip`,
        filters: [{ name: '角色包', extensions: ['zip'] }],
      })
      return typeof selected === 'string' ? selected : null
    },

    importPack(sourcePath) {
      return invokeCommand('import_character_pack', { srcPath: sourcePath })
    },

    async exportPack(characterId, destinationPath) {
      await invokeCommand('export_character_pack', { id: characterId, destPath: destinationPath })
    },
  }
}

export const tauriCharacterPackPort = createTauriCharacterPackPort()
