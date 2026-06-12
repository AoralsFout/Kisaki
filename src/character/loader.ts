/**
 * 角色 JSON 加载器
 *
 * 从 data_dir（Rust 侧管理的 app_data_dir/characters）或
 * public/characters/<id>/ 加载角色配置。
 *
 * 优先级：data_dir（用户修改过的角色） > web 静态资源（预置角色）
 */
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { createLogger } from '../utils/logger'

const log = createLogger('CharLoader')

// 缓存版本号 — 调用 bustImageCache() 递增，替代 Date.now()
let _imgVer = 0

// ─── data_dir 路径缓存（模块初始化时异步填充） ────────────

let _charactersPath: string = ''
/** data_dir 中存在文件的角色 ID 集合（仅这些角色走 convertFileSrc 路径） */
let _dataCharIds: Set<string> = new Set()
let _dataDirReady = false
let _readyPromise: Promise<void> | null = null

/** 初始化 data_dir 路径并扫描已有角色（应在 App 启动时调用一次） */
export async function initCharacterDataDir(): Promise<void> {
  if (_readyPromise) return _readyPromise
  _readyPromise = (async () => {
    try {
      const dirs: any = await invoke('get_data_dirs')
      _charactersPath = String(dirs.characters ?? '')
      // 扫描 data_dir 中实际存在的角色（有 character.json 才算）
      const ids = await invoke('list_data_dir_characters') as string[]
      _dataCharIds = new Set(ids)
      _dataDirReady = true
      log.info('data_dir 已就绪: %s (%d 个角色)', _charactersPath, _dataCharIds.size)
    } catch (err) {
      log.warn('get_data_dirs 失败，将仅使用 web 静态路径: %s', (err as Error).message)
    }
  })()
  return _readyPromise
}

/** 强制刷新图片/数据缓存（保存角色后调用，同时刷新 data_dir 角色列表） */
export let bustImageCache = () => {
  _imgVer++
  log.debug('图片缓存已刷新, 版本: %d', _imgVer)
  // 保存后 data_dir 中可能新增角色，异步刷新列表
  invoke('list_data_dir_characters').then((ids) => {
    _dataCharIds = new Set(ids as string[])
  }).catch(() => {})
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

/** 图片完整 URL。仅当角色在 data_dir 中存在文件时使用 asset:// 路径；否则回退 web 静态路径。 */
export function imageUrl(charId: string, fileName: string): string {
  if (_charactersPath && _dataCharIds.has(charId)) {
    const filePath = `${_charactersPath}/${charId}/images/${fileName}`
    return convertFileSrc(filePath)
  }
  // data_dir 中无此角色 → web 静态路径（由 Vite/Tauri 从打包资源提供）
  return `/characters/${charId}/images/${fileName}`
}

/** 加版本号避免缓存（使用递增计数器替代 Date.now() 以利用浏览器缓存） */
function uncached(url: string): string {
  if (_imgVer === 0) return url  // 版本 0 = 不附加查询参数，可被缓存
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_v=${_imgVer}`
}

/** 加载角色提示词（优先 data_dir → web 静态路径） */
async function loadPrompt(id: string): Promise<string> {
  // 1. 尝试从 data_dir 读取（用户可能编辑过）
  if (_dataDirReady) {
    try {
      const text: string = await invoke('read_character_file', { id, filename: 'prompt.txt' })
      if (text) return text
    } catch { /* data_dir 中不存在，回退 web 路径 */ }
  }

  // 2. 回退 web 静态路径
  try {
    const res = await fetch(uncached(`/characters/${id}/prompt.txt`))
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

  // 1. 尝试从 data_dir 加载（用户修改过的版本优先）
  if (_dataDirReady) {
    try {
      const rawJson: string = await invoke('read_character_file', { id, filename: 'character.json' })
      const raw: Record<string, unknown> = JSON.parse(rawJson)
      const data = migrateCharacterData(raw)
      log.info('角色配置已加载（data_dir）: %s (%s), %d 张立绘', id, data.name, data.images.length)
      data.prompt = await loadPrompt(id)
      log.debug('角色提示词长度: %d 字符', data.prompt.length)
      return data
    } catch (err) {
      log.debug('data_dir 中未找到 %s，回退 web 路径: %s', id, (err as Error).message)
    }
  }

  // 2. 回退 web 静态路径
  const res = await fetch(uncached(`/characters/${id}/character.json`))
  if (!res.ok) {
    throw new Error(`加载角色 ${id} 失败: HTTP ${res.status}`)
  }
  // 防御：若服务器返回 HTML（如 404 页），解析会抛 SyntaxError；捕获并给出明确提示
  const text = await res.text()
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`角色 ${id} 配置文件格式异常（期望 JSON，实际收到非 JSON 响应）`)
  }
  const data = migrateCharacterData(raw)
  log.info('角色配置已加载（web）: %s (%s), %d 张立绘', id, data.name, data.images.length)
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
