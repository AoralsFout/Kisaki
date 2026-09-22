/**
 * 角色工具运行时端口。
 *
 * 这是角色 Store / Runtime 适配器给工具层的最小能力面。端口只暴露可复制的
 * 角色事实和工具需要的命令，不把 Pinia、renderer 或工作区授权带进工具契约。
 */
import type { CharacterData } from '../../character/loader'
import type { ToolCharacterRuntimePort } from '../../domain/tools/contracts'
import type {
  CharacterCapabilities,
  CharacterLook,
  CharacterRenderKind,
} from './characterRuntime'

export interface CharacterToolIdentity {
  id: string
  name: string
}

export interface CharacterToolRuntimeState {
  identity: CharacterToolIdentity | null
  data: CharacterData | null
  render: CharacterRenderKind | null
  look: CharacterLook | null
  capabilities: CharacterCapabilities | null
}

export interface CharacterToolRuntimePort extends ToolCharacterRuntimePort {
  /** 返回当前角色事实快照；调用方不得修改返回值。 */
  state(): CharacterToolRuntimeState
  /** 更新角色的情绪、姿势或服装；失败时保持现有回执语义。 */
  setLook(change: Partial<Pick<CharacterLook, 'emotion' | 'stance' | 'costume'>>): boolean
  /** 更新屏幕姿态。 */
  setScreenPose(pose: string): boolean
  /** 播放 Live2D 动作；renderer 未挂载时返回 false。 */
  playMotion(group: string, index: number): Promise<boolean>
}
