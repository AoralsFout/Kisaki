/**
 * Illustration renderer adapter.
 * CharacterRuntime owns all visual state; this controller owns only the selected bitmap.
 */
import { computed, ref } from 'vue'
import { pickRandomImage } from './config'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from './config'
import type { CharacterRuntimeSnapshot } from '../application/character/characterRuntime'
import { getPose, type PosePreset } from './poses'
import { createLogger } from '../utils/logger'

const log = createLogger('CharacterCtrl')

export function useCharacterController() {
  const charStore = useCharacterStore()
  const currentImage = ref<CharacterImageData | null>(null)
  const ready = ref(false)
  const currentEmotion = computed(() => charStore.currentEmotion)
  const currentScreenPose = computed(() => charStore.currentScreenPose)
  const screenPosePreset = computed<PosePreset>(() => getPose(currentScreenPose.value))
  let detachRenderer: (() => void) | null = null

  function selectImage(
    pose: string,
    emotion: string,
    costume: string,
    exclude?: string,
  ): CharacterImageData | null {
    const data = charStore.data
    if (!data || !pose || !emotion || !costume) return null
    return pickRandomImage(data, { pose, emotion, costume, exclude })
  }

  function applyRuntimeSnapshot(snapshot: CharacterRuntimeSnapshot): void {
    const look = snapshot.look
    const data = charStore.data
    if (!look || !data || snapshot.characterId !== data.id) return
    const exact = selectImage(look.stance, look.emotion, look.costume, currentImage.value?.file)
    if (exact) {
      currentImage.value = exact
      return
    }

    const fallback = selectImage(
      data.poses[0] ?? '',
      data.emotions[0] ?? '',
      data.costumes[0] ?? '',
      currentImage.value?.file,
    ) ?? data.images[0] ?? null
    currentImage.value = fallback
    if (fallback) {
      const fallbackLook = {
        stance: fallback.pose,
        emotion: fallback.emotions.includes(look.emotion) ? look.emotion : (fallback.emotions[0] ?? look.emotion),
        costume: fallback.costume,
      }
      if (
        fallbackLook.stance !== look.stance
        || fallbackLook.emotion !== look.emotion
        || fallbackLook.costume !== look.costume
      ) charStore.applyVisualState(fallbackLook)
      log.warn('character_ctrl.image_fallback', `立绘组合无匹配，回退图片 ${fallback.file}`)
    }
  }

  function init() {
    if (detachRenderer) return
    detachRenderer = charStore.attachRenderer('illustration', { apply: applyRuntimeSnapshot })
    ready.value = true
    log.info('character_ctrl.init.info', `立绘渲染器已连接: ${charStore.name}`)
  }

  function dispose() {
    detachRenderer?.()
    detachRenderer = null
    ready.value = false
  }

  return {
    currentEmotion, currentImage, screenPosePreset,
    ready, charStore,
    init, dispose,
  }
}

export type CharacterController = ReturnType<typeof useCharacterController>
