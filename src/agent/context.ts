/**
 * Agent 上下文 — 依赖注入容器
 *
 * 替代 agent 工具直接 import Pinia store / commandBus 等模块，
 * 由上层（App.vue）在初始化时注入依赖，切断循环依赖链。
 *
 * 使用方式：
 *   import { agentCtx } from './context'
 *   agentCtx.getController()?.setEmotion('happy')
 */
import type { CharacterController } from '../character/controller'
import type { CharacterData } from '../character/loader'
import type { Live2DController } from '../character/live2d/controller'
import type { Live2DManifest } from '../character/live2d/manifest'

interface AgentContext {
  /** 当前角色数据（用于动态注入工具参数的枚举值） */
  charData: CharacterData | null
  /** 立绘角色控制器（用于执行 set_* 工具） */
  controller: CharacterController | null
  /** Live2D 角色控制器（用于执行 set_expression / play_motion 工具） */
  live2d: Live2DController | null
  /** 当前 Live2D 模型清单（registry 注入表情/动作枚举用） */
  live2dManifest: Live2DManifest | null
  /**
   * 切换角色后刷新对话人格（system prompt）的回调。
   * 由 App.vue 注入；switch_character 工具在切换完成后调用，
   * 使 AI 自助切换角色时也能加载新角色的人设与语言配置。
   */
  onCharacterSwitched: (() => void) | null
}

const ctx: AgentContext = {
  charData: null,
  controller: null,
  live2d: null,
  live2dManifest: null,
  onCharacterSwitched: null,
}

/** 注入当前角色数据（由 chat.ts 在每次对话前调用） */
export function setAgentCharData(data: CharacterData | null) {
  ctx.charData = data
}

/** 注入角色控制器（由 Character.vue 挂载时调用） */
export function setAgentController(ctrl: CharacterController | null) {
  ctx.controller = ctrl
}

/** 注入 Live2D 控制器（由 Live2DStage 在模型 ready 后调用） */
export function setAgentLive2DController(ctrl: Live2DController | null) {
  ctx.live2d = ctrl
}

/** 读取 Live2D 控制器（供 tools/live2d.ts 与共享工具使用） */
export function getAgentLive2DController(): Live2DController | null {
  return ctx.live2d
}

/** 注入当前 Live2D 清单（由 Live2DStage 在加载后调用，供 registry 注入枚举） */
export function setAgentLive2DManifest(mf: Live2DManifest | null) {
  ctx.live2dManifest = mf
}

/** 读取当前 Live2D 清单（供 registry.ts 注入枚举） */
export function getAgentLive2DManifest(): Live2DManifest | null {
  return ctx.live2dManifest
}

/** 注入“切换角色后刷新人格”回调（由 App.vue 注入） */
export function setOnCharacterSwitched(fn: (() => void) | null) {
  ctx.onCharacterSwitched = fn
}

/** 读取“切换角色后刷新人格”回调（供 tools/character.ts 使用） */
export function getOnCharacterSwitched(): (() => void) | null {
  return ctx.onCharacterSwitched
}

/** 读取角色数据（供 registry.ts 使用） */
export function getAgentCharData(): CharacterData | null {
  return ctx.charData
}

/** 读取角色控制器（供 tools/character.ts 使用） */
export function getAgentController(): CharacterController | null {
  return ctx.controller
}
