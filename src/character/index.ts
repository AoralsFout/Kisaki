/**
 * 角色模块 - 统一导出
 */
export {
  loadCharacterJson, listCharacters, imageUrl, bustImageCache, initCharacterDataDir,
  migrateCharacterData, characterFilePath, live2dFileUrl,
} from './loader'
export type { CharacterData, CharacterImageData, RenderKind, Live2DConfig } from './loader'
export { loadLive2DManifest, buildLive2DCatalog, live2dRedirect } from './live2d/manifest'
export type { Live2DManifest, Live2DExpressionInfo, Live2DMotionInfo } from './live2d/manifest'
export { findImages, pickRandomImage, FALLBACK_EMOTIONS } from './config'
export type { PoseTag, EmotionTag, CostumeTag } from './config'
export {
  POSE_PRESETS, ALL_POSE_KEYS, DEFAULT_POSE, getPose,
} from './poses'
export type { PoseKey, PosePreset } from './poses'
export { useCharacterController } from './controller'
export type { CharacterController } from './controller'
export { registerCharacterController, getCharacterController } from './commandBus'
export { useCharacterStore } from '../stores/character'
