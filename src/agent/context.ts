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

interface AgentContext {
  /** 当前角色数据（用于动态注入工具参数的枚举值） */
  charData: CharacterData | null
  /** 角色控制器（用于执行 set_* 工具） */
  controller: CharacterController | null
}

const ctx: AgentContext = {
  charData: null,
  controller: null,
}

/** 注入当前角色数据（由 chat.ts 在每次对话前调用） */
export function setAgentCharData(data: CharacterData | null) {
  ctx.charData = data
}

/** 注入角色控制器（由 Character.vue 挂载时调用） */
export function setAgentController(ctrl: CharacterController | null) {
  ctx.controller = ctrl
}

/** 读取角色数据（供 registry.ts 使用） */
export function getAgentCharData(): CharacterData | null {
  return ctx.charData
}

/** 读取角色控制器（供 tools/character.ts 使用） */
export function getAgentController(): CharacterController | null {
  return ctx.controller
}
