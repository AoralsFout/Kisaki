/**
 * 构建写盘用的 character.json 对象（纯函数，便于单测）。
 *
 * 关键：以 `{...data}` 起步，保留已有的 `render`/`live2d` 及任何未知字段，再按渲染
 * 类型覆盖该类型管理的字段——修复旧 saveAll「从零重建导致丢字段」的数据损坏问题。
 * `prompt` 单独存 prompt.txt，不写进 character.json（这里剔除）。
 */
import type { CharacterData, CharacterImageData, RenderKind, Live2DConfig } from './loader'

export interface CharacterEdits {
  /** 语音音色 ID（空串视为清除） */
  voice?: string
  voiceModel?: string
  voiceLanguage: string
  textLanguage: string
  // —— 立绘角色字段 ——
  poses?: string[]
  emotions?: string[]
  costumes?: string[]
  images?: CharacterImageData[]
  // —— Live2D 角色字段 —— 与既有 live2d 浅合并
  live2d?: Partial<Live2DConfig>
}

const CURRENT_VERSION = 2

export function buildCharacterJson(
  data: CharacterData,
  render: RenderKind,
  edits: CharacterEdits,
): Record<string, any> {
  const out: Record<string, any> = { ...data, version: CURRENT_VERSION, render }
  delete out.prompt // prompt 存 prompt.txt，不写进 character.json

  // 共用：语音 / 语言
  out.voice = edits.voice || undefined
  out.voiceModel = edits.voiceModel || undefined
  out.voiceLanguage = edits.voiceLanguage
  out.textLanguage = edits.textLanguage

  if (render === 'live2d') {
    out.live2d = { ...(data.live2d ?? {}), ...(edits.live2d ?? {}) }
  } else {
    if (edits.poses) out.poses = edits.poses
    if (edits.emotions) out.emotions = edits.emotions
    if (edits.costumes) out.costumes = edits.costumes
    if (edits.images) out.images = edits.images
  }

  return out
}
