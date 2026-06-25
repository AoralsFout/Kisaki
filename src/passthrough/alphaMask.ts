/**
 * 立绘 alpha 掩码（鼠标穿透像素级命中）
 *
 * 用 fetch → blob → createImageBitmap → 离屏 canvas 降采样 → getImageData
 * 提取立绘 PNG 的 alpha 通道，降采样后缓存供命中查表。
 *
 * 关键：立绘走 asset:// 跨源协议，直接把 <img> 画进 canvas 会污染、无法读像素；
 * 但 fetch 得到的 blob 数据被视为同源，createImageBitmap(blob) 画入 canvas
 * 不污染，可正常 getImageData。CSP `connect-src http:` 允许 fetch asset。
 * 以图片 URL 作缓存键（与 <img>.src 一致），命中时直接查表。
 */
import { createLogger } from '../utils/logger'

const log = createLogger('AlphaMask')

/** 降采样掩码最大宽度（高度按比例），平衡精度与内存 / 构建耗时 */
const MASK_MAX_WIDTH = 256

export interface AlphaMask {
  w: number
  h: number
  /** 长度 w*h 的 alpha 值（0-255），行优先 */
  data: Uint8ClampedArray
}

/** url → 掩码缓存。值为 'pending' 表示构建中，防止重复构建 */
const cache = new Map<string, AlphaMask | 'pending'>()
/** 正在执行中的构建 Promise，供重复调用者等待同一 URL 的构建完成 */
const pendingPromises = new Map<string, Promise<void>>()

/** 取已构建的掩码（构建中或未构建返回 undefined → 命中退回矩形） */
export function getMask(url: string): AlphaMask | undefined {
  const m = cache.get(url)
  return m && m !== 'pending' ? m : undefined
}

/**
 * 构建并缓存某图的 alpha 掩码（幂等）。
 * - 已缓存（含构建中）：若同 URL 有正在执行的构建则等待它完成，否则直接返回。
 * - 未缓存：启动构建，返回 Promise，并发调用者可复用同一 Promise。
 */
export async function buildMask(url: string): Promise<void> {
  if (!url) return
  // 已有缓存（含 'pending'）→ 若有在途构建则等它完成
  if (cache.has(url)) {
    const p = pendingPromises.get(url)
    if (p) await p
    return
  }

  cache.set(url, 'pending')
  const promise = _build(url)
  pendingPromises.set(url, promise)
  try {
    await promise
  } finally {
    pendingPromises.delete(url)
  }
}

async function _build(url: string): Promise<void> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const bmp = await createImageBitmap(blob)

    const ratio = bmp.width > MASK_MAX_WIDTH ? MASK_MAX_WIDTH / bmp.width : 1
    const w = Math.max(1, Math.round(bmp.width * ratio))
    const h = Math.max(1, Math.round(bmp.height * ratio))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建 2D 上下文')
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()

    const { data } = ctx.getImageData(0, 0, w, h)
    // 仅保留 alpha 通道（1/4 内存）
    const alpha = new Uint8ClampedArray(w * h)
    for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3]

    cache.set(url, { w, h, data: alpha })
    log.debug('alpha 掩码已构建 %dx%d: %s', w, h, url)
  } catch (e) {
    cache.delete(url)
    log.warn('alpha 掩码构建失败（退回矩形命中）: %s', (e as Error).message)
  }
}
