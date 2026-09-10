/**
 * Live2D 角色控制器
 *
 * 包装 easy-live2d 的 Live2DSprite，作为 CharacterRuntime renderer adapter。
 * 由 Live2DStage 创建、在模型 ready 后 attach（注入 sprite + manifest）。
 *
 * 视觉状态复用 characterStore：表情存 `emotion` 字段、屏幕位置存 `screenPose`
 * （动作是瞬时的，不持久化），从而复用现有会话保存/恢复机制。
 */
import { ref } from 'vue'
import { Priority, type Live2DSprite } from 'easy-live2d'
import { useCharacterStore } from '../../stores/character'
import type { Live2DManifest } from './manifest'
import type { CharacterRuntimeSnapshot } from '../../application/character/characterRuntime'
import type { CharacterRendererCommand } from '../../application/character/characterRuntime'
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
  let detachRenderer: (() => void) | null = null

  function applyRuntimeSnapshot(snapshot: CharacterRuntimeSnapshot) {
    if (!sprite || !manifest || !snapshot.look) return
    const expression = snapshot.look.emotion
    if (expression && expression !== currentExpression.value && manifest.expressions.some(e => e.id === expression)) {
      sprite.setExpression({ expressionId: expression })
      currentExpression.value = expression
    }
    onScreenPose?.()
  }

  function executeRuntimeCommand(command: CharacterRendererCommand): boolean {
    if (command.type === 'play-motion') return playMotion(command.group, command.index)
    return false
  }

  /** 模型 ready 后由 Live2DStage 注入 sprite + manifest */
  function attach(s: Live2DSprite, mf: Live2DManifest, opts?: { onScreenPose?: () => void }) {
    sprite = s
    manifest = mf
    onScreenPose = opts?.onScreenPose ?? null
    ready.value = true
    charStore.updateRuntimeCapabilities({
      emotions: mf.expressions.map(expression => expression.id),
      emotionDescriptions: Object.fromEntries(mf.expressions.map(expression => [expression.id, expression.desc])),
      motions: mf.motions.map(motion => ({
        group: motion.group,
        count: motion.count,
        description: motion.desc,
      })),
    })
    detachRenderer?.()
    detachRenderer = charStore.attachRenderer('live2d', {
      apply: applyRuntimeSnapshot,
      execute: executeRuntimeCommand,
    })
  }

  function detach() {
    detachRenderer?.()
    detachRenderer = null
    sprite = null
    manifest = null
    onScreenPose = null
    ready.value = false
    currentExpression.value = ''
  }

  /** 播放动作（→ sprite.startMotion），校验 manifest */
  function playMotion(group: string, no = 0): boolean {
    if (!sprite || !manifest) return false
    if (!manifest.motions.some(m => m.group === group)) {
      log.warn("live2_dctrl.play_motion.warn", `未知动作组: ${group}`, undefined, { group: group })
      return false
    }
    void sprite.startMotion({ group, no, priority: Priority.Normal })
    log.info("live2_dctrl.play_motion.info", `播放动作: ${group}[${no}]`, { group: group, no: no })
    return true
  }

  /** Live2D 口型：用 easy-live2d playVoice 播放语音并驱动口型；signal 中止即停 */
  async function speakVoice(url: string, signal: AbortSignal): Promise<void> {
    const s = sprite
    if (!s) return
    const onAbort = () => { try { s.stopVoice() } catch { /* ignore */ } }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await s.playVoice({ voicePath: url })
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    ready,
    attach, detach,
    speakVoice,
  }
}

export type Live2DController = ReturnType<typeof useLive2DController>
