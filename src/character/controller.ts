/**
 * Illustration renderer adapter and command facade.
 * CharacterRuntime owns all visual state; this controller owns only the selected bitmap.
 */
import { computed, ref } from 'vue'
import { pickRandomImage } from './config'
import { useCharacterStore } from '../stores/character'
import { useSessionStore } from '../stores/session'
import type { CharacterImageData } from './config'
import type { CharacterRuntimeSnapshot } from '../application/character/characterRuntime'
import { ALL_POSE_KEYS, getPose, type PoseKey, type PosePreset } from './poses'
import { createLogger } from '../utils/logger'

const log = createLogger('CharacterCtrl')

export function useCharacterController() {
  const charStore = useCharacterStore()
  const currentImage = ref<CharacterImageData | null>(null)
  const ready = ref(false)
  const currentPoseTag = computed(() => charStore.currentStance)
  const currentEmotion = computed(() => charStore.currentEmotion)
  const currentCostume = computed(() => charStore.currentCostume)
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

  function setEmotion(emotion: string) {
    const data = charStore.data
    if (!data) return
    let pose = currentPoseTag.value
    let image = selectImage(pose, emotion, currentCostume.value, currentImage.value?.file)
    if (!image) {
      for (const candidate of data.poses) {
        image = selectImage(candidate, emotion, currentCostume.value, currentImage.value?.file)
        if (image) {
          pose = candidate
          break
        }
      }
    }
    if (!image) {
      log.warn('character_ctrl.set_emotion.warn', `未找到匹配情绪“${emotion}”的图片`)
      return
    }
    currentImage.value = image
    charStore.applyVisualState({ emotion, stance: pose })
  }

  function setPoseTag(pose: string) {
    const image = selectImage(pose, currentEmotion.value, currentCostume.value, currentImage.value?.file)
    if (!image) {
      log.warn('character_ctrl.set_pose_tag.warn', `未找到匹配姿势“${pose}”的图片`)
      return
    }
    currentImage.value = image
    charStore.applyVisualState({ stance: pose })
  }

  function setCostume(costume: string) {
    const image = selectImage(currentPoseTag.value, currentEmotion.value, costume, currentImage.value?.file)
    if (!image) {
      log.warn('character_ctrl.set_costume.warn', `未找到匹配服装“${costume}”的图片`)
      return
    }
    currentImage.value = image
    charStore.applyVisualState({ costume })
  }

  function setLook(look: { pose?: string; emotion?: string; costume?: string }) {
    const data = charStore.data
    if (!data) return
    let pose = look.pose ?? currentPoseTag.value
    const emotion = look.emotion ?? currentEmotion.value
    const costume = look.costume ?? currentCostume.value
    let image = selectImage(pose, emotion, costume, currentImage.value?.file)
    if (!image && !look.pose && look.emotion) {
      for (const candidate of data.poses) {
        image = selectImage(candidate, emotion, costume, currentImage.value?.file)
        if (image) {
          pose = candidate
          break
        }
      }
    }
    if (!image) {
      log.warn('character_ctrl.set_look.warn', `未找到匹配外观: ${JSON.stringify(look)}`)
      return
    }
    currentImage.value = image
    charStore.applyVisualState({ stance: pose, emotion, costume })
  }

  function setScreenPose(key: PoseKey) {
    if (ALL_POSE_KEYS.includes(key)) charStore.applyVisualState({ screenPose: key })
  }

  async function switchCharacter(charId: string) {
    log.info('character_ctrl.switch_character.info', `切换角色: ${charId}`, { char_id: charId })
    await charStore.loadCharacter(charId)
    useSessionStore().saveCurrentSession()
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
    currentPoseTag, currentEmotion, currentCostume,
    currentImage, currentScreenPose, screenPosePreset,
    ready, charStore,
    init, dispose,
    setEmotion, setPoseTag, setCostume, setLook, setScreenPose,
    switchCharacter,
  }
}

export type CharacterController = ReturnType<typeof useCharacterController>
