import type { PosePreset } from '../poses'

export interface Live2DLayoutInput {
  canvasWidth: number
  canvasHeight: number
  modelAspect: number
  modelCanvasHeight: number
  /** 角色配置中的基础缩放。 */
  scale: number
  /** 与立绘模式共用的全身/半身/头像及左中右预设。 */
  pose: Pick<PosePreset, 'left' | 'bottom' | 'translateX' | 'scale'>
  offsetX?: number
  offsetY?: number
}

export interface Live2DLayout {
  width: number
  height: number
  /** 模型中心在画布中的横坐标（配合 anchor=0.5）。 */
  x: number
  /** 模型中心在画布中的纵坐标（配合 anchor=0.5）。 */
  y: number
}

function percentRatio(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed / 100 : 0
}

/**
 * 计算 Live2D 布局。sprite 使用中心锚点，但仍按既有语义保持底部构图；
 * offset 使用模型原始画布坐标，并随模型显示比例缩放，避免窗口尺寸变化时漂移。
 */
export function calculateLive2DLayout(input: Live2DLayoutInput): Live2DLayout {
  const baseHeight = input.canvasHeight * input.scale
  const baseWidth = baseHeight * input.modelAspect
  const height = baseHeight * input.pose.scale
  const width = baseWidth * input.pose.scale
  const modelPixelScale = input.modelCanvasHeight > 0
    ? baseHeight / input.modelCanvasHeight
    : 1
  const left = percentRatio(input.pose.left)
  const bottom = percentRatio(input.pose.bottom)
  const translateX = percentRatio(input.pose.translateX)
  // 既有模型配置以底部构图为基准；额外下移半个画布高度，
  // 将原本落在画布中心的角色底部改为让角色中心落在画布中心。
  const verticalCenterOffset = input.canvasHeight / 2

  return {
    width,
    height,
    // CSS 立绘：left 定位未缩放元素，translateX 百分比也以未缩放宽度计算，
    // 然后 scale 围绕元素中心进行。因此位置用 baseWidth，尺寸再乘 pose.scale。
    x: input.canvasWidth * left + baseWidth * (0.5 + translateX)
      + (input.offsetX ?? 0) * modelPixelScale,
    // bottom 同样定位未缩放元素；负值会把中心下移，scale 只改变围绕中心的尺寸。
    y: input.canvasHeight - input.canvasHeight * bottom - baseHeight / 2
      + (input.offsetY ?? 0) * modelPixelScale + verticalCenterOffset,
  }
}
