import { EVENT_CHARACTERS_CHANGED } from '../constants'

/** 角色编辑完成增删改后通知其它窗口刷新角色显示数据。 */
export type CharacterChangedEmitter = (event: typeof EVENT_CHARACTERS_CHANGED) => Promise<unknown>

/**
 * 跨窗口角色变更协议的唯一出口。
 * 事件不携带 payload；接收方收到后重新扫描角色文件并决定如何刷新当前角色。
 */
export function emitCharactersChanged(emitter: CharacterChangedEmitter): Promise<unknown> {
  return emitter(EVENT_CHARACTERS_CHANGED)
}
