/**
 * Live2D 角色控制工具（独立工具集，仅对 render==='live2d' 的角色提供）
 *
 * 表情/动作的可用枚举由 registry.getDefinitions 从 CharacterRuntime 能力快照注入。
 */
import type { Tool } from '../types'
import { useCharacterStore } from '../../stores/character'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolLive2D')

/** 切换表情 */
export const setExpressionTool: Tool = {
  appliesTo: 'live2d',
  definition: {
    type: 'function',
    function: {
      name: 'set_expression',
      description: '切换 Live2D 角色的表情（expression）',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '表情 ID' },
        },
        required: ['expression'],
      },
    },
  },
  handler: async (args) => {
    const id = String(args.expression ?? '')
    const store = useCharacterStore()
    const capabilities = store.getRuntimeSnapshot().capabilities
    if (!capabilities) return '角色运行时未就绪'
    if (!capabilities.emotions.includes(id)) {
      return `不支持的表情「${id}」。可用: ${capabilities.emotions.join('、') || '（无）'}`
    }
    const ok = store.setVisualLook({ emotion: id })
    log.info("tool_live2_d.module.info", `set_expression: ${id} → ${ok ? 'ok' : 'fail'}`, { id: id, ok: ok ? 'ok' : 'fail' })
    return ok ? `表情已切换为「${id}」` : `切换表情失败: ${id}`
  },
}

/** 播放动作 */
export const playMotionTool: Tool = {
  appliesTo: 'live2d',
  definition: {
    type: 'function',
    function: {
      name: 'play_motion',
      description: '播放 Live2D 角色的一个动作动画（按动作组名）',
      parameters: {
        type: 'object',
        properties: {
          motion: { type: 'string', description: '动作组名' },
          index: { type: 'integer', description: '组内第几个动作（可选，默认 0）' },
        },
        required: ['motion'],
      },
    },
  },
  handler: async (args) => {
    const group = String(args.motion ?? '')
    const no = Number.isInteger(args.index) ? Number(args.index) : 0
    const store = useCharacterStore()
    const capabilities = store.getRuntimeSnapshot().capabilities
    if (!capabilities) return '角色运行时未就绪'
    if (!capabilities.motions.some(motion => motion.group === group)) {
      return `不支持的动作组「${group}」。可用: ${capabilities.motions.map(motion => motion.group).join('、') || '（无）'}`
    }
    const ok = await store.playMotion(group, no)
    log.info("tool_live2_d.module.info", `play_motion: ${group}[${no}] → ${ok ? 'ok' : 'fail'}`, { group: group, no: no, ok: ok ? 'ok' : 'fail' })
    return ok ? `已播放动作「${group}」` : `播放动作失败: ${group}`
  },
}
