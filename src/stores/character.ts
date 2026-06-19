/**
 * 角色数据 Store (Pinia)
 *
 * 管理当前角色的 JSON 数据加载、切换，以及角色的实时视觉状态。
 * 视觉状态（情绪/姿势/服装/屏幕位置）存放在此，供 controller 和
 * session 管理共享读写。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadCharacterJson, listCharacters, imageUrl } from '../character/loader'
import type { CharacterData } from '../character/loader'
import { DEFAULT_POSE } from '../character/poses'
import type { PoseKey } from '../character/poses'
import { createLogger } from '../utils/logger'

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
      currentId.value = id
    } catch (err) {
      log.error('加载角色失败', err)
      throw err
    } finally {
      loading.value = false
    }
  }

  /** 刷新可用角色列表（同时加载所有角色的显示名称） */
  async function refreshList() {
    const { clearCache } = await import('../character/loader')
    clearCache()
    availableList.value = await listCharacters()
    // 异步加载每个角色的名称（静默失败，fallback 到 id）
    const names: Record<string, string> = {}
    const renders: Record<string, string> = {}
    await Promise.allSettled(availableList.value.map(async (id) => {
      try {
        const charData = await loadCharacterJson(id)
        names[id] = charData.name
        renders[id] = charData.render ?? 'illustration'
      } catch {
        names[id] = id.charAt(0).toUpperCase() + id.slice(1)
        renders[id] = 'illustration'
      }
    }))
    charNames.value = names
    charRenders.value = renders
  }

  /** 初始化（扫描列表 + 加载一个角色；零角色时保持 data=null 不崩） */
  async function init() {
    // 先扫描可用角色，再决定加载哪个
    await refreshList()
    const list = availableList.value
    if (list.length === 0) {
      // 干净安装 / 数据被清空：无角色，UI 显示空白桌宠 + 引导用户导入角色包
      log.warn('未发现任何角色，等待用户导入角色包')
      return
    }
    const target = list.includes('kisaki') ? 'kisaki' : list[0]
    try {
      await loadCharacter(target, true)
    } catch (err) {
      log.error('加载角色失败', err)
    }
  }

  // ── 视觉状态操作 ──

  /** 应用一组视觉状态（会话恢复时使用） */
  function applyVisualState(state: Partial<CharacterVisualState>) {
    if (state.emotion !== undefined) currentEmotion.value = state.emotion
    if (state.stance !== undefined) currentStance.value = state.stance
    if (state.costume !== undefined) currentCostume.value = state.costume
    if (state.screenPose !== undefined) currentScreenPose.value = state.screenPose
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

  return {
    currentId, data, loading, availableList,
    poses, emotions, costumes, name, prompt, render,
    currentEmotion, currentStance, currentCostume, currentScreenPose,
    getImageUrl, getCharacterName, getCharacterRender,
    applyVisualState, getVisualStateSnapshot,
    loadCharacter, refreshList, init,
  }
})
