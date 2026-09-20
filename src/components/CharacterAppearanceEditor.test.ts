import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CharacterAppearanceEditor from './CharacterAppearanceEditor.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const illustrationDraft = {
  poses: ['standing', 'sit'],
  costumes: ['default'],
  images: [{ file: 'sample.png', pose: 'standing', costume: 'default', emotions: [] }],
}

function mountIllustration(overrides: Record<string, unknown> = {}) {
  return mount(CharacterAppearanceEditor, {
    props: {
      characterId: 'kisaki',
      render: 'illustration',
      draft: illustrationDraft,
      imageUrl: (file: string) => `/images/${file}`,
      filePort: {
        saveImage: vi.fn(async () => undefined),
        deleteImage: vi.fn(async () => undefined),
      },
      bustImageCache: vi.fn(),
      ...overrides,
    },
  })
}

describe('CharacterAppearanceEditor 静态立绘', () => {
  it('选择立绘后把预览渲染到右侧宿主，而不是图片列表下方', async () => {
    const previewHost = document.createElement('div')
    previewHost.id = 'character-illustration-preview'
    document.body.appendChild(previewHost)
    const wrapper = mountIllustration({ previewTarget: '#character-illustration-preview' })

    await wrapper.get('.appearance-image-card').trigger('click')

    expect(previewHost.querySelector('.preview-panel')).not.toBeNull()
    expect(wrapper.find('.preview-panel').exists()).toBe(false)
    wrapper.unmount()
    previewHost.remove()
  })

  it('通过 edit 事件返回标签和图片元数据意图，不改写输入投影', async () => {
    const wrapper = mountIllustration()
    await wrapper.get('.tag-add').trigger('click')
    expect(wrapper.emitted('edit')).toBeUndefined()

    const inputs = wrapper.findAll('.tag-input')
    await inputs[0].setValue('lying')
    await inputs[0].trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('edit')?.[0]).toEqual([{ type: 'add-pose', value: 'lying' }])
    expect(illustrationDraft.poses).toEqual(['standing', 'sit'])

    await wrapper.get('.appearance-image-card').trigger('click')
    await wrapper.get('select').setValue('sit')
    const editsAfterPose = wrapper.emitted('edit') ?? []
    expect(editsAfterPose[editsAfterPose.length - 1]).toEqual([{ type: 'set-image-pose', file: 'sample.png', pose: 'sit' }])
  })

  it('上传失败时展示可观察错误且不发出新增草稿意图', async () => {
    const saveImage = vi.fn(async () => { throw new Error('磁盘已满') })
    const wrapper = mountIllustration({ filePort: { saveImage, deleteImage: vi.fn() } })
    const input = wrapper.get<HTMLInputElement>('input[type=file]')
    const file = new File(['png'], 'new.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')

    await vi.waitFor(() => expect(wrapper.get('[role=alert]').text()).toContain('磁盘已满'))
    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('替换成功后使用同一文件名并发出替换意图，且刷新缓存', async () => {
    const bustImageCache = vi.fn()
    const saveImage = vi.fn(async () => undefined)
    const wrapper = mountIllustration({ bustImageCache, filePort: { saveImage, deleteImage: vi.fn() } })
    await wrapper.get('.appearance-image-card').trigger('click')
    const input = wrapper.get<HTMLInputElement>('input[type=file]')
    const file = new File(['new png'], 'replacement.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')

    await vi.waitFor(() => expect(saveImage).toHaveBeenCalledWith('kisaki', 'sample.png', expect.any(String)))
    expect(bustImageCache).toHaveBeenCalledOnce()
    const editsAfterReplace = wrapper.emitted('edit') ?? []
    expect(editsAfterReplace[editsAfterReplace.length - 1]).toEqual([{ type: 'replace-image', file: 'sample.png' }])
  })
})

describe('CharacterAppearanceEditor Live2D', () => {
  it('通过 patch 意图编辑配置，并在重导入后报告模型与清单', async () => {
    const manifest = { charId: 'kisaki', modelRel: 'm.model3.json', modelRelDir: '', modelUrl: 'm', modelJSON: {}, expressions: [], motions: [], idleGroup: 'Idle' }
    const wrapper = mount(CharacterAppearanceEditor, {
      props: {
        characterId: 'kisaki',
        render: 'live2d',
        draft: { poses: [], costumes: [], images: [], live2d: { model: 'old.model3.json', mouseFollow: true } },
        manifest: null,
        pickLive2dModel: vi.fn(async () => 'C:/models/new'),
        live2dPort: { importLive2dModel: vi.fn(async () => 'live2d/new.model3.json') },
        loadLive2dManifest: vi.fn(async () => manifest),
      },
    })

    await wrapper.get('input[type=checkbox]').setValue(false)
    expect(wrapper.emitted('edit')?.[0]).toEqual([{ type: 'set-live2d-config', patch: { mouseFollow: false } }])
    await wrapper.get('.tag-add').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('live2d-model-imported')).toEqual([['live2d/new.model3.json']]))
    expect(wrapper.emitted('live2d-manifest-loaded')).toEqual([[manifest]])
  })

  it('重导入失败时展示明确错误', async () => {
    const wrapper = mount(CharacterAppearanceEditor, {
      props: {
        characterId: 'kisaki',
        render: 'live2d',
        draft: { poses: [], costumes: [], images: [], live2d: { model: 'old.model3.json' } },
        pickLive2dModel: vi.fn(async () => 'C:/models/broken'),
        live2dPort: { importLive2dModel: vi.fn(async () => { throw new Error('缺少 model3.json') }) },
      },
    })
    await wrapper.get('.tag-add').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[role=alert]').text()).toContain('缺少 model3.json'))
  })
})
