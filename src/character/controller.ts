/**
 * 角色状态控制器
 *
 * 管理三维标签（姿势/情绪/服装）和图片选择。
 * 本地 ref 为数据源，每次变更时同步写入 characterStore，
 * 同时监听 characterStore 的视觉状态变更（会话恢复导致）来同步图像。
 */

import { ref, computed, watch } from 'vue'
import { pickRandomImage } from './config'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from './config'
import {
  DEFAULT_POSE, getPose, ALL_POSE_KEYS,
  type PoseKey, type PosePreset,
} from './poses'
import { createLogger } from '../utils/logger'

const log = createLogger('CharacterCtrl')

export function useCharacterController() {
  const charStore = useCharacterStore()

  // ======== 本地状态（数据源） ========
  const currentPoseTag = ref<string>('')
  const currentEmotion = ref<string>('')
  const currentCostume = ref<string>('')
  const currentImage = ref<CharacterImageData | null>(null)
  const currentScreenPose = ref<PoseKey>(DEFAULT_POSE)
  const ready = ref(false)

  // ======== 计算 ========
  const screenPosePreset = computed<PosePreset>(() => getPose(currentScreenPose.value))

  // ======== 从 store 数据同步标签默认值 ========
  function syncDefaultsFromData() {
    const d = charStore.data
    if (!d) return false
    // 只覆盖尚未设置的值
    if (!currentPoseTag.value) currentPoseTag.value = d.poses[0] ?? ''
    if (!currentEmotion.value) currentEmotion.value = d.emotions[0] ?? ''
    if (!currentCostume.value) currentCostume.value = d.costumes[0] ?? ''
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

  // ======== 同步本地状态 → characterStore ========
  function syncToStore() {
    charStore.applyVisualState({
      emotion: currentEmotion.value,
      stance: currentPoseTag.value,
      costume: currentCostume.value,
      screenPose: currentScreenPose.value,
    })
  }

  // ======== 对外方法 ========

  function setEmotion(emotion: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose: currentPoseTag.value, emotion, costume: currentCostume.value,
      exclude: currentImage.value?.file,
    })
    if (!img) {
      log.warn('未找到匹配情绪"%s"的图片', emotion)
      return
    }
    currentEmotion.value = emotion
    currentImage.value = img
    syncToStore()
    log.debug('情绪切换: %s, 图片: %s', emotion, img.file)
  }

  function setPoseTag(pose: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose, emotion: currentEmotion.value, costume: currentCostume.value,
      exclude: currentImage.value?.file,
    })
    if (!img) {
      log.warn('未找到匹配姿势"%s"的图片', pose)
      return
    }
    currentPoseTag.value = pose
    currentImage.value = img
    syncToStore()
    log.debug('姿势切换: %s, 图片: %s', pose, img.file)
  }

  function setCostume(costume: string) {
    if (!charStore.data) return
    const img = pickRandomImage(charStore.data, {
      pose: currentPoseTag.value, emotion: currentEmotion.value, costume,
      exclude: currentImage.value?.file,
    })
    if (!img) {
      log.warn('未找到匹配服装"%s"的图片', costume)
      return
    }
    currentCostume.value = costume
    currentImage.value = img
    syncToStore()
    log.debug('服装切换: %s, 图片: %s', costume, img.file)
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
    if (!img) {
      log.warn('setLook 未找到匹配图片: %o', look)
      return
    }
    if (look.pose) currentPoseTag.value = pose
    if (look.emotion) currentEmotion.value = emotion
    if (look.costume) currentCostume.value = costume
    currentImage.value = img
    syncToStore()
    log.info('外观批量更新: %o', look)
  }

  function setScreenPose(key: PoseKey) {
    if (ALL_POSE_KEYS.includes(key)) {
      currentScreenPose.value = key
      syncToStore()
      log.debug('屏幕位置切换: %s', key)
    }
  }

  // ======== 角色切换 ========
  async function switchCharacter(charId: string) {
    log.info('切换角色: %s', charId)
    await charStore.loadCharacter(charId)
    currentPoseTag.value = ''
    currentEmotion.value = ''
    currentCostume.value = ''
    syncDefaultsFromData()
    currentImage.value = selectCurrentImage()
    syncToStore()
    log.info('角色切换完成: %s (%s)', charId, charStore.name)
  }

  // ======== 监听 characterStore 视觉状态变化（会话恢复触发） ========
  watch(
    () => [charStore.currentEmotion, charStore.currentStance, charStore.currentCostume, charStore.currentScreenPose] as const,
    ([emotion, stance, costume, screenPose]) => {
      // 跳过自身同步导致的变更
      if (emotion === currentEmotion.value && stance === currentPoseTag.value &&
          costume === currentCostume.value && screenPose === currentScreenPose.value) return

      log.info('检测到外部视觉状态变更, 同步控制器: 情绪=%s 姿势=%s 服装=%s 位置=%s',
        emotion, stance, costume, screenPose)

      // 更新本地状态
      const changed = { emotion: false, stance: false, costume: false }
      if (emotion && emotion !== currentEmotion.value) {
        currentEmotion.value = emotion; changed.emotion = true
      }
      if (stance && stance !== currentPoseTag.value) {
        currentPoseTag.value = stance; changed.stance = true
      }
      if (costume && costume !== currentCostume.value) {
        currentCostume.value = costume; changed.costume = true
      }
      if (screenPose && screenPose !== currentScreenPose.value) {
        currentScreenPose.value = screenPose
      }

      // 如果有标签变化，重新选图
      if (changed.emotion || changed.stance || changed.costume) {
        currentImage.value = selectCurrentImage()
      }
    },
    { deep: false },
  )

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
    // 先尝试从 characterStore 恢复已有的视觉状态（会话恢复预制）
    const stored = charStore.getVisualStateSnapshot()
    const hasStoredState = stored.emotion || stored.stance || stored.costume
    if (hasStoredState) {
      currentPoseTag.value = stored.stance
      currentEmotion.value = stored.emotion
      currentCostume.value = stored.costume
      currentScreenPose.value = stored.screenPose
    } else {
      syncDefaultsFromData()
    }
    currentImage.value = selectCurrentImage()
    ready.value = true
    log.info('控制器初始化完成, 角色: %s (%s预制状态)',
      charStore.name, hasStoredState ? '有' : '无')
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
