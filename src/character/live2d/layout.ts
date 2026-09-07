export interface Live2DLayoutInput {
  canvasWidth: number
  canvasHeight: number
  modelAspect: number
  modelCanvasHeight: number
  scale: number
  horizontalAlign: 0 | 0.5 | 1
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

/**
 * 计算 Live2D 布局。sprite 使用中心锚点，但仍按既有语义保持底部构图；
 * offset 使用模型原始画布坐标，并随模型显示比例缩放，避免窗口尺寸变化时漂移。
 */
export function calculateLive2DLayout(input: Live2DLayoutInput): Live2DLayout {
  const height = input.canvasHeight * input.scale
  const width = height * input.modelAspect
  const modelPixelScale = input.modelCanvasHeight > 0
    ? height / input.modelCanvasHeight
    : 1
  const left = (input.canvasWidth - width) * input.horizontalAlign
  const top = input.canvasHeight - height
  // 既有模型配置以底部构图为基准；额外下移半个画布高度，
  // 将原本落在画布中心的角色底部改为让角色中心落在画布中心。
  const verticalCenterOffset = input.canvasHeight / 2

  return {
    width,
    height,
    x: left + width / 2 + (input.offsetX ?? 0) * modelPixelScale,
    y: top + height / 2 + (input.offsetY ?? 0) * modelPixelScale + verticalCenterOffset,
  }
}
