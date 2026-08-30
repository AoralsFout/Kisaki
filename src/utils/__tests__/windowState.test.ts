import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const callOrder: string[] = []
  const win = {
    setPosition: vi.fn(async () => { callOrder.push('setPosition') }),
    setSize: vi.fn(async () => { callOrder.push('setSize') }),
    show: vi.fn(async () => { callOrder.push('show') }),
    outerPosition: vi.fn(async () => ({ x: 10, y: 20 })),
    outerSize: vi.fn(async () => ({ width: 1000, height: 600 })),
    onMoved: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
  }
  return { callOrder, win }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => mocks.win,
  availableMonitors: vi.fn(async () => [{
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
  }]),
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(public x: number, public y: number) {}
  },
  PhysicalSize: class PhysicalSize {
    constructor(public width: number, public height: number) {}
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}))

describe('initWindowState', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.callOrder.length = 0
    vi.clearAllMocks()
    mocks.win.setPosition.mockImplementation(async () => { mocks.callOrder.push('setPosition') })
    mocks.win.setSize.mockImplementation(async () => { mocks.callOrder.push('setSize') })
    mocks.win.show.mockImplementation(async () => { mocks.callOrder.push('show') })
  })

  it('先恢复位置和大小，再显示隐藏创建的窗口', async () => {
    localStorage.setItem('deskpet-window-state-main', JSON.stringify({
      x: 120,
      y: 80,
      width: 1000,
      height: 600,
    }))
    const { initWindowState } = await import('../windowState')

    await initWindowState('main', { showAfterRestore: true })

    expect(mocks.callOrder.slice(0, 3)).toEqual(['setPosition', 'setSize', 'show'])
    expect(mocks.win.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 120, y: 80 }))
    expect(mocks.win.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 1000, height: 600 }))
  })

  it('恢复失败时仍显示窗口，避免窗口永久隐藏', async () => {
    localStorage.setItem('deskpet-window-state-main', JSON.stringify({
      x: 120,
      y: 80,
      width: 1000,
      height: 600,
    }))
    mocks.win.setPosition.mockImplementationOnce(async () => {
      mocks.callOrder.push('setPosition')
      throw new Error('restore failed')
    })
    const { initWindowState } = await import('../windowState')

    await initWindowState('main', { showAfterRestore: true })

    expect(mocks.win.show).toHaveBeenCalledOnce()
    expect(mocks.callOrder).toEqual(['setPosition', 'show'])
  })
})
