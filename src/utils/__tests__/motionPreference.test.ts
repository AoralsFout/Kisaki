import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_REDUCED_MOTION } from '../../constants'

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  constructor(_name: string) {}
}

describe('motionPreference', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    document.documentElement.removeAttribute('data-reduced-motion')
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('defaults to full motion without adding a document override', async () => {
    const motion = await import('../motionPreference')
    expect(motion.isReducedMotionEnabled()).toBe(false)
    expect(motion.shouldReduceMotion()).toBe(false)
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false)
  })

  it('persists the manual preference and applies it immediately', async () => {
    const motion = await import('../motionPreference')
    motion.setReducedMotionEnabled(true)

    expect(localStorage.getItem(STORAGE_REDUCED_MOTION)).toBe('1')
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('true')
    expect(motion.shouldReduceMotion()).toBe(true)

    motion.setReducedMotionEnabled(false)
    expect(localStorage.getItem(STORAGE_REDUCED_MOTION)).toBe('0')
    expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false)
  })

  it('still follows the operating system preference while the manual switch is off', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const motion = await import('../motionPreference')
    expect(motion.isReducedMotionEnabled()).toBe(false)
    expect(motion.shouldReduceMotion()).toBe(true)
  })
})
