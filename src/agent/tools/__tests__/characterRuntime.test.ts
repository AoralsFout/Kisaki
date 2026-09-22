import { describe, expect, it, vi } from 'vitest'
import type { CharacterToolRuntimePort, CharacterToolRuntimeState } from '../../../application/character/characterToolRuntime'
import type { CharacterData } from '../../../character/loader'
import type { ToolExecutionContext } from '../../../application/tools/toolExecutionCoordinator'
import {
  getStateTool,
  setCostumeTool,
  setEmotionTool,
  setLookTool,
  setScreenPoseTool,
  setStanceTool,
} from '../character'
import { playMotionTool, setExpressionTool } from '../live2d'

const data: CharacterData = {
  id: 'alice',
  name: '爱丽丝',
  description: '',
  version: 1,
  prompt: '',
  poses: ['站立', '坐着'],
  emotions: ['开心', '悲伤'],
  costumes: ['校服', '礼服'],
  images: [],
  render: 'illustration',
}

function illustrationState(): CharacterToolRuntimeState {
  return {
    identity: { id: 'alice', name: '爱丽丝' },
    data,
    render: 'illustration',
    look: { emotion: '开心', stance: '站立', costume: '校服', screenPose: 'full-center' },
    capabilities: {
      emotions: ['开心', '悲伤'],
      stances: ['站立', '坐着'],
      costumes: ['校服', '礼服'],
      screenPoses: ['full-center'],
      motions: [],
      emotionDescriptions: {},
    },
  }
}

function live2dState(): CharacterToolRuntimeState {
  const state = illustrationState()
  return {
    ...state,
    data: { ...data, render: 'live2d', emotions: [], poses: [], costumes: [] },
    render: 'live2d',
    capabilities: {
      emotions: ['smile'],
      stances: [''],
      costumes: [''],
      screenPoses: ['full-center'],
      motions: [{ group: 'Idle', count: 1, description: '待机' }],
      emotionDescriptions: { smile: '微笑' },
    },
  }
}

class FakeCharacterRuntime implements CharacterToolRuntimePort {
  constructor(public current: CharacterToolRuntimeState) {}
  readonly setLook = vi.fn(() => Boolean(this.current.data))
  readonly setScreenPose = vi.fn(() => Boolean(this.current.data))
  readonly playMotion = vi.fn(async () => true)
  state(): CharacterToolRuntimeState { return this.current }
}

function context(character: CharacterToolRuntimePort): ToolExecutionContext {
  return { signal: new AbortController().signal, sessionApproval: false, workspaceGrantId: null, character }
}

describe('角色工具运行时端口', () => {
  it('角色未就绪时保持原有回执且不调用命令', async () => {
    const runtime = new FakeCharacterRuntime({ identity: null, data: null, render: null, look: null, capabilities: null })
    const ctx = context(runtime)

    await expect(setEmotionTool.handler({ emotion: '开心' }, ctx)).resolves.toBe('角色数据未就绪')
    await expect(setStanceTool.handler({ stance: '站立' }, ctx)).resolves.toBe('角色数据未就绪')
    await expect(setCostumeTool.handler({ costume: '校服' }, ctx)).resolves.toBe('角色数据未就绪')
    await expect(setLookTool.handler({ emotion: '开心' }, ctx)).resolves.toBe('没有与指定外观匹配的可渲染组合')
    await expect(setScreenPoseTool.handler({ pose: 'full-center' }, ctx)).resolves.toBe('角色运行时未初始化')
    await expect(getStateTool.handler({}, ctx)).resolves.toBe('角色运行时未初始化')
    expect(runtime.setLook).not.toHaveBeenCalled()
    expect(runtime.setScreenPose).not.toHaveBeenCalled()
  })

  it('使用端口快照校验并执行立绘工具，回执逐字保持', async () => {
    const runtime = new FakeCharacterRuntime(illustrationState())
    const ctx = context(runtime)

    await expect(setEmotionTool.handler({ emotion: '悲伤' }, ctx)).resolves.toBe('表情已切换为「悲伤」')
    await expect(setStanceTool.handler({ stance: '坐着' }, ctx)).resolves.toBe('姿势已切换为「坐着」')
    await expect(setCostumeTool.handler({ costume: '礼服' }, ctx)).resolves.toBe('服装已切换为「礼服」')
    await expect(setLookTool.handler({ stance: '坐着', emotion: '悲伤' }, ctx)).resolves.toBe('已更新：姿势=坐着、表情=悲伤')
    await expect(setScreenPoseTool.handler({ pose: 'full-center' }, ctx)).resolves.toContain('屏幕位置已切换为')
    expect(runtime.setLook).toHaveBeenCalledWith({ emotion: '悲伤' })
    expect(runtime.setScreenPose).toHaveBeenCalledWith('full-center')
  })

  it('能力快照变化后清单读取新值，旧值立即失败', async () => {
    const runtime = new FakeCharacterRuntime(live2dState())
    const ctx = context(runtime)

    await expect(setExpressionTool.handler({ expression: 'smile' }, ctx)).resolves.toBe('表情已切换为「smile」')
    runtime.current = {
      ...runtime.current,
      capabilities: { ...runtime.current.capabilities!, emotions: ['angry'], motions: [{ group: 'Tap', count: 1, description: '' }] },
    }
    await expect(setExpressionTool.handler({ expression: 'smile' }, ctx)).resolves.toBe('不支持的表情「smile」。可用: angry')
    await expect(setExpressionTool.handler({ expression: 'angry' }, ctx)).resolves.toBe('表情已切换为「angry」')
    await expect(playMotionTool.handler({ motion: 'Tap' }, ctx)).resolves.toBe('已播放动作「Tap」')
    expect(runtime.playMotion).toHaveBeenCalledWith('Tap', 0)
  })

  it('Live2D 预览未挂载时由端口返回失败而不是读取 Stage 或 Pinia', async () => {
    const runtime = new FakeCharacterRuntime(live2dState())
    runtime.playMotion.mockResolvedValue(false)
    const ctx = context(runtime)

    await expect(setExpressionTool.handler({ expression: 'smile' }, ctx)).resolves.toBe('表情已切换为「smile」')
    await expect(playMotionTool.handler({ motion: 'Idle' }, ctx)).resolves.toBe('播放动作失败: Idle')
  })
})
