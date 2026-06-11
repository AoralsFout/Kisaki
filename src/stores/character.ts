/**
 * 角色数据 Store (Pinia)
 *
 * 管理当前角色的 JSON 数据加载和切换。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadCharacterJson, listCharacters, imageUrl } from '../character/loader'
import type { CharacterData } from '../character/loader'
import { createLogger } from '../utils/logger'

const log = createLogger('CharacterStore')

export const useCharacterStore = defineStore('character', () => {
  const currentId = ref('kisaki')
  const data = ref<CharacterData | null>(null)
  const loading = ref(false)
  const availableList = ref<string[]>([])
  /** 角色 ID → 显示名称 缓存（供列表使用，避免逐个加载完整 JSON） */
  const charNames = ref<Record<string, string>>({})

  // 计算当前角色的标签列表
  const poses = computed(() => data.value?.poses ?? [])
  const emotions = computed(() => data.value?.emotions ?? [])
  const costumes = computed(() => data.value?.costumes ?? [])
  const name = computed(() => data.value?.name ?? currentId.value)
  const prompt = computed(() => data.value?.prompt ?? '')

  /** 获取角色的显示名称（缓存不到时 fallback 为 id 首字母大写） */
  function getCharacterName(id: string): string {
    return charNames.value[id] || id.charAt(0).toUpperCase() + id.slice(1)
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
    await Promise.allSettled(availableList.value.map(async (id) => {
      try {
        const charData = await loadCharacterJson(id)
        names[id] = charData.name
      } catch {
        names[id] = id.charAt(0).toUpperCase() + id.slice(1)
      }
    }))
    charNames.value = names
  }

  /** 初始化（加载默认角色 + 扫描列表） */
  async function init() {
    await Promise.all([
      loadCharacter('kisaki'),
      refreshList(),
    ])
  }

  return {
    currentId, data, loading, availableList,
    poses, emotions, costumes, name, prompt,
    getImageUrl, getCharacterName,
    loadCharacter, refreshList, init,
  }
})
