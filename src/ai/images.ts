import type { ImageAttachment } from './types'

export const MAX_IMAGE_COUNT = 4
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

export const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export type ImageValidationError = 'unsupported' | 'tooLarge' | 'tooMany' | 'totalTooLarge'

export interface ImageValidationResult {
  accepted: File[]
  error?: ImageValidationError
}

/**
 * 统一校验选择器和剪贴板中的图片。限制与常见 OpenAI 兼容视觉接口保持一致，
 * 避免把无法识别的格式或过大的 base64 请求送入会话。
 */
export function validateImageFiles(
  files: Iterable<File>,
  existing: readonly ImageAttachment[] = [],
): ImageValidationResult {
  const accepted: File[] = []
  let error: ImageValidationError | undefined
  let total = existing.reduce((sum, image) => sum + image.size, 0)
  let count = existing.length

  for (const file of files) {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      error ??= 'unsupported'
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      error ??= 'tooLarge'
      continue
    }
    if (count >= MAX_IMAGE_COUNT) {
      error ??= 'tooMany'
      continue
    }
    if (total + file.size > MAX_TOTAL_IMAGE_BYTES) {
      error ??= 'totalTooLarge'
      continue
    }
    accepted.push(file)
    total += file.size
    count++
  }

  return { accepted, error }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('图片读取结果无效'))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 把浏览器 File 转为可预览、可直接发送给兼容 API 的附件。 */
export async function createImageAttachment(file: File): Promise<ImageAttachment> {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name || `clipboard-${Date.now()}.png`,
    mimeType: file.type,
    dataUrl: await readAsDataUrl(file),
    size: file.size,
  }
}
