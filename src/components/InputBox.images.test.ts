import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InputBox from './InputBox.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

function imageFile(name = 'picture.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
}

beforeEach(() => {
  class TestFileReader {
    result: string | ArrayBuffer | null = null
    error: DOMException | null = null
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null

    readAsDataURL(file: File) {
      this.result = `data:${file.type};base64,iVBORw==`
      queueMicrotask(() => this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>))
    }
  }
  vi.stubGlobal('FileReader', TestFileReader)
})

afterEach(() => vi.unstubAllGlobals())

describe('InputBox 图片输入', () => {
  it('选择图片后显示预览并允许纯图片发送', async () => {
    const wrapper = mount(InputBox, { props: { visible: true } })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [imageFile()] })

    await fileInput.trigger('change')
    await flushPromises()

    const preview = wrapper.get<HTMLImageElement>('.image-preview img')
    expect(preview.attributes('src')).toMatch(/^data:image\/png;base64,/)
    expect(wrapper.get<HTMLButtonElement>('.btn-send').element.disabled).toBe(false)

    await wrapper.get('.btn-send').trigger('click')
    const payload = wrapper.emitted('send')?.[0]?.[0] as { text: string; images: unknown[] }
    expect(payload.text).toBe('')
    expect(payload.images).toHaveLength(1)
  })

  it('可从剪贴板粘贴图片并移除预览', async () => {
    const wrapper = mount(InputBox, { props: { visible: true } })
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [imageFile('clipboard.png')], items: [], getData: () => '' },
    })

    wrapper.get('textarea').element.dispatchEvent(paste)
    await flushPromises()
    expect(wrapper.findAll('.image-preview')).toHaveLength(1)
    expect(paste.defaultPrevented).toBe(true)

    await wrapper.get('.btn-remove-image').trigger('click')
    expect(wrapper.findAll('.image-preview')).toHaveLength(0)
  })
})
