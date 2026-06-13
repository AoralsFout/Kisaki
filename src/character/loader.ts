/**
 * 角色 JSON 加载器
 *
 * 从 data_dir（Rust 侧管理：dev = <项目>/characters/，生产 = app_data_dir/characters/）
 * 加载角色配置。所有角色统一存放于 data_dir，不再有 web 静态预置资源。
 */
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { createLogger } from '../utils/logger'

const log = createLogger('CharLoader')

// 缓存版本号 — 调用 bustImageCache() 递增（保存/导入角色后）
let _imgVer = 0

// ─── data_dir 路径缓存（模块初始化时异步填充） ────────────

let _charactersPath: string = ''
let _dataDirReady = false
let _readyPromise: Promise<void> | null = null

/** 初始化 data_dir 路径（应在 App 启动时调用一次） */
export async function initCharacterDataDir(): Promise<void> {
  if (_readyPromise) return _readyPromise
  _readyPromise = (async () => {
    try {
      const dirs: any = await invoke('get_data_dirs')
      _charactersPath = String(dirs.characters ?? '')
      _dataDirReady = true
      log.info('data_dir 已就绪: %s', _charactersPath)
    } catch (err) {
      log.warn('get_data_dirs 失败（非 Tauri 环境?）: %s', (err as Error).message)
    }
  })()
  return _readyPromise
}

/** 强制刷新图片缓存（保存/导入角色后调用，递增版本号） */
export let bustImageCache = () => {
  _imgVer++
  log.debug('图片缓存已刷新, 版本: %d', _imgVer)
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

/** 图片完整 URL。所有角色文件统一存放于 data_dir，走 asset:// 协议读取。 */
export function imageUrl(charId: string, fileName: string): string {
  if (!_charactersPath) return ''  // data_dir 未就绪（非 Tauri 环境）
  return convertFileSrc(`${_charactersPath}/${charId}/images/${fileName}`)
}

/** 加载角色提示词（从 data_dir 读 prompt.txt，不存在则返回空串） */
async function loadPrompt(id: string): Promise<string> {
  if (_dataDirReady) {
    try {
      const text: string = await invoke('read_character_file', { id, filename: 'prompt.txt' })
      if (text) return text
    } catch { /* prompt.txt 不存在 */ }
  }
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

/** 加载单个角色配置（从 data_dir 读 character.json + prompt.txt） */
export async function loadCharacterJson(id: string): Promise<CharacterData> {
  log.debug('加载角色配置: %s', id)

  if (!_dataDirReady) {
    throw new Error(`data_dir 未就绪，无法加载角色 ${id}`)
  }

  let rawJson: string
  try {
    rawJson = await invoke('read_character_file', { id, filename: 'character.json' })
  } catch (err) {
    throw new Error(`加载角色 ${id} 失败: ${(err as Error).message}`)
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(rawJson)
  } catch {
    throw new Error(`角色 ${id} 配置文件格式异常（期望 JSON）`)
  }

  const data = migrateCharacterData(raw)
  data.prompt = await loadPrompt(id)
  log.info('角色配置已加载: %s (%s), %d 张立绘, 提示词 %d 字符', id, data.name, data.images.length, data.prompt.length)
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
