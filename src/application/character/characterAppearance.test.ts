import { describe, expect, it, vi } from 'vitest'
import {
  deleteCharacterAppearanceImage,
  importCharacterLive2DModel,
  saveCharacterAppearanceImage,
} from './characterAppearance'

function imagePort() {
  return {
    saveImage: vi.fn(async () => undefined),
    deleteImage: vi.fn(async () => undefined),
  }
}

describe('角色外观图片工作流', () => {
  it('上传后刷新缓存；替换先写新图再删除旧图', async () => {
    const port = imagePort()
    const bust = vi.fn()

    const result = await saveCharacterAppearanceImage({
      port,
      characterId: 'kisaki',
      filename: 'new.png',
      previousFilename: 'old.png',
      dataBase64: 'base64',
      bustImageCache: bust,
    })

    expect(result).toMatchObject({ ok: true, persisted: true, cacheBusted: true })
    expect(port.saveImage).toHaveBeenCalledWith('kisaki', 'new.png', 'base64')
    expect(port.deleteImage).toHaveBeenCalledWith('kisaki', 'old.png')
    expect(bust).toHaveBeenCalledOnce()
    expect(port.saveImage.mock.invocationCallOrder[0]).toBeLessThan(port.deleteImage.mock.invocationCallOrder[0])
  })

  it('保存失败时不删除旧图、不刷新缓存，并返回可诊断错误', async () => {
    const port = imagePort()
    port.saveImage.mockRejectedValueOnce(new Error('磁盘已满'))
    const bust = vi.fn()

    const result = await saveCharacterAppearanceImage({
      port,
      characterId: 'kisaki',
      filename: 'new.png',
      previousFilename: 'old.png',
      dataBase64: 'base64',
      bustImageCache: bust,
    })

    expect(result).toMatchObject({ ok: false, persisted: false, cacheBusted: false, error: { step: 'save-image', reason: '磁盘已满' } })
    expect(port.deleteImage).not.toHaveBeenCalled()
    expect(bust).not.toHaveBeenCalled()
  })

  it('删除图片成功后刷新缓存；刷新失败仍报告已删除但保留错误', async () => {
    const port = imagePort()
    const result = await deleteCharacterAppearanceImage({
      port,
      characterId: 'kisaki',
      filename: 'old.png',
      bustImageCache: vi.fn(async () => { throw new Error('缓存刷新失败') }),
    })

    expect(result).toMatchObject({ ok: false, persisted: true, cacheBusted: false, error: { step: 'cache' } })
    expect(port.deleteImage).toHaveBeenCalledWith('kisaki', 'old.png')
  })
})

describe('Live2D 外观导入', () => {
  it('保留后端返回的模型路径', async () => {
    const result = await importCharacterLive2DModel(
      { importLive2dModel: vi.fn(async () => 'live2d/Hiyori/Hiyori.model3.json') },
      'kisaki',
      'C:/models/Hiyori',
    )
    expect(result).toEqual({ ok: true, model: 'live2d/Hiyori/Hiyori.model3.json' })
  })

  it('导入失败返回原始错误，空目录不调用端口', async () => {
    const importModel = vi.fn(async () => { throw new Error('缺少 model3.json') })
    await expect(importCharacterLive2DModel({ importLive2dModel: importModel }, 'kisaki', ''))
      .resolves.toEqual({ ok: false, error: '未选择 Live2D 模型目录' })
    expect(importModel).not.toHaveBeenCalled()

    await expect(importCharacterLive2DModel({ importLive2dModel: importModel }, 'kisaki', 'models'))
      .resolves.toEqual({ ok: false, error: '缺少 model3.json' })
  })
})
