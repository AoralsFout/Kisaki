/**
 * 角色状态控制器
 *
 * 管理三维标签（姿势/情绪/服装）和图片选择。
 * 默认值始终从已加载的角色数据中获取，不硬编码。
 */

import { ref, computed, watch } from 'vue'
import { pickRandomImage } from './config'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from './config'
import {
  DEFAULT_POSE, getPose, ALL_POSE_KEYS,
  type PoseKey, type PosePreset,
} from './poses'

export function useCharacterController() {
  const charStore = useCharacterStore()

  // ======== 状态（从 store 数据获取默认值） ========
  const currentPoseTag = ref<string>('')
  const currentEmotion = ref<string>('')
  const currentCostume = ref<string>('')
  const currentImage = ref<CharacterImageData | null>(null)
  const currentScreenPose = ref<PoseKey>(DEFAULT_POSE)
  const ready = ref(false)

  // ======== 计算 ========
  const screenPosePreset = computed<PosePreset>(() => getPose(currentScreenPose.value))

  // ======== 从 store 数据同步标签值 ========
  function syncDefaultsFromData() {
    const d = charStore.data
    if (!d) return false
    currentPoseTag.value = d.poses[0] ?? ''
    currentEmotion.value = d.emotions[0] ?? ''
    currentCostume.value = d.costumes[0] ?? ''
    return true
  }

  /** 按当前标签选图 */
  function selectCurrentImage(): CharacterImageData | null {
    if (!charStore.data) return null
    if (!currentPoseTag.value || !currentEmotion.value || !currentCostume.value) return null
    return pickRandomImage(charStore.data, {
      pose: currentPoseTag.value,
      emotion: currentEmotion.value,
      costume: currentCostume.value,
      exclude: currentImage.value?.file,
    })
  }

  // ======== 对外方法 ========

  function setEmotion(emotion: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose: currentPoseTag.value, emotion, costume: currentCostume.value,
      exclude: currentImage.value?.file,
    })
    if (!img) return
    currentEmotion.value = emotion
    currentImage.value = img
  }

  function setPoseTag(pose: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose, emotion: currentEmotion.value, costume: currentCostume.value,
      exclude: currentImage.value?.file,
    })
    if (!img) return
    currentPoseTag.value = pose
    currentImage.value = img
  }

  function setCostume(costume: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose: currentPoseTag.value, emotion: currentEmotion.value, costume,
      exclude: currentImage.value?.file,
    })
    if (!img) return
    currentCostume.value = costume
    currentImage.value = img
  }

  function setLook(look: {
    pose?: string
    emotion?: string
    costume?: string
  }) {
    if (!charStore.data) return
    syncDefaultsFromData()
    const pose = look.pose ?? currentPoseTag.value
    const emotion = look.emotion ?? currentEmotion.value
    const costume = look.costume ?? currentCostume.value
    const img = pickRandomImage(charStore.data, {
      pose, emotion, costume,
      exclude: currentImage.value?.file,
    })
    if (!img) return
    if (look.pose) currentPoseTag.value = pose
    if (look.emotion) currentEmotion.value = emotion
    if (look.costume) currentCostume.value = costume
    currentImage.value = img
  }

  function setScreenPose(key: PoseKey) {
    if (ALL_POSE_KEYS.includes(key)) {
      currentScreenPose.value = key
    }
  }

  // ======== 角色切换 ========
  async function switchCharacter(charId: string) {
    await charStore.loadCharacter(charId)
    currentPoseTag.value = ''
    currentEmotion.value = ''
    currentCostume.value = ''
    syncDefaultsFromData()
    currentImage.value = selectCurrentImage()
  }

  // ======== 监听数据加载 ========
  watch(() => charStore.data, (newData) => {
    if (!newData) return
    syncDefaultsFromData()
    if (!currentImage.value) {
      currentImage.value = selectCurrentImage()
    }
  })

  // ======== 生命周期 ========
  function init() {
    syncDefaultsFromData()
    if (!currentImage.value) {
      currentImage.value = selectCurrentImage()
    }
    ready.value = true
  }

  function dispose() {}

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
