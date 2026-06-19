/**
 * Live2D 穿透掩码（鼠标穿透像素级命中）
 *
 * 静态立绘的掩码来自 PNG（alphaMask.ts）；Live2D 是动态画布，故定期快照主 canvas
 * 元素（createImageBitmap → 降采样 2D → 读 alpha），供 passthrough 命中查表。
 *
 * 关键：Live2D 的 pixi Application 必须以 preserveDrawingBuffer:true 初始化，
 * 否则 createImageBitmap(canvas) 取到的 alpha 为空（见设计 §10.2 spike 结论）。
 * easy-live2d 的 Cubism 直接画到主帧缓冲，故快照主画布、而非 pixi 的 sprite RT。
 */
import type { AlphaMask } from './alphaMask'
import { createLogger } from '../utils/logger'

const log = createLogger('Live2DMask')

/** 降采样掩码最大宽度（与 alphaMask 同量级，平衡精度/开销） */
const MASK_MAX_WIDTH = 200
/** 快照间隔（约 8fps；轮廓变化缓慢，足够穿透命中用） */
const SNAPSHOT_INTERVAL = 120

let mask: AlphaMask | undefined
let timer: ReturnType<typeof setInterval> | null = null
let building = false

/** 取当前 Live2D 掩码（未就绪返回 undefined → 命中退回矩形） */
export function getLive2DMask(): AlphaMask | undefined {
  return mask
}

/** 对主 canvas 做一次快照，更新 alpha 掩码 */
async function snapshot(): Promise<void> {
  if (building) return
  const canvas = document.querySelector('canvas.live2d-canvas') as HTMLCanvasElement | null
  if (!canvas || canvas.width === 0 || canvas.height === 0) return
  building = true
  try {
    const bmp = await createImageBitmap(canvas)
    const ratio = bmp.width > MASK_MAX_WIDTH ? MASK_MAX_WIDTH / bmp.width : 1
    const w = Math.max(1, Math.round(bmp.width * ratio))
    const h = Math.max(1, Math.round(bmp.height * ratio))
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d', { willReadFrequently: true })
    if (!ctx) { bmp.close?.(); return }
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close?.()
    const { data } = ctx.getImageData(0, 0, w, h)
    const alpha = new Uint8ClampedArray(w * h)
    for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3]
    mask = { w, h, data: alpha }
  } catch {
    // 偶发快照失败忽略，下次重试（不清空旧掩码）
  } finally {
    building = false
  }
}

/** 启动定期快照（Live2DStage 模型 ready 后调用） */
export function startLive2DMask(): void {
  if (timer !== null) return
  timer = setInterval(() => { void snapshot() }, SNAPSHOT_INTERVAL)
  void snapshot()
  log.info('Live2D 穿透掩码已启动 (%dms)', SNAPSHOT_INTERVAL)
}

/** 停止快照并清空掩码（Live2DStage 卸载时调用） */
export function stopLive2DMask(): void {
  if (timer !== null) { clearInterval(timer); timer = null }
  mask = undefined
  log.info('Live2D 穿透掩码已停止')
}
