/**
 * 角色控制工具（三维标签）
 *
 * 通过 CharacterStore 的 Runtime facade 执行命令，不再查找 renderer controller。
 */
import type { Tool } from '../types'
import { ALL_POSE_KEYS, POSE_PRESETS } from '../../character'
import { useCharacterStore } from '../../stores/character'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolCharacter')

function getStore() {
  const store = useCharacterStore()
  const data = store.data
  if (!data) return null
  return {
    runtime: store,
    data,
    emotions: data.emotions ?? [],
    poses: data.poses ?? [],
    costumes: data.costumes ?? [],
    name: data.name,
  }
}

/** 切换情绪 */
export const setEmotionTool: Tool = {
  appliesTo: 'illustration',
  definition: {
    type: 'function',
    function: {
      name: 'set_character_emotion',
      description: '切换角色的表情/情绪，立绘会切换为对应情绪的图片',
      parameters: {
        type: 'object',
        properties: {
          emotion: {
            type: 'string',
            description: '情绪名称',
          },
        },
        required: ['emotion'],
      },
    },
  },
  handler: async (args) => {
    const emotion = String(args.emotion ?? '')
    const store = getStore()
    if (!store) return '角色数据未就绪'
    if (store.emotions.length && !store.emotions.includes(emotion)) {
      log.warn("tool_character.module.warn", `不支持的情绪: ${emotion}`, undefined, { emotion: emotion })
      return `不支持的情绪。可用: ${store.emotions.join(', ')}`
    }
    if (!store.runtime.setVisualLook({ emotion })) return `没有可渲染的情绪组合「${emotion}」`
    log.info("tool_character.module.info", `表情切换: ${emotion}`, { emotion: emotion })
    return `表情已切换为「${emotion}」`
  },
}

/** 切换姿势标签 */
export const setStanceTool: Tool = {
  appliesTo: 'illustration',
  definition: {
    type: 'function',
    function: {
      name: 'set_character_stance',
      description: '切换角色的身体姿势：站立、坐着等',
      parameters: {
        type: 'object',
        properties: {
          stance: {
            type: 'string',
            description: '姿势名称',
          },
        },
        required: ['stance'],
      },
    },
  },
  handler: async (args) => {
    const stance = String(args.stance ?? '')
    const store = getStore()
    if (!store) return '角色数据未就绪'
    if (store.poses.length && !store.poses.includes(stance)) {
      log.warn("tool_character.module.warn", `不支持的姿势: ${stance}`, undefined, { stance: stance })
      return `不支持的姿势。可用: ${store.poses.join(', ')}`
    }
    if (!store.runtime.setVisualLook({ stance })) return `没有可渲染的姿势组合「${stance}」`
    log.info("tool_character.module.info", `姿势切换: ${stance}`, { stance: stance })
    return `姿势已切换为「${stance}」`
  },
}

/** 切换服装 */
export const setCostumeTool: Tool = {
  appliesTo: 'illustration',
  definition: {
    type: 'function',
    function: {
      name: 'set_character_costume',
      description: '切换角色的服装',
      parameters: {
        type: 'object',
        properties: {
          costume: {
            type: 'string',
            description: '服装名称',
          },
        },
        required: ['costume'],
      },
    },
  },
  handler: async (args) => {
    const costume = String(args.costume ?? '')
    const store = getStore()
    if (!store) return '角色数据未就绪'
    if (store.costumes.length && !store.costumes.includes(costume)) {
      log.warn("tool_character.module.warn", `不支持的服装: ${costume}`, undefined, { costume: costume })
      return `不支持的服装。可用: ${store.costumes.join(', ')}`
    }
    if (!store.runtime.setVisualLook({ costume })) return `没有可渲染的服装组合「${costume}」`
    log.info("tool_character.module.info", `服装切换: ${costume}`, { costume: costume })
    return `服装已切换为「${costume}」`
  },
}

/** 统一设置 */
export const setLookTool: Tool = {
  appliesTo: 'illustration',
  definition: {
    type: 'function',
    function: {
      name: 'set_character_look',
      description: '同时设置角色的姿势、情绪和服装（可只设置其中几项）',
      parameters: {
        type: 'object',
        properties: {
          stance: { type: 'string', description: '姿势名称' },
          emotion: { type: 'string', description: '情绪名称' },
          costume: { type: 'string', description: '服装名称' },
        },
      },
    },
  },
  handler: async (args) => {
    const store = useCharacterStore()
    const changed = store.setVisualLook({
      stance: args.stance || undefined,
      emotion: args.emotion || undefined,
      costume: args.costume || undefined,
    })
    if (!changed) return '没有与指定外观匹配的可渲染组合'
    const parts: string[] = []
    if (args.stance) parts.push(`姿势=${args.stance}`)
    if (args.emotion) parts.push(`表情=${args.emotion}`)
    if (args.costume) parts.push(`服装=${args.costume}`)
    log.info("tool_character.module.info", `角色外观更新: ${parts.join(', ') || '无变更'}`, { parts_join: parts.join(', ') || '无变更' })
    return parts.length ? `已更新：${parts.join('、')}` : '未做任何更改'
  },
}

/** 屏幕姿态 */
export const setScreenPoseTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'set_screen_pose',
      description: '控制角色在屏幕上的位置和大小',
      parameters: {
        type: 'object',
        properties: {
          pose: {
            type: 'string',
            description: `位置预设: ${ALL_POSE_KEYS.map(k => `${k}(${POSE_PRESETS[k].label})`).join('、')}`,
            enum: [...ALL_POSE_KEYS],
          },
        },
        required: ['pose'],
      },
    },
  },
  handler: async (args) => {
    const pose = String(args.pose ?? '')
    if (!ALL_POSE_KEYS.includes(pose as any)) {
      log.warn("tool_character.module.warn", `不支持的屏幕位置: ${pose}`, undefined, { pose: pose })
      return `不支持 "${pose}"，可选: ${ALL_POSE_KEYS.join(', ')}`
    }
    const store = useCharacterStore()
    if (!store.setScreenPose(pose as any)) return '角色运行时未初始化'
    const label = POSE_PRESETS[pose as keyof typeof POSE_PRESETS]?.label ?? pose
    log.info("tool_character.module.info", `屏幕位置切换: ${pose} (${label})`, { pose: pose, label: label })
    return `屏幕位置已切换为「${label}」`
  },
}

/** 获取当前角色状态 */
export const getStateTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_character_state',
      description: '获取角色当前的状态：姿势、表情、服装、屏幕位置、当前显示的图片',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  handler: async () => {
    const store = useCharacterStore()
    const snapshot = store.getRuntimeSnapshot()
    if (!snapshot.look || !snapshot.capabilities) return '角色运行时未初始化'
    const screenLabel = POSE_PRESETS[snapshot.look.screenPose as keyof typeof POSE_PRESETS]?.label ?? snapshot.look.screenPose
    if (snapshot.render === 'live2d') {
      return [
        `角色: ${store.name}`,
        `表情: ${snapshot.look.emotion || '（默认）'}`,
        `屏幕位置: ${screenLabel}`,
        `可用表情: ${snapshot.capabilities.emotions.join('、') || '无'}`,
        `可用动作: ${snapshot.capabilities.motions.map(motion => motion.group).join('、') || '无'}`,
      ].join('\n')
    }
    const state = {
      character: store.name,
      pose: snapshot.look.stance,
      emotion: snapshot.look.emotion,
      costume: snapshot.look.costume,
      screen: screenLabel,
    }
    log.debug("tool_character.module.debug", `查询角色状态: ${JSON.stringify(state)}`, { state: state })
    return [
      `角色: ${state.character}`,
      `姿势: ${state.pose}`,
      `表情: ${state.emotion}`,
      `服装: ${state.costume}`,
      `屏幕位置: ${screenLabel}`,
    ].join('\n')
  },
}
