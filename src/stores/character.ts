/**
 * 角色数据 Store (Pinia)
 *
 * 管理当前角色的 JSON 数据加载、切换，以及角色的实时视觉状态。
 * 视觉状态（情绪/姿势/服装/屏幕位置）存放在此，供 controller 和
 * session 管理共享读写。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { clearCache, loadCharacterJson, listCharacterSummaries, imageUrl } from '../character/loader'
import type { CharacterData } from '../character/loader'
import { findImages } from '../character/config'
import { ALL_POSE_KEYS, DEFAULT_POSE } from '../character/poses'
import type { PoseKey } from '../character/poses'
import { createLogger } from '../utils/logger'
import {
  CharacterRuntime,
  type CharacterCapabilities,
  type CharacterRenderer,
  type CharacterRuntimeSnapshot,
  type CharacterRenderKind,
} from '../application/character/characterRuntime'

const log = createLogger('CharacterStore')

export interface CharacterVisualState {
  emotion: string
  stance: string
  costume: string
  screenPose: PoseKey
}

export const useCharacterStore = defineStore('character', () => {
  const currentId = ref('kisaki')
  const data = ref<CharacterData | null>(null)
  const loading = ref(false)
  const availableList = ref<string[]>([])
  /** 角色 ID → 显示名称 缓存（供列表使用，避免逐个加载完整 JSON） */
  const charNames = ref<Record<string, string>>({})
  /** 角色 ID → 渲染类型 缓存（列表徽标用） */
  const charRenders = ref<Record<string, string>>({})

  // ── 角色视觉状态（供 controller + session 共享） ──
  const currentEmotion = ref('')
  const currentStance = ref('')
  const currentCostume = ref('')
  const currentScreenPose = ref<PoseKey>(DEFAULT_POSE)
  const runtime = new CharacterRuntime(error => {
    log.error('character_runtime.renderer_failed', '角色渲染器应用状态失败', error)
  })
  let pendingVisualState: Partial<CharacterVisualState> | null = null

  runtime.subscribe(snapshot => {
    if (!snapshot.characterId || !snapshot.look) return
    currentId.value = snapshot.characterId
    currentEmotion.value = snapshot.look.emotion
    currentStance.value = snapshot.look.stance
    currentCostume.value = snapshot.look.costume
    currentScreenPose.value = snapshot.look.screenPose as PoseKey
  })

  // 计算当前角色的标签列表
  const poses = computed(() => data.value?.poses ?? [])
  const emotions = computed(() => data.value?.emotions ?? [])
  const costumes = computed(() => data.value?.costumes ?? [])
  const name = computed(() => data.value?.name ?? currentId.value)
  const prompt = computed(() => data.value?.prompt ?? '')
  /** 渲染方式：'illustration'（默认）| 'live2d' */
  const render = computed(() => data.value?.render ?? 'illustration')

  /** 获取角色的显示名称（缓存不到时 fallback 为 id 首字母大写） */
  function getCharacterName(id: string): string {
    return charNames.value[id] || id.charAt(0).toUpperCase() + id.slice(1)
  }

  /** 获取角色渲染类型（列表徽标用；缺省 illustration） */
  function getCharacterRender(id: string): string {
    return charRenders.value[id] || 'illustration'
  }

  /** 获取图片的完整 URL */
  function getImageUrl(fileName: string): string {
    return imageUrl(currentId.value, fileName)
  }

  /** 加载指定角色（force=true 跳过缓存强制重新加载） */
  async function loadCharacter(id: string, force?: boolean) {
    if (!force && id === currentId.value && data.value) return
    loading.value = true
    try {
      const charData = await loadCharacterJson(id)
      data.value = charData
      const pending = pendingVisualState
      pendingVisualState = null
      const supported = <T extends string>(value: T | undefined, values: readonly T[], fallback: T): T => (
        value !== undefined && values.includes(value) ? value : fallback
      )
      const defaultEmotion = charData.emotions[0] ?? ''
      const defaultStance = charData.poses[0] ?? ''
      const defaultCostume = charData.costumes[0] ?? ''
      runtime.selectCharacter({
        id,
        render: charData.render ?? 'illustration',
        capabilities: {
          emotions: charData.emotions,
          stances: charData.poses,
          costumes: charData.costumes,
          screenPoses: ALL_POSE_KEYS,
          motions: [],
          emotionDescriptions: {},
        },
        defaults: {
          emotion: supported(pending?.emotion, charData.emotions, defaultEmotion),
          stance: supported(pending?.stance, charData.poses, defaultStance),
          costume: supported(pending?.costume, charData.costumes, defaultCostume),
          screenPose: pending?.screenPose && ALL_POSE_KEYS.includes(pending.screenPose)
            ? pending.screenPose
            : currentScreenPose.value,
        },
      })
    } catch (err) {
      log.error("character_store.load_character.error", "加载角色失败", err)
      throw err
    } finally {
      loading.value = false
    }
  }

  /** 刷新可用角色列表及轻量元数据（显示名称/渲染类型） */
  async function refreshList() {
    clearCache()
    const summaries = await listCharacterSummaries()
    availableList.value = summaries.map(item => item.id)
    const names: Record<string, string> = {}
    const renders: Record<string, string> = {}
    for (const summary of summaries) {
      const id = summary.id
      names[id] = summary.name || id.charAt(0).toUpperCase() + id.slice(1)
      renders[id] = summary.render || 'illustration'
    }
    charNames.value = names
    charRenders.value = renders
  }

  /**
   * 初始化（扫描列表 + 加载一个角色；零角色时保持 data=null 不崩）。
   * preferredId 用于启动时直接加载上次会话的角色，避免先加载默认角色再切换。
   */
  async function init(preferredId?: string) {
    // 先扫描可用角色，再决定加载哪个
    await refreshList()
    const list = availableList.value
    if (list.length === 0) {
      // 干净安装 / 数据被清空：无角色，UI 显示空白桌宠 + 引导用户导入角色包
      log.warn("character_store.init.warn", "未发现任何角色，等待用户导入角色包")
      return
    }
    const target = preferredId && list.includes(preferredId)
      ? preferredId
      : (list.includes('kisaki') ? 'kisaki' : list[0])
    try {
      await loadCharacter(target, true)
    } catch (err) {
      log.error("character_store.init.error", "加载角色失败", err)
    }
  }

  // ── 视觉状态操作 ──

  /**
   * 应用一组视觉状态（会话/检查点恢复时使用）。
   * 走 Runtime 的 best-effort 入口：持久化数据里的标签可能不属于当前角色
   * （换角色、Live2D 能力收敛到 manifest 之后），恢复失败不应该中断会话加载。
   */
  function applyVisualState(state: Partial<CharacterVisualState>) {
    if (!runtime.snapshot().characterId) {
      pendingVisualState = { ...pendingVisualState, ...state }
      return
    }
    runtime.restoreLook(state)
  }

  /** 获取当前视觉状态快照（会话保存时使用） */
  function getVisualStateSnapshot(): CharacterVisualState {
    return {
      emotion: currentEmotion.value,
      stance: currentStance.value,
      costume: currentCostume.value,
      screenPose: currentScreenPose.value,
    }
  }

  function attachRenderer(kind: CharacterRenderKind, renderer: CharacterRenderer): () => void {
    return runtime.attachRenderer(kind, renderer)
  }

  function getRuntimeSnapshot(): CharacterRuntimeSnapshot {
    return runtime.snapshot()
  }

  function updateRuntimeCapabilities(change: Partial<CharacterCapabilities>): void {
    runtime.updateCapabilities(change)
  }

  /**
   * 处理来自 UI/Agent 的外观意图。Runtime 是状态 Owner；Store 只负责把立绘的
   * 非法标签组合解析为可渲染组合，避免调用方依赖具体 renderer controller。
   */
  function setVisualLook(change: Partial<Pick<CharacterVisualState, 'emotion' | 'stance' | 'costume'>>): boolean {
    const charData = data.value
    const snapshot = runtime.snapshot()
    if (!charData || !snapshot.look) return false

    let stance = change.stance ?? snapshot.look.stance
    const emotion = change.emotion ?? snapshot.look.emotion
    const costume = change.costume ?? snapshot.look.costume

    if ((charData.render ?? 'illustration') === 'illustration') {
      let matches = findImages(charData, { pose: stance, emotion, costume })
      if (!matches.length && change.emotion && change.stance === undefined) {
        const compatibleStance = charData.poses.find(candidate => (
          findImages(charData, { pose: candidate, emotion, costume }).length > 0
        ))
        if (compatibleStance) {
          stance = compatibleStance
          matches = findImages(charData, { pose: stance, emotion, costume })
        }
      }
      if (!matches.length) return false
    }

    try {
      runtime.setLook({ stance, emotion, costume })
      return true
    } catch (error) {
      log.warn('character_store.set_visual_look.warn', '角色外观能力校验失败', error)
      return false
    }
  }

  function setScreenPose(screenPose: PoseKey): boolean {
    if (!ALL_POSE_KEYS.includes(screenPose)) return false
    try {
      runtime.setLook({ screenPose })
      return true
    } catch {
      return false
    }
  }

  function hasActiveRenderer(): boolean {
    return runtime.hasActiveRenderer()
  }

  function playMotion(group: string, index = 0): Promise<boolean> {
    return runtime.executeRendererCommand({ type: 'play-motion', group, index })
  }

  return {
    currentId, data, loading, availableList,
    poses, emotions, costumes, name, prompt, render,
    currentEmotion, currentStance, currentCostume, currentScreenPose,
    getImageUrl, getCharacterName, getCharacterRender,
    applyVisualState, setVisualLook, setScreenPose, playMotion,
    getVisualStateSnapshot, attachRenderer, getRuntimeSnapshot, updateRuntimeCapabilities, hasActiveRenderer,
    loadCharacter, refreshList, init,
  }
})
