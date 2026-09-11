import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkProbe } from './browserNetworkProbe'

/** 替换 navigator.onLine 的取值，并返回还原函数。 */
function stubOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'onLine')
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
  return () => {
    if (original) Object.defineProperty(navigator, 'onLine', original)
    else delete (navigator as { onLine?: boolean }).onLine
  }
}

describe('BrowserNetworkProbe', () => {
  it('按 navigator.onLine 回答在线与否', () => {
    const probe = new BrowserNetworkProbe()
    const restoreOnline = stubOnline(true)
    try {
      expect(probe.isOnline()).toBe(true)
    } finally {
      restoreOnline()
    }

    const restoreOffline = stubOnline(false)
    try {
      expect(probe.isOnline()).toBe(false)
    } finally {
      restoreOffline()
    }
  })

  it('每次现读，不缓存上一次的结论', () => {
    const probe = new BrowserNetworkProbe()
    const restore = stubOnline(false)
    try {
      expect(probe.isOnline()).toBe(false)
      stubOnline(true)
      expect(probe.isOnline()).toBe(true)
    } finally {
      restore()
    }
  })

  it('不订阅 online/offline 事件', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    try {
      new BrowserNetworkProbe().isOnline()
      expect(addEventListener).not.toHaveBeenCalled()
    } finally {
      addEventListener.mockRestore()
    }
  })
})
