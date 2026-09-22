/**
 * Character Store 到角色工具运行时端口的适配器。
 *
 * 该适配器是唯一需要知道 Pinia Store facade 的角色工具接线点；工具模块和
 * 回合编排都只依赖 CharacterToolRuntimePort。
 */
import { useCharacterStore } from '../../stores/character'
import type { PoseKey } from '../../character/poses'
import type { CharacterToolRuntimePort, CharacterToolRuntimeState } from '../../application/character/characterToolRuntime'

export class CharacterStoreToolRuntimePort implements CharacterToolRuntimePort {
  state(): CharacterToolRuntimeState {
    const store = useCharacterStore()
    const data = store.data
    const snapshot = store.getRuntimeSnapshot()
    return {
      identity: data ? { id: store.currentId, name: store.name } : null,
      data,
      render: snapshot.render ?? data?.render ?? null,
      look: snapshot.look,
      capabilities: snapshot.capabilities,
    }
  }

  setLook(change: Parameters<CharacterToolRuntimePort['setLook']>[0]): boolean {
    return useCharacterStore().setVisualLook(change)
  }

  setScreenPose(pose: string): boolean {
    return useCharacterStore().setScreenPose(pose as PoseKey)
  }

  playMotion(group: string, index: number): Promise<boolean> {
    return useCharacterStore().playMotion(group, index)
  }
}
