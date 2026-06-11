/**
 * 角色控制器注册表
 *
 * 让 Agent 工具能够访问主窗口的 CharacterController。
 * Character.vue 挂载时注册，Agent 工具通过它控制角色。
 */
import type { CharacterController } from './controller'
import { createLogger } from '../utils/logger'

const log = createLogger('CommandBus')

let controller: CharacterController | null = null

/** 注册控制器（Character.vue 挂载时调用） */
export function registerCharacterController(c: CharacterController) {
  controller = c
  log.info('角色控制器已注册')
}

/** 获取控制器（Agent 工具调用） */
export function getCharacterController(): CharacterController | null {
  return controller
}
