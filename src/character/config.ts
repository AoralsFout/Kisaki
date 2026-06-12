/**
 * 角色配置 - 类型定义 + 工具函数
 *
 * 实际数据从 public/characters/<id>/character.json 动态加载。
 */
import type { CharacterData, CharacterImageData } from './loader'
export type { CharacterData, CharacterImageData }

// ==================== 标签类型 ====================

// 这些是通用标签类型，具体可用值由 JSON 中的 poses/emotions/costumes 决定
export type PoseTag = string
export type EmotionTag = string
export type CostumeTag = string

// 兼容旧接口：常用标签列表（仅在 JSON 未定义时用）
export const FALLBACK_EMOTIONS = [
  'idle', 'happy', 'thinking', 'sad', 'surprised',
  'doubt', 'sigh', 'angry', 'shy', 'sleepy',
]

// ==================== 工具函数 ====================

/** 筛选图片：按任意维度组合过滤 */
export function findImages(
  data: CharacterData,
  filters: {
    pose?: string
    emotion?: string
    costume?: string
  },
): CharacterImageData[] {
  return data.images.filter(img => {
    if (filters.pose && img.pose !== filters.pose) return false
    if (filters.costume && img.costume !== filters.costume) return false
    if (filters.emotion && !img.emotions.includes(filters.emotion)) return false
    return true
  })
}

/** 随机选一张匹配的图片 */
export function pickRandomImage(
  data: CharacterData,
  filters: {
    pose?: string
    emotion?: string
    costume?: string
    /** 排除这张图（尽量不重复选同一张） */
    exclude?: string
  },
): CharacterImageData | null {
  let images = findImages(data, filters)
  if (images.length > 1 && filters.exclude) {
    const filtered = images.filter(i => i.file !== filters.exclude)
    if (filtered.length > 0) images = filtered
  }
  if (images.length === 0) return null
  return images[Math.floor(Math.random() * images.length)]
}
