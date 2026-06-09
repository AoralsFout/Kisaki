/**
 * 角色模块 - 统一导出
 */
export { loadCharacterJson, listCharacters, imageUrl, bustImageCache } from './loader'
export type { CharacterData, CharacterImageData } from './loader'
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
