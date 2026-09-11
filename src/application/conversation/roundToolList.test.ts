/**
 * 工具清单装配的契约测试。
 *
 * 回合发送的清单与设置页 `inspectContext()` 展示的清单共用这一个函数；这里钉住的是
 * 两个调用方都依赖的形状 —— 角色工具在前、say 在末位、授权状态原样透传。
 */
import { describe, expect, it } from 'vitest'
import { SAY_TOOL_DEF } from '../../agent/tools/say'
import { assembleRoundToolList } from './roundToolList'

import type { ToolDefinition } from '../../agent/types'
import type { CharacterToolContext } from '../../agent/registry'
import type { CharacterData } from '../../character/loader'
import type { CharacterCapabilities } from '../character/characterRuntime'

const readFile: ToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: '读取文件', parameters: {} },
}

const character: CharacterData = {
  id: 'kisaki',
  name: 'Kisaki',
  description: '',
  version: 1,
  prompt: '',
  poses: ['normal'],
  emotions: ['neutral'],
  costumes: ['default'],
  images: [],
  voice: 'voice-x',
  voiceLanguage: 'ja-JP',
  textLanguage: 'zh-CN',
  render: 'illustration',
}

const capabilities: CharacterCapabilities = {
  emotions: ['neutral'],
  stances: [],
  costumes: [],
  screenPoses: [],
  motions: [],
  emotionDescriptions: {},
}

/** 记录收到的装配上下文，并回一份固定清单。 */
function catalogSpy(): { contexts: CharacterToolContext[]; definitions: (context: CharacterToolContext) => ToolDefinition[] } {
  const contexts: CharacterToolContext[] = []
  return {
    contexts,
    definitions: context => {
      contexts.push(context)
      return [readFile]
    },
  }
}

describe('assembleRoundToolList', () => {
  it('角色工具在前，say 说话工具始终在末位', () => {
    const spy = catalogSpy()
    const list = assembleRoundToolList(spy, { data: character, capabilities }, true)

    expect(list.map(item => item.function.name)).toEqual(['read_file', 'say'])
    expect(list[list.length - 1]).toBe(SAY_TOOL_DEF)
  })

  it('把角色数据、能力与工作区授权原样透传给清单端口', () => {
    const spy = catalogSpy()
    assembleRoundToolList(spy, { data: character, capabilities }, false)

    expect(spy.contexts).toEqual([{ data: character, capabilities, hasWorkspace: false }])
  })

  it('端口返回空清单时仍只剩 say，不会额外补出别的工具', () => {
    const list = assembleRoundToolList(
      { definitions: () => [] },
      { data: null, capabilities: null },
      true,
    )

    expect(list).toEqual([SAY_TOOL_DEF])
  })
})
