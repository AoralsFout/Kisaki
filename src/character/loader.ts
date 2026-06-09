/**
 * 角色 JSON 加载器
 *
 * 从 public/character/<id>/ 加载角色配置：
 * - character.json：元数据、标签、图片列表
 * - prompt.txt：    系统提示词（单独文件，避免 JSON 臃肿）
 */

// 缓存版本号 — 调用 bustImageCache() 递增，替代 Date.now()
let _imgVer = 0

/** 强制刷新图片/数据缓存（保存角色后调用） */
export function bustImageCache() {
  _imgVer++
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

/** 加载单个角色配置 */
export async function loadCharacterJson(id: string): Promise<CharacterData> {
  const res = await fetch(uncached(`/character/${id}/character.json`))
  if (!res.ok) throw new Error(`加载角色 ${id} 失败: HTTP ${res.status}`)
  const data: CharacterData = await res.json()

  // 加载提示词（prompt.txt 优先）
  data.prompt = await loadPrompt(id)

  return data
}

let cachedList: string[] | null = null

/** 扫描可用角色列表（通过 Tauri 后端扫描目录） */
export async function listCharacters(): Promise<string[]> {
  if (cachedList) return cachedList

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const list: string[] = await invoke('list_characters')
    cachedList = list
    return list
  } catch {
    // 非 Tauri 环境回退
    return []
  }
}

/** 清空角色缓存 */
export function clearCache() {
  cachedList = null
}
