/**
 * 角色 JSON 加载器
 *
 * 从 public/character/<id>/ 加载角色配置：
 * - character.json：元数据、标签、图片列表
 * - prompt.txt：    系统提示词（单独文件，避免 JSON 臃肿）
 */

import { createLogger } from '../utils/logger'

const log = createLogger('CharLoader')

// 缓存版本号 — 调用 bustImageCache() 递增，替代 Date.now()
let _imgVer = 0

/** 强制刷新图片/数据缓存（保存角色后调用） */
export function bustImageCache() {
  _imgVer++
  log.debug('图片缓存已刷新, 版本: %d', _imgVer)
}

/** 获取当前缓存版本号 */
export function getImageCacheVersion(): number {
  return _imgVer
}

export interface CharacterImageData {
  file: string
  pose: string
  costume: string
  emotions: string[]
}

export interface CharacterData {
  id: string
  name: string
  description: string
  version: number
  /** 系统提示词（JSON 中的可选字段，优先读取同目录下的 prompt.txt） */
  prompt: string
  poses: string[]
  emotions: string[]
  costumes: string[]
  images: CharacterImageData[]
  /** 语音合成音色 ID（CosyVoice 自定义音色） */
  voice?: string
  /** 语音合成模型 */
  voiceModel?: string
  /** TTS 合成用语言，如 "ja-JP"、"zh-CN"、"en-US" */
  voiceLanguage?: string
  /** 默认文本显示语言，如 "zh-CN"、"en-US"、"ja-JP" */
  textLanguage?: string
}

/** 图片完整 URL */
export function imageUrl(charId: string, fileName: string): string {
  return `/character/${charId}/images/${fileName}`
}

/** 加版本号避免缓存（使用递增计数器替代 Date.now() 以利用浏览器缓存） */
function uncached(url: string): string {
  if (_imgVer === 0) return url  // 版本 0 = 不附加查询参数，可被缓存
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_v=${_imgVer}`
}

/** 加载角色提示词（优先 prompt.txt，再 fallback JSON 内字段） */
async function loadPrompt(id: string): Promise<string> {
  try {
    const res = await fetch(uncached(`/character/${id}/prompt.txt`))
    if (res.ok) return await res.text()
  } catch { /* fallback */ }
  return ''
}

/** 当前支持的 schema 版本 */
const CURRENT_VERSION = 1

/** 数据迁移：将旧版本角色数据升级到最新格式 */
function migrateCharacterData(raw: Record<string, unknown>): CharacterData {
  const version = (raw.version as number) || 0
  let data = { ...raw } as Record<string, unknown>

  // v0 → v1：补全缺失字段
  if (version < CURRENT_VERSION) {
    data = {
      ...data,
      version: CURRENT_VERSION,
      poses: data.poses || ['standing'],
      emotions: data.emotions || ['idle'],
      costumes: data.costumes || ['default'],
      images: data.images || [],
      voice: data.voice || '',
      voiceModel: data.voiceModel || '',
      voiceLanguage: data.voiceLanguage || 'ja-JP',
      textLanguage: data.textLanguage || 'zh-CN',
    }
    log.info('数据迁移: v0 → v1')
  }

  return data as unknown as CharacterData
}

/** 加载单个角色配置 */
export async function loadCharacterJson(id: string): Promise<CharacterData> {
  log.debug('加载角色配置: %s', id)
  const res = await fetch(uncached(`/character/${id}/character.json`))
  if (!res.ok) {
    log.warn('加载角色 %s 失败: HTTP %d', id, res.status)
    throw new Error(`加载角色 ${id} 失败: HTTP ${res.status}`)
  }
  const raw: Record<string, unknown> = await res.json()
  const data = migrateCharacterData(raw)
  log.info('角色配置已加载: %s (%s), %d 张立绘', id, data.name, data.images.length)

  // 加载提示词（prompt.txt 优先）
  data.prompt = await loadPrompt(id)
  log.debug('角色提示词长度: %d 字符', data.prompt.length)

  return data
}

let cachedList: string[] | null = null

/** 扫描可用角色列表（通过 Tauri 后端扫描目录） */
export async function listCharacters(): Promise<string[]> {
  if (cachedList) {
    log.debug('角色列表(缓存): %d 个', cachedList.length)
    return cachedList
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const list: string[] = await invoke('list_characters')
    cachedList = list
    log.info('扫描到 %d 个角色: %s', list.length, list.join(', '))
    return list
  } catch {
    log.warn('listCharacters 失败（非 Tauri 环境?）')
    return []
  }
}

/** 清空角色缓存 */
export function clearCache() {
  cachedList = null
}
