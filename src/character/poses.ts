/**
 * 立绘姿态预设系统
 *
 * AI 通过预设名称（如 'full-center'）选择立绘的
 * 缩放和位置，切换时由 CSS transition 驱动平滑动画。
 *
 */

/** 预设键名 */
export type PoseKey =
  | 'full-left'
  | 'full-center'
  | 'full-right'
  | 'half-center'
  | 'half-left'
  | 'half-right'
  | 'headshot-center'
  | 'headshot-left'
  | 'headshot-right'

/** 姿态预设定义 */
export interface PosePreset {
  key: PoseKey
  label: string
  left: string
  bottom: string
  translateX: string
  scale: number
}

/** 所有姿态预设 */
export const POSE_PRESETS: Record<PoseKey, PosePreset> = {
  // ====== 全身（小比例，可见全图）======
  'full-center': {
    key: 'full-center',
    label: '全身 - 中',
    left: '50%',
    bottom: '0%',
    translateX: '-50%',
    scale: 1,
  },
  'full-left': {
    key: 'full-left',
    label: '全身 - 左',
    left: '0%',
    bottom: '0%',
    translateX: '0%',
    scale: 1,
  },
  'full-right': {
    key: 'full-right',
    label: '全身 - 右',
    left: '100%',
    bottom: '0%',
    translateX: '-100%',
    scale: 1,
  },

  // ====== 半身（中等比例）======
  'half-center': {
    key: 'half-center',
    label: '半身 - 中',
    left: '50%',
    bottom: '-50%',
    translateX: '-50%',
    scale: 2,
  },
  'half-left': {
    key: 'half-left',
    label: '半身 - 左',
    left: '20%',
    bottom: '-50%',
    translateX: '-50%',
    scale: 2,
  },
  'half-right': {
    key: 'half-right',
    label: '半身 - 右',
    left: '80%',
    bottom: '-50%',
    translateX: '-50%',
    scale: 2,
  },

  // ====== 头像（大比例，聚焦面部）======
  'headshot-center': {
    key: 'headshot-center',
    label: '头像 - 中',
    left: '50%',
    bottom: '-130%',
    translateX: '-50%',
    scale: 4.0,
  },
  'headshot-left': {
    key: 'headshot-left',
    label: '头像 - 左',
    left: '25%',
    bottom: '-130%',
    translateX: '-100%',
    scale: 4.0,
  },
  'headshot-right': {
    key: 'headshot-right',
    label: '头像 - 右',
    left: '75%',
    bottom: '-130%',
    translateX: '0%',
    scale: 4.0,
  },
}

/** 默认初始姿态 */
export const DEFAULT_POSE: PoseKey = 'full-center'

/** 获取预设对象 */
export function getPose(key: PoseKey): PosePreset {
  return POSE_PRESETS[key]
}

/** 所有预设键列表 */
export const ALL_POSE_KEYS = Object.keys(POSE_PRESETS) as PoseKey[]
