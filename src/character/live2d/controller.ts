/**
 * Live2D 角色控制器
 *
 * 包装 easy-live2d 的 Live2DSprite，向 AI 工具暴露表情/动作/屏幕位置控制。
 * 与静态立绘的 useCharacterController 平行；由 Live2DStage 创建、在模型 ready 后
 * attach（注入 sprite + manifest），并注册到 agent 上下文供 Live2D 工具调用。
 *
 * 视觉状态复用 characterStore：表情存 `emotion` 字段、屏幕位置存 `screenPose`
 * （动作是瞬时的，不持久化），从而复用现有会话保存/恢复机制。
 */
import { ref } from 'vue'
import { Priority, type Live2DSprite } from 'easy-live2d'
import { useCharacterStore } from '../../stores/character'
import { useSessionStore } from '../../stores/session'
import { ALL_POSE_KEYS, type PoseKey } from '../poses'
import type { Live2DManifest } from './manifest'
import { createLogger } from '../../utils/logger'

const log = createLogger('Live2DCtrl')

export function useLive2DController() {
  const charStore = useCharacterStore()
  const ready = ref(false)
  const currentExpression = ref('')

  let sprite: Live2DSprite | null = null
  let manifest: Live2DManifest | null = null
  /** Live2DStage 注入：屏幕姿态变化后重新适配 sprite 变换 */
  let onScreenPose: (() => void) | null = null

  /** 模型 ready 后由 Live2DStage 注入 sprite + manifest */
  function attach(s: Live2DSprite, mf: Live2DManifest, opts?: { onScreenPose?: () => void }) {
    sprite = s
    manifest = mf
    onScreenPose = opts?.onScreenPose ?? null
    ready.value = true
    // 恢复会话中保存的表情（复用 emotion 字段）
    const restored = charStore.currentEmotion
    if (restored && mf.expressions.some(e => e.id === restored)) setExpression(restored)
  }

  function detach() {
    sprite = null
    manifest = null
    onScreenPose = null
    ready.value = false
    currentExpression.value = ''
  }

  /** 切换表情（→ sprite.setExpression），校验 manifest */
  function setExpression(id: string): boolean {
    if (!sprite || !manifest) return false
    if (!manifest.expressions.some(e => e.id === id)) {
      log.warn('未知表情: %s', id)
      return false
    }
    sprite.setExpression({ expressionId: id })
    currentExpression.value = id
    charStore.applyVisualState({ emotion: id }) // 复用 emotion 字段持久化
    log.info('表情切换: %s', id)
    return true
  }

  /** 播放动作（→ sprite.startMotion），校验 manifest */
  function playMotion(group: string, no = 0): boolean {
    if (!sprite || !manifest) return false
    if (!manifest.motions.some(m => m.group === group)) {
      log.warn('未知动作组: %s', group)
      return false
    }
    void sprite.startMotion({ group, no, priority: Priority.Normal })
    log.info('播放动作: %s[%d]', group, no)
    return true
  }

  /** 设置屏幕位置预设（复用 PoseKey；由 Live2DStage 折算为 sprite 变换） */
  function setScreenPose(key: PoseKey) {
    if (!ALL_POSE_KEYS.includes(key)) return
    charStore.applyVisualState({ screenPose: key })
    onScreenPose?.()
    log.info('屏幕位置: %s', key)
  }

  /** 渲染无关的角色切换（供 switch_character 工具复用） */
  async function switchCharacter(id: string) {
    log.info('切换角色: %s', id)
    await charStore.loadCharacter(id, true)
    useSessionStore().saveCurrentSession()
  }

  function getState() {
    return {
      character: charStore.name,
      expression: currentExpression.value,
      screenPose: charStore.currentScreenPose,
      expressions: manifest?.expressions ?? [],
      motions: manifest?.motions ?? [],
    }
  }

  return {
    ready, currentExpression, charStore,
    attach, detach,
    setExpression, playMotion, setScreenPose, switchCharacter, getState,
  }
}

export type Live2DController = ReturnType<typeof useLive2DController>
