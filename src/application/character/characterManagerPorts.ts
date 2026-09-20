import type { Live2DConfig } from '../../character/loader'
import type { Live2DManifest } from '../../character/live2d/manifest'
import type { CharacterAppearanceImagePort, CharacterAppearanceLive2DImportPort } from './characterAppearance'
import type { CharacterCreationPorts } from './characterCreation'
import type { CharacterFilePort } from './characterFilePort'

/** 角色管理组合根使用的语义端口；底层 loader、dialog 和协议只在基础设施适配器出现。 */
export interface CharacterManagerPorts {
  files: CharacterFilePort
  appearanceFiles: CharacterAppearanceImagePort
  live2d: CharacterAppearanceLive2DImportPort
  creationFiles: CharacterCreationPorts['files']
  deleteCharacter: (characterId: string) => Promise<void>
  initializeDataDir: () => Promise<void>
  bustImageCache: () => void | Promise<void>
  loadLive2dManifest: (characterId: string, data: { live2d?: Live2DConfig }) => Promise<Live2DManifest>
  pickLive2dModel: () => Promise<string | null>
  broadcastCharactersChanged: () => Promise<void>
}
