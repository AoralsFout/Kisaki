/**
 * 鼠标穿透管理器（仅主窗口）
 *
 * 主窗口透明，目标：鼠标在立绘实体 / UI 控件上正常交互，在透明 / 空白区
 * 点击穿透到下方窗口。Tauri 只提供整窗开关 setIgnoreCursorEvents（无 per-pixel），
 * 故由 Rust 端轮询全局光标位置 emit('cursor-pos')，前端在此做命中测试，
 * 仅在「实体 ↔ 透明」翻转时切换整窗穿透，以此模拟逐元素穿透。
 *
 * 命中 = UI 命中（elementFromPoint 命中带 data-pet-solid 的元素）
 *      或 立绘命中（当前底层立绘 .img-base 的可视矩形；阶段 2 升级为 alpha 像素）。
 */
import { ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { EVENT_CURSOR_POS, STORAGE_PASSTHROUGH_ENABLED } from '../constants'
import { getMask, buildMask, type AlphaMask } from './alphaMask'
import { getLive2DMask } from './live2dMask'
import { createLogger } from '../utils/logger'

const log = createLogger('Passthrough')

/** 窗口内容区左上角的物理屏幕坐标（decorations:false → outer == inner） */
let winPos = { x: 0, y: 0 }
/** 设备像素缩放（物理 / CSS） */
let scale = 1
/** 总开关：关闭时恢复普通交互、忽略光标事件 */
let enabled = readEnabled()
/** 当前 setIgnoreCursorEvents 状态，仅在翻转时调用，避免每帧 IPC */
let ignoring: boolean | null = null
/** 当前是否处于穿透态（true=透明区可穿透；false=实体可交互），供 UI 状态指示 */
export const isIgnoring = ref(false)
/** 是否已初始化（防重复 listen） */
let inited = false

function readEnabled(): boolean {
  const v = localStorage.getItem(STORAGE_PASSTHROUGH_ENABLED)
  return v === null ? true : v === '1'
}

/** alpha 命中阈值：alpha 低于此值视为透明（可穿透） */
const ALPHA_THRESHOLD = 16

/**
 * 通用命中：矩形粗筛 + alpha 像素精筛。掩码未就绪时退回矩形命中（点已在矩形内）。
 * (u,v) 线性映射依赖显示区无 letterbox：立绘 img 用 height:100%+contain，
 * Live2D canvas 内容铺满画布，二者皆满足。
 */
function hitAlphaRect(cx: number, cy: number, r: DOMRect, mask: AlphaMask | undefined): boolean {
  if (r.width === 0 || r.height === 0) return false
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return false
  if (!mask) return true
  const u = (cx - r.left) / r.width
  const v = (cy - r.top) / r.height
  const mx = Math.min(mask.w - 1, Math.max(0, (u * mask.w) | 0))
  const my = Math.min(mask.h - 1, Math.max(0, (v * mask.h) | 0))
  return mask.data[my * mask.w + mx] > ALPHA_THRESHOLD
}

/**
 * 角色命中测试：立绘用 .img-base + PNG alpha 掩码；Live2D 用 .live2d-canvas +
 * 定期快照的 alpha 掩码（见 live2dMask.ts）。两者互斥（同一时刻只渲染一种）。
 */
function hitCharacter(cx: number, cy: number): boolean {
  const img = document.querySelector('img.img-base') as HTMLImageElement | null
  if (img) {
    // 图片未加载完成时无实际可见内容 → 穿透
    if (!img.complete) return false
    return hitAlphaRect(cx, cy, img.getBoundingClientRect(), getMask(img.src))
  }

  const canvas = document.querySelector('canvas.live2d-canvas') as HTMLCanvasElement | null
  if (canvas) return hitAlphaRect(cx, cy, canvas.getBoundingClientRect(), getLive2DMask())

  return false
}

/** 命中测试：true = 实体（应交互，不穿透） */
function hitTest(cx: number, cy: number): boolean {
  // img 是 pointer-events:none，elementFromPoint 不会返回它 → UI 与立绘分别判定。
  // 背景容器（.app-container/.character-area/.character-container）不带 data-pet-solid，
  // 故空白区返回它们时 closest 为 null，再交由立绘命中判定。
  const el = document.elementFromPoint(cx, cy) as HTMLElement | null
  if (el && el.closest('[data-pet-solid]')) return true
  return hitCharacter(cx, cy)
}

async function setIgnore(v: boolean) {
  if (v === ignoring) return
  ignoring = v
  isIgnoring.value = v
  try {
    await getCurrentWindow().setIgnoreCursorEvents(v)
  } catch (e) {
    log.warn('setIgnoreCursorEvents 失败: %s', (e as Error).message)
  }
}

/** 初始化鼠标穿透（仅主窗口调用一次） */
export async function initPassthrough(): Promise<void> {
  if (inited) return
  inited = true

  const w = getCurrentWindow()
  try {
    const p = await w.outerPosition()
    winPos = { x: p.x, y: p.y }
    scale = await w.scaleFactor()
    await w.onMoved(({ payload }) => { winPos = { x: payload.x, y: payload.y } })
    await w.onScaleChanged(({ payload }) => { scale = payload.scaleFactor })
  } catch (e) {
    log.warn('窗口几何初始化失败（非 Tauri 环境?）: %s', (e as Error).message)
    return
  }

  // 预构建立绘 alpha 掩码：在注册光标监听器前确保 mask 就绪，
  // 避免首次启动时 mask 异步构建未完成导致穿透/实体误判。
  const initialImg = document.querySelector('img.img-base') as HTMLImageElement | null
  if (initialImg?.src) {
    await buildMask(initialImg.src)
  }

  await listen<{ x: number; y: number }>(EVENT_CURSOR_POS, ({ payload }) => {
    if (!enabled) return
    const cx = (payload.x - winPos.x) / scale
    const cy = (payload.y - winPos.y) / scale
    void setIgnore(!hitTest(cx, cy))
  })

  log.info('鼠标穿透已初始化 (enabled=%s)', enabled)
}

/** 设置穿透开关并持久化（关闭时立即恢复普通交互，防 bug 锁死无法操作） */
export function setPassthroughEnabled(on: boolean): void {
  enabled = on
  localStorage.setItem(STORAGE_PASSTHROUGH_ENABLED, on ? '1' : '0')
  if (!on) void setIgnore(false)
  log.info('鼠标穿透开关: %s', on)
}

export function isPassthroughEnabled(): boolean {
  return enabled
}
