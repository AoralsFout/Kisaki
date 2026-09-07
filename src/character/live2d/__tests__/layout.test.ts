import { describe, expect, it } from 'vitest'
import { calculateLive2DLayout } from '../layout'
import { POSE_PRESETS } from '../../poses'

describe('calculateLive2DLayout', () => {
  it('使用模型中心锚点并补偿半个画布高度', () => {
    const layout = calculateLive2DLayout({
      canvasWidth: 400,
      canvasHeight: 300,
      modelAspect: 0.5,
      modelCanvasHeight: 1000,
      scale: 2,
      pose: POSE_PRESETS['full-center'],
    })

    expect(layout).toEqual({ width: 300, height: 600, x: 200, y: 150 })
    expect(layout.y - layout.height / 2).toBe(-150)
    expect(layout.y + layout.height / 2).toBe(450)
  })

  it('窗口高度变化后模型坐标偏移保持相同构图比例', () => {
    const small = calculateLive2DLayout({
      canvasWidth: 400,
      canvasHeight: 200,
      modelAspect: 0.5,
      modelCanvasHeight: 1000,
      scale: 3,
      pose: POSE_PRESETS['full-center'],
      offsetY: 500,
    })
    const tall = calculateLive2DLayout({
      canvasWidth: 400,
      canvasHeight: 800,
      modelAspect: 0.5,
      modelCanvasHeight: 1000,
      scale: 3,
      pose: POSE_PRESETS['full-center'],
      offsetY: 500,
    })

    expect(small.y).toBe(300)
    expect(tall.y).toBe(1200)
    expect(small.y / 200).toBe(tall.y / 800)
    expect((small.y - small.height / 2) / 200)
      .toBe((tall.y - tall.height / 2) / 800)
  })

  it('保留水平对齐和缩放后像素偏移', () => {
    const left = calculateLive2DLayout({
      canvasWidth: 500,
      canvasHeight: 400,
      modelAspect: 0.5,
      modelCanvasHeight: 400,
      scale: 1,
      pose: POSE_PRESETS['full-left'],
      offsetX: 12,
      offsetY: -8,
    })
    const right = calculateLive2DLayout({
      canvasWidth: 500,
      canvasHeight: 400,
      modelAspect: 0.5,
      modelCanvasHeight: 400,
      scale: 1,
      pose: POSE_PRESETS['full-right'],
    })

    expect(left).toMatchObject({ x: 112, y: 392 })
    expect(right.x).toBe(400)
  })

  it('复用立绘的全身、半身和头像缩放与纵向构图', () => {
    const common = {
      canvasWidth: 500,
      canvasHeight: 400,
      modelAspect: 0.5,
      modelCanvasHeight: 400,
      scale: 1,
    }
    const full = calculateLive2DLayout({ ...common, pose: POSE_PRESETS['full-center'] })
    const half = calculateLive2DLayout({ ...common, pose: POSE_PRESETS['half-center'] })
    const headshot = calculateLive2DLayout({ ...common, pose: POSE_PRESETS['headshot-center'] })

    expect(full).toMatchObject({ width: 200, height: 400, x: 250, y: 400 })
    expect(half).toMatchObject({ width: 400, height: 800, x: 250, y: 600 })
    expect(headshot).toMatchObject({ width: 800, height: 1600, x: 250, y: 920 })
  })

  it('半身和头像沿用立绘预设的左右定位', () => {
    const common = {
      canvasWidth: 500,
      canvasHeight: 400,
      modelAspect: 0.5,
      modelCanvasHeight: 400,
      scale: 1,
    }

    expect(calculateLive2DLayout({ ...common, pose: POSE_PRESETS['half-left'] }).x).toBe(100)
    expect(calculateLive2DLayout({ ...common, pose: POSE_PRESETS['half-right'] }).x).toBe(400)
    expect(calculateLive2DLayout({ ...common, pose: POSE_PRESETS['headshot-left'] }).x).toBe(25)
    expect(calculateLive2DLayout({ ...common, pose: POSE_PRESETS['headshot-right'] }).x).toBe(475)
  })
})
