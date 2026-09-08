/**
 * 角色控制工具（三维标签）
 *
 * 通过 agentCtx 获取角色数据和控制器，不直接耦合 Pinia store。
 */
import type { Tool } from '../types'
import { ALL_POSE_KEYS, POSE_PRESETS } from '../../character'
import { getAgentCharData, getAgentController, getAgentLive2DController } from '../context'
import { createLogger } from '../../utils/logger'

const log = createLogger('ToolCharacter')

function getStore() {
  const data = getAgentCharData()
  const ctrl = getAgentController()
  if (!data || !ctrl) return null
  return {
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
    const ctrl = getAgentController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setEmotion(emotion)
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
    const ctrl = getAgentController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setPoseTag(stance)
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
    const ctrl = getAgentController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setCostume(costume)
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
    const ctrl = getAgentController()
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
    const render = getAgentCharData()?.render ?? 'illustration'
    const ctrl = render === 'live2d' ? getAgentLive2DController() : getAgentController()
    if (!ctrl) return '角色控制器未初始化'
    ctrl.setScreenPose(pose as any)
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
    const render = getAgentCharData()?.render ?? 'illustration'
    // Live2D 角色：读 Live2D 控制器状态
    if (render === 'live2d') {
      const l = getAgentLive2DController()
      if (!l) return '角色控制器未初始化'
      const s = l.getState()
      const screenLabel = POSE_PRESETS[s.screenPose]?.label ?? s.screenPose
      return [
        `角色: ${s.character}`,
        `表情: ${s.expression || '（默认）'}`,
        `屏幕位置: ${screenLabel}`,
        `可用表情: ${s.expressions.map(e => e.id).join('、') || '无'}`,
        `可用动作: ${s.motions.map(m => m.group).join('、') || '无'}`,
      ].join('\n')
    }
    const ctrl = getAgentController()
    if (!ctrl) return '角色控制器未初始化'
    const img = ctrl.currentImage.value
    const screenPose = ctrl.currentScreenPose.value
    const screenLabel = POSE_PRESETS[screenPose]?.label ?? screenPose
    const state = {
      character: ctrl.charStore.name,
      pose: ctrl.currentPoseTag.value,
      emotion: ctrl.currentEmotion.value,
      costume: ctrl.currentCostume.value,
      screen: screenLabel,
    }
    log.debug("tool_character.module.debug", `查询角色状态: ${JSON.stringify(state)}`, { state: state })
    return [
      `角色: ${state.character}`,
      `姿势: ${state.pose}`,
      `表情: ${state.emotion}`,
      `服装: ${state.costume}`,
      `屏幕位置: ${screenLabel}`,
      `当前图片: ${img?.file ?? '无'}`,
    ].join('\n')
  },
}

