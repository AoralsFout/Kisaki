import { beforeEach, describe, expect, it } from 'vitest'
import {
  adjustCharacterOpacity,
  getCharacterOpacity,
  isCharacterOpacityWheelEnabled,
  setCharacterOpacity,
  setCharacterOpacityWheelEnabled,
} from '../opacity'

describe('character opacity wheel', () => {
  beforeEach(() => localStorage.clear())

  it('is enabled by default and persists the setting', () => {
    expect(isCharacterOpacityWheelEnabled()).toBe(true)
    setCharacterOpacityWheelEnabled(false)
    expect(isCharacterOpacityWheelEnabled()).toBe(false)
  })

  it('adjusts in 10% steps and stays recoverable', () => {
    expect(adjustCharacterOpacity(1, 100)).toBe(0.9)
    expect(adjustCharacterOpacity(0.9, -100)).toBe(1)
    expect(setCharacterOpacity(-1)).toBe(0.2)
    expect(adjustCharacterOpacity(0.2, 100)).toBe(0.2)
    expect(getCharacterOpacity()).toBe(0.2)
  })

  it('falls back to fully opaque for invalid stored values', () => {
    localStorage.setItem('deskpet-character-opacity', 'invalid')
    expect(getCharacterOpacity()).toBe(1)
  })
})
