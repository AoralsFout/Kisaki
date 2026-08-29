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

  it('voice 参数禁止数字和除半角逗号外的符号', () => {
    const voice = SAY_TOOL_DEF.function.parameters?.properties?.voice
    expect(voice?.description).toContain('只能包含可朗读文字、语言正常所需的空格和半角逗号')
    expect(voice?.description).toContain('半角逗号是唯一允许的标点和分句符号')
    expect(voice?.description).toContain('不得包含阿拉伯数字、罗马数字或数学符号')
    expect(voice?.description).toContain('必须按语义改写成母语中适合口头表达的可读文字')
  })
})
