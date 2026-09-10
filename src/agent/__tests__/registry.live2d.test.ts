/**
 * registry.getDefinitions 单元测试：按 render 过滤 + Live2D 枚举注入
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register, getDefinitions } from '../registry'
import type { Tool } from '../types'
import type { CharacterCapabilities } from '../../application/character/characterRuntime'
import { setScreenCaptureEnabled } from '../toolPolicy'

function mkTool(name: string, appliesTo?: Tool['appliesTo'], props?: Record<string, any>): Tool {
  return {
    appliesTo,
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: props ?? {} } },
    },
    handler: async () => 'ok',
  }
}

const capabilities = (change: Partial<CharacterCapabilities> = {}): CharacterCapabilities => ({
  emotions: [],
  stances: [],
  costumes: [],
  screenPoses: [],
  motions: [],
  emotionDescriptions: {},
  ...change,
})

const context = (data: any, change: Partial<CharacterCapabilities> = {}, hasWorkspace?: boolean) => ({
  data,
  capabilities: capabilities(change),
  hasWorkspace,
})

describe('registry getDefinitions — 渲染过滤 + 枚举注入', () => {
  beforeEach(() => {
    localStorage.clear()
    register(mkTool('t_illu', 'illustration'))
    register(mkTool('t_l2d', 'live2d', { expression: { type: 'string' }, motion: { type: 'string' } }))
    register(mkTool('t_both', 'both'))
  })

  it('仅在用户开启权限后向模型暴露截屏工具', () => {
    register(mkTool('capture_screen'))
    const ctx = context({ render: 'illustration' })
    expect(getDefinitions(ctx).map(d => d.function.name)).not.toContain('capture_screen')
    setScreenCaptureEnabled(true)
    expect(getDefinitions(ctx).map(d => d.function.name)).toContain('capture_screen')
  })

  it('没有工作区时不暴露文件工具', () => {
    register(mkTool('read_file'))
    register(mkTool('write_file'))
    const withoutWorkspace = getDefinitions(context({ render: 'illustration' }, {}, false)).map(d => d.function.name)
    const withWorkspace = getDefinitions(context({ render: 'illustration' }, {}, true)).map(d => d.function.name)
    expect(withoutWorkspace).not.toContain('read_file')
    expect(withoutWorkspace).not.toContain('write_file')
    expect(withWorkspace).toContain('read_file')
    expect(withWorkspace).toContain('write_file')
  })

  it('illustration 角色：含 illustration/both，不含 live2d', () => {
    const names = getDefinitions(context({ render: 'illustration', emotions: [], poses: [], costumes: [] })).map(d => d.function.name)
    expect(names).toContain('t_illu')
    expect(names).toContain('t_both')
    expect(names).not.toContain('t_l2d')
  })

  it('live2d 角色：含 live2d/both，不含 illustration', () => {
    const names = getDefinitions(context({ render: 'live2d' })).map(d => d.function.name)
    expect(names).toContain('t_l2d')
    expect(names).toContain('t_both')
    expect(names).not.toContain('t_illu')
  })

  it('缺省 render 视为 illustration', () => {
    const names = getDefinitions(context({})).map(d => d.function.name)
    expect(names).toContain('t_illu')
    expect(names).not.toContain('t_l2d')
  })

  it('live2d manifest 注入 expression/motion 枚举与描述', () => {
    const l2d = getDefinitions(context({ render: 'live2d' }, {
      emotions: ['e1'],
      emotionDescriptions: { e1: '微笑' },
      motions: [{ group: 'Idle', count: 2, description: '空闲' }],
    })).find(d => d.function.name === 't_l2d')!
    const props = l2d.function.parameters.properties
    expect(props.expression.enum).toEqual(['e1'])
    expect(props.motion.enum).toEqual(['Idle'])
    expect(props.expression.description).toContain('微笑')
  })
})
