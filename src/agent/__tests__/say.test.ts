import { describe, expect, it } from 'vitest'
import { SAY_TOOL_DEF } from '../tools/say'

describe('say 工具约束', () => {
  it('把 say 描述为最终且终止性的单独调用', () => {
    const description = SAY_TOOL_DEF.function.description ?? ''
    expect(description).toContain('立即终止当前工具循环')
    expect(description).toContain('所有查询、操作和验证都已完成')
    expect(description).toContain('不要与其他工具同批调用')
    expect(description).toContain('不要用它播报中间进度')
  })

  it('voice 参数允许数字并限制其他符号', () => {
    const voice = SAY_TOOL_DEF.function.parameters?.properties?.voice
    expect(voice?.description).toContain('允许可朗读文字、阿拉伯数字、语言正常所需的空格、半角逗号')
    expect(voice?.description).toContain('可以保留数字原样，不要为了朗读改写成文字')
    expect(voice?.description).toContain('禁止罗马数字、其他标点')
  })
})
