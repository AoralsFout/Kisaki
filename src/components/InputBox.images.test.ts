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
  it('发送被拒绝或异常时保留文字和图片，成功后才清理', async () => {
    const submit = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true)
    const wrapper = mount(InputBox, { props: { visible: true, submit } })
    await wrapper.get('textarea').setValue('保留我')
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [imageFile()] })
    await fileInput.trigger('change')
    await flushPromises()
    for (let i = 0; i < 2; i++) {
      await wrapper.get('.btn-send').trigger('click')
      await flushPromises()
      expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('保留我')
      expect(wrapper.findAll('.image-preview')).toHaveLength(1)
      expect(wrapper.get('[role="alert"]').text()).toBe('safety.sendFailed')
    }
    await wrapper.get('.btn-send').trigger('click')
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
    expect(wrapper.findAll('.image-preview')).toHaveLength(0)
    wrapper.unmount()
  })

  it('删除会话释放草稿，待完成的发送不覆盖另一会话', async () => {
    let finish!: (value: boolean) => void
    const submit = vi.fn(() => new Promise<boolean>(r => { finish = r }))
    const wrapper = mount(InputBox, { props: { visible: true, draftKey: 'a', validDraftKeys: ['a', 'b'], submit } })
    await wrapper.get('textarea').setValue('A')
    await wrapper.get('.btn-send').trigger('click')
    await wrapper.setProps({ draftKey: 'b', validDraftKeys: ['b'] })
    await wrapper.get('textarea').setValue('B')
    finish(true)
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('B')
    await wrapper.setProps({ draftKey: 'a', validDraftKeys: ['a', 'b'] })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
    wrapper.unmount()
  })

  it('关闭再打开保留文字与图片，切换会话隔离草稿', async () => {
    const wrapper = mount(InputBox, { props: { visible: true, draftKey: 'a' } })
    await wrapper.get('textarea').setValue('会话 A 的草稿')
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [imageFile()] })
    await fileInput.trigger('change')
    await flushPromises()
    await wrapper.setProps({ visible: false })
    await wrapper.setProps({ visible: true })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('会话 A 的草稿')
    expect(wrapper.findAll('.image-preview')).toHaveLength(1)
    await wrapper.setProps({ draftKey: 'b' })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
    expect(wrapper.findAll('.image-preview')).toHaveLength(0)
    await wrapper.get('textarea').setValue('会话 B 的草稿')
    await wrapper.setProps({ draftKey: 'a' })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('会话 A 的草稿')
    expect(wrapper.findAll('.image-preview')).toHaveLength(1)
    await wrapper.get('.btn-send').trigger('click')
    await wrapper.setProps({ draftKey: 'b' })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('会话 B 的草稿')
    await wrapper.setProps({ draftKey: 'a' })
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('')
    expect(wrapper.findAll('.image-preview')).toHaveLength(0)
    wrapper.unmount()
  })

  it('输入法选词和 Shift+Enter 不发送，普通 Enter 发送', async () => {
    const wrapper = mount(InputBox, { props: { visible: true } })
    const input = wrapper.get('textarea')
    await input.setValue('你好')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 })
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('你好')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('send')?.[0]?.[0]).toEqual({ text: '你好', images: [] })
    wrapper.unmount()
  })

  it('图片读取期间切换会话，附件仍归属原会话', async () => {
    let finishRead: (() => void) | undefined
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,iVBORw=='
      onload: ((event: ProgressEvent) => void) | null = null
      readAsDataURL() { finishRead = () => this.onload?.(new ProgressEvent('load')) }
    })
    const wrapper = mount(InputBox, { props: { visible: true, draftKey: 'a' } })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [imageFile()] })
    await fileInput.trigger('change')
    await wrapper.setProps({ draftKey: 'b' })
    finishRead?.()
    await flushPromises()
    expect(wrapper.findAll('.image-preview')).toHaveLength(0)
    await wrapper.setProps({ draftKey: 'a' })
    expect(wrapper.findAll('.image-preview')).toHaveLength(1)
    wrapper.unmount()
  })

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
