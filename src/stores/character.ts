/**
 * 角色数据 Store (Pinia)
 *
 * 管理当前角色的 JSON 数据加载和切换。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadCharacterJson, listCharacters, imageUrl } from '../character/loader'
import type { CharacterData } from '../character/loader'

export const useCharacterStore = defineStore('character', () => {
  const currentId = ref('kisaki')
  const data = ref<CharacterData | null>(null)
  const loading = ref(false)
  const availableList = ref<string[]>([])

  // 计算当前角色的标签列表
  const poses = computed(() => data.value?.poses ?? [])
  const emotions = computed(() => data.value?.emotions ?? [])
  const costumes = computed(() => data.value?.costumes ?? [])
  const name = computed(() => data.value?.name ?? currentId.value)
  const prompt = computed(() => data.value?.prompt ?? '')

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
      console.error('加载角色失败:', err)
      throw err
    } finally {
      loading.value = false
    }
  }

  /** 刷新可用角色列表 */
  async function refreshList() {
    const { clearCache } = await import('../character/loader')
    clearCache()
    availableList.value = await listCharacters()
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
    getImageUrl,
    loadCharacter, refreshList, init,
  }
})
