/**
 * registry.getDefinitions 单元测试：按 render 过滤 + Live2D 枚举注入
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register, getDefinitions } from '../registry'
import { setAgentCharData, setAgentLive2DManifest } from '../context'
import type { Tool } from '../types'

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

describe('registry getDefinitions — 渲染过滤 + 枚举注入', () => {
  beforeEach(() => {
    register(mkTool('t_illu', 'illustration'))
    register(mkTool('t_l2d', 'live2d', { expression: { type: 'string' }, motion: { type: 'string' } }))
    register(mkTool('t_both', 'both'))
    setAgentLive2DManifest(null)
  })

  it('illustration 角色：含 illustration/both，不含 live2d', () => {
    setAgentCharData({ render: 'illustration', emotions: [], poses: [], costumes: [] } as any)
    const names = getDefinitions().map(d => d.function.name)
    expect(names).toContain('t_illu')
    expect(names).toContain('t_both')
    expect(names).not.toContain('t_l2d')
  })

  it('live2d 角色：含 live2d/both，不含 illustration', () => {
    setAgentCharData({ render: 'live2d' } as any)
    const names = getDefinitions().map(d => d.function.name)
    expect(names).toContain('t_l2d')
    expect(names).toContain('t_both')
    expect(names).not.toContain('t_illu')
  })

  it('缺省 render 视为 illustration', () => {
    setAgentCharData({} as any)
    const names = getDefinitions().map(d => d.function.name)
    expect(names).toContain('t_illu')
    expect(names).not.toContain('t_l2d')
  })

  it('live2d manifest 注入 expression/motion 枚举与描述', () => {
    setAgentCharData({ render: 'live2d' } as any)
    setAgentLive2DManifest({
      charId: 'x', modelRel: '', modelRelDir: '', modelUrl: '', modelJSON: {},
      expressions: [{ id: 'e1', desc: '微笑' }],
      motions: [{ group: 'Idle', count: 2, desc: '空闲' }],
      idleGroup: 'Idle',
    } as any)
    const l2d = getDefinitions().find(d => d.function.name === 't_l2d')!
    const props = l2d.function.parameters.properties
    expect(props.expression.enum).toEqual(['e1'])
    expect(props.motion.enum).toEqual(['Idle'])
    expect(props.expression.description).toContain('微笑')
  })
})
