/**
 * 角色 JSON 加载器
 *
 * 从 public/character/<id>/ 加载角色配置：
 * - character.json：元数据、标签、图片列表
 * - prompt.txt：    系统提示词（单独文件，避免 JSON 臃肿）
 */

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

/** 加载角色提示词（优先 prompt.txt，再 fallback JSON 内字段） */
async function loadPrompt(id: string): Promise<string> {
  try {
    const res = await fetch(`/character/${id}/prompt.txt`)
    if (res.ok) return await res.text()
  } catch { /* fallback */ }
  return ''
}

/** 加载单个角色配置 */
export async function loadCharacterJson(id: string): Promise<CharacterData> {
  const res = await fetch(`/character/${id}/character.json`)
  if (!res.ok) throw new Error(`加载角色 ${id} 失败: HTTP ${res.status}`)
  const data: CharacterData = await res.json()

  // 加载提示词（prompt.txt 优先）
  data.prompt = await loadPrompt(id)

  return data
}

/** 内置角色 ID 列表 */
const BUILTIN_CHARACTERS = [
  'kisaki', 'chryso', 'kanade', 'kanata', 'misaki',
  'nagisa', 'rio', 'yamiko', 'yoruko',
]

let cachedList: string[] | null = null

/** 扫描可用角色列表 */
export async function listCharacters(): Promise<string[]> {
  if (cachedList) return cachedList

  const available: string[] = []
  for (const id of BUILTIN_CHARACTERS) {
    try {
      const res = await fetch(`/character/${id}/character.json`)
      if (res.ok) available.push(id)
    } catch { /* skip */ }
  }

  cachedList = available
  return available
}

/** 清空角色缓存 */
export function clearCache() {
  cachedList = null
}
