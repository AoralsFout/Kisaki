import { chooseCharacterAfterDelete } from '../../character/editorSafety'

/** 删除流程中可能失败的阶段。 */
export type CharacterDeletionFailureStep = 'delete' | 'refresh' | 'load-replacement' | 'broadcast'

export interface CharacterDeletionError {
  /** 供界面统一识别删除失败，而不依赖底层异常类型。 */
  code: 'character-deletion-failed'
  step: CharacterDeletionFailureStep
  reason: string
  cause?: unknown
}

export interface CharacterDeletionRequest {
  targetId: string
  currentId: string | null
  /** 删除前的列表快照；刷新端口返回新列表时以新列表为准。 */
  availableIds?: readonly string[]
  /** 与 availableIds 等价的兼容命名，便于组合根直接传入 store 列表。 */
  availableList?: readonly string[]
  /** 确认弹窗只负责提供这个事实，工作流不会自行绕过确认。 */
  confirmed: boolean
}

export interface CharacterDeletionPorts {
  deleteCharacter: (characterId: string) => Promise<void>
  /** 可返回刷新后的显示数据；返回 void 时回退到请求中的删除前列表。 */
  refreshDisplayData: () => Promise<readonly string[] | void>
  /** currentId 删除后传入替代 id；最后一个角色传入 null 进入明确空状态。 */
  loadReplacement?: (characterId: string | null) => Promise<void>
  emitCharactersChanged: () => void | Promise<void>
}

export interface CharacterDeletionCancelled {
  status: 'cancelled'
  targetId: string
}

export interface CharacterDeletionBusy {
  status: 'busy'
  targetId: string
  activeTargetId: string
}

export interface CharacterDeletionSucceeded {
  status: 'succeeded'
  targetId: string
  /** 非当前角色删除时为 null；当前角色删除时是确定的替代角色或空状态。 */
  replacementId: string | null
}

export interface CharacterDeletionFailed {
  status: 'failed'
  targetId: string
  /** 失败时组合根应保持当前编辑页和草稿不变。 */
  preserveEditor: true
  error: CharacterDeletionError
  /** 便于界面直接展示统一错误文案。 */
  reason: string
}

export type CharacterDeletionResult =
  | CharacterDeletionCancelled
  | CharacterDeletionBusy
  | CharacterDeletionSucceeded
  | CharacterDeletionFailed

type RefreshResult = readonly string[] | void

/** 将 Tauri 的字符串、Error 和未知异常归一成稳定的界面诊断文本。 */
export function characterDeletionReason(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === 'string' && cause) return cause
  try {
    const serialized = JSON.stringify(cause)
    if (serialized !== undefined) return serialized
  } catch {
    // 循环对象等不可序列化值继续使用字符串兜底。
  }
  return String(cause)
}

function availableIdsOf(request: CharacterDeletionRequest): readonly string[] {
  return request.availableIds ?? request.availableList ?? []
}

function failed(
  targetId: string,
  step: CharacterDeletionFailureStep,
  cause: unknown,
): CharacterDeletionFailed {
  const reason = characterDeletionReason(cause)
  return {
    status: 'failed',
    targetId,
    preserveEditor: true,
    error: { code: 'character-deletion-failed', step, reason, cause },
    reason,
  }
}

/**
 * 角色删除工作流的应用层编排器。
 *
 * 删除确认属于界面职责；这里仅消费 confirmed 事实，然后按
 * 删除 → 刷新 →（当前角色时加载替代/空状态）→ 广播的顺序执行。
 * 工作流不修改编辑草稿，也不决定页面导航。
 */
export class CharacterDeletionWorkflow {
  private activeTargetIdValue: string | null = null

  constructor(private readonly ports: CharacterDeletionPorts) {}

  get busy(): boolean {
    return this.activeTargetIdValue !== null
  }

  get activeTargetId(): string | null {
    return this.activeTargetIdValue
  }

  async delete(request: CharacterDeletionRequest): Promise<CharacterDeletionResult> {
    if (!request.confirmed) return { status: 'cancelled', targetId: request.targetId }
    if (this.activeTargetIdValue !== null) {
      return {
        status: 'busy',
        targetId: request.targetId,
        activeTargetId: this.activeTargetIdValue,
      }
    }
    if (!request.targetId.trim()) {
      return failed(request.targetId, 'delete', new Error('角色 ID 不能为空'))
    }

    this.activeTargetIdValue = request.targetId
    try {
      try {
        await this.ports.deleteCharacter(request.targetId)
      } catch (cause) {
        return failed(request.targetId, 'delete', cause)
      }

      let refreshedIds: RefreshResult
      try {
        refreshedIds = await this.ports.refreshDisplayData()
      } catch (cause) {
        return failed(request.targetId, 'refresh', cause)
      }

      let replacementId: string | null = null
      if (request.currentId === request.targetId) {
        // 以刷新后的列表为准；防御性排除已删除 id，避免过时投影导致回载已删角色。
        const candidates = (refreshedIds ?? availableIdsOf(request))
          .filter(characterId => characterId !== request.targetId)
        replacementId = chooseCharacterAfterDelete(
          request.targetId,
          request.targetId,
          candidates,
        )
        if (this.ports.loadReplacement) {
          try {
            await this.ports.loadReplacement(replacementId)
          } catch (cause) {
            return failed(request.targetId, 'load-replacement', cause)
          }
        }
      }

      try {
        await this.ports.emitCharactersChanged()
      } catch (cause) {
        return failed(request.targetId, 'broadcast', cause)
      }

      return { status: 'succeeded', targetId: request.targetId, replacementId }
    } finally {
      this.activeTargetIdValue = null
    }
  }

  /** 语义别名，便于组合根使用动词化 API。 */
  async deleteCharacter(request: CharacterDeletionRequest): Promise<CharacterDeletionResult> {
    return this.delete(request)
  }
}

export function createCharacterDeletionWorkflow(ports: CharacterDeletionPorts): CharacterDeletionWorkflow {
  return new CharacterDeletionWorkflow(ports)
}

/** 单次调用入口；需要跨调用 busy 锁时应复用 CharacterDeletionWorkflow 实例。 */
export async function runCharacterDeletion(
  request: CharacterDeletionRequest,
  ports: CharacterDeletionPorts,
): Promise<CharacterDeletionResult> {
  return new CharacterDeletionWorkflow(ports).delete(request)
}

