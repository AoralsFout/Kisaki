/**
 * 角色控制工具（三维标签）
 *
 * 使用 useCharacterStore 获取当前角色的标签列表。
 */
import type { Tool } from '../types'
import { ALL_POSE_KEYS, POSE_PRESETS } from '../../character'
import { useCharacterStore } from '../../stores/character'
import { getCharacterController } from '../../character/commandBus'

function getStore() {
  return useCharacterStore()
}

/** 切换情绪 */
export const setEmotionTool: Tool = {
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
    if (store.emotions.length && !store.emotions.includes(emotion)) {
      return `不支持的情绪。可用: ${store.emotions.join(', ')}`
    }
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setEmotion(emotion)
    return `表情已切换为「${emotion}」`
  },
}

/** 切换姿势标签 */
export const setStanceTool: Tool = {
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
    if (store.poses.length && !store.poses.includes(stance)) {
      return `不支持的姿势。可用: ${store.poses.join(', ')}`
    }
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setPoseTag(stance)
    return `姿势已切换为「${stance}」`
  },
}

/** 切换服装 */
export const setCostumeTool: Tool = {
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
    if (store.costumes.length && !store.costumes.includes(costume)) {
      return `不支持的服装。可用: ${store.costumes.join(', ')}`
    }
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setCostume(costume)
    return `服装已切换为「${costume}」`
  },
}

/** 统一设置 */
export const setLookTool: Tool = {
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
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setLook({
      pose: args.stance || undefined,
      emotion: args.emotion || undefined,
      costume: args.costume || undefined,
    })
    const parts: string[] = []
    if (args.stance) parts.push(`姿势=${args.stance}`)
    if (args.emotion) parts.push(`表情=${args.emotion}`)
    if (args.costume) parts.push(`服装=${args.costume}`)
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
      return `不支持 "${pose}"，可选: ${ALL_POSE_KEYS.join(', ')}`
    }
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setScreenPose(pose as any)
    return `屏幕位置已切换为「${POSE_PRESETS[pose as keyof typeof POSE_PRESETS]?.label ?? pose}」`
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
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    const img = ctrl.currentImage.value
    const screenPose = ctrl.currentScreenPose.value
    const screenLabel = POSE_PRESETS[screenPose]?.label ?? screenPose
    return [
      `角色: ${ctrl.charStore.name}`,
      `姿势: ${ctrl.currentPoseTag.value}`,
      `表情: ${ctrl.currentEmotion.value}`,
      `服装: ${ctrl.currentCostume.value}`,
      `屏幕位置: ${screenLabel}`,
      `当前图片: ${img?.file ?? '无'}`,
    ].join('\n')
  },
}

/** 切换角色 */
export const switchCharacterTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'switch_character',
      description: '切换到另一个角色（更换立绘、服装和人格）',
      parameters: {
        type: 'object',
        properties: {
          character_id: {
            type: 'string',
            description: '角色ID',
          },
        },
        required: ['character_id'],
      },
    },
  },
  handler: async (args) => {
    const id = String(args.character_id ?? '')
    const store = getStore()
    if (!store.availableList.includes(id)) {
      return `未知角色 "${id}"，可用: ${store.availableList.join(', ')}`
    }
    const ctrl = getCharacterController()
    if (!ctrl) return '角色控制器未初始化'
    await ctrl.switchCharacter(id)
    return `已切换到 ${store.name}`
  },
}

