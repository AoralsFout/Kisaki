import {
  STORAGE_CHARACTER_OPACITY,
  STORAGE_CHARACTER_OPACITY_WHEEL_ENABLED,
} from '../constants'

export const MIN_CHARACTER_OPACITY = 0.2
export const MAX_CHARACTER_OPACITY = 1
export const CHARACTER_OPACITY_STEP = 0.1

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式或存储不可用时仍允许本次交互生效。
  }
}

export function isCharacterOpacityWheelEnabled(): boolean {
  const stored = readStorage(STORAGE_CHARACTER_OPACITY_WHEEL_ENABLED)
  return stored === null ? true : stored === '1'
}

export function setCharacterOpacityWheelEnabled(enabled: boolean): void {
  writeStorage(STORAGE_CHARACTER_OPACITY_WHEEL_ENABLED, enabled ? '1' : '0')
}

export function getCharacterOpacity(): number {
  const value = Number(readStorage(STORAGE_CHARACTER_OPACITY))
  if (!Number.isFinite(value) || value < MIN_CHARACTER_OPACITY || value > MAX_CHARACTER_OPACITY) {
    return MAX_CHARACTER_OPACITY
  }
  return value
}

export function setCharacterOpacity(opacity: number): number {
  const clamped = Math.min(MAX_CHARACTER_OPACITY, Math.max(MIN_CHARACTER_OPACITY, opacity))
  const rounded = Math.round(clamped * 10) / 10
  writeStorage(STORAGE_CHARACTER_OPACITY, String(rounded))
  return rounded
}

export function adjustCharacterOpacity(current: number, deltaY: number): number {
  if (deltaY === 0) return current
  const direction = deltaY < 0 ? 1 : -1
  return setCharacterOpacity(current + direction * CHARACTER_OPACITY_STEP)
}
