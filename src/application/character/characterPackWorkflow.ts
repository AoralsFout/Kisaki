/**
 * 角色包导入/导出工作流。
 *
 * 该模块只负责应用层编排：文件选择、Tauri 命令、显示数据刷新、图片
 * 缓存失效和跨窗口广播都通过端口注入。角色包的 zip 布局与安全校验仍由
 * Rust `pack` 模块负责，前端不复制那部分规则。
 */
import { characterErrorReason } from './characterError'

export type CharacterPackOperation = 'import' | 'export'
export type CharacterPackFailureStep =
  | 'path-selection'
  | 'command'
  | 'result-validation'
  | 'refresh-display-data'
  | 'bust-image-cache'
  | 'broadcast'

export interface CharacterPackImportPayload {
  imported: string[]
  skipped: string[]
}

export interface CharacterPackImportSuccess extends CharacterPackImportPayload {
  status: 'succeeded'
  operation: 'import'
}

export interface CharacterPackExportSuccess {
  status: 'succeeded'
  operation: 'export'
}

export interface CharacterPackCancelled {
  status: 'cancelled'
  operation: CharacterPackOperation
}

export interface CharacterPackBusy {
  status: 'busy'
  operation: CharacterPackOperation
  /** 当前正在执行的操作；调用方可据此决定提示文案。 */
  activeOperation: CharacterPackOperation
}

export interface CharacterPackFailure {
  status: 'failed'
  operation: CharacterPackOperation
  step: CharacterPackFailureStep
  /** 已归一化为字符串，适合直接交给界面诊断。 */
  reason: string
  cause?: unknown
}

export type CharacterPackImportResult =
  | CharacterPackImportSuccess
  | CharacterPackCancelled
  | CharacterPackBusy
  | CharacterPackFailure

export type CharacterPackExportResult =
  | CharacterPackExportSuccess
  | CharacterPackCancelled
  | CharacterPackBusy
  | CharacterPackFailure

/**
 * 工作流依赖的端口集合。端口不包含 Vue、Pinia 或 Tauri 类型，便于在
 * 应用层测试中使用内存 fake，也便于最终组合根统一装配。
 */
export interface CharacterPackWorkflowPorts {
  selectImportPath: () => Promise<string | null | undefined>
  selectExportPath: (characterId: string) => Promise<string | null | undefined>
  importPack: (sourcePath: string) => Promise<unknown>
  exportPack: (characterId: string, destinationPath: string) => Promise<void>
  refreshDisplayData: () => Promise<void>
  bustImageCache: () => void | Promise<void>
  emitCharactersChanged: () => void | Promise<unknown>
}

interface Failure extends Error {
  step: CharacterPackFailureStep
  cause?: unknown
}

function failure(step: CharacterPackFailureStep, cause: unknown): Failure {
  const error = new Error(characterErrorReason(cause)) as Failure
  error.step = step
  error.cause = cause
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseImportPayload(value: unknown): CharacterPackImportPayload {
  if (
    !isRecord(value)
    || !isStringArray(value.imported)
    || !isStringArray(value.skipped)
  ) {
    throw failure('result-validation', new Error('角色包导入返回值格式无效'))
  }
  return { imported: [...value.imported], skipped: [...value.skipped] }
}

function validPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && path.trim().length > 0
}

/**
 * 角色包工作流的唯一可变状态是 busy 锁；角色数据仍归角色 Store/草稿同步层。
 */
export class CharacterPackWorkflow {
  private activeOperationValue: CharacterPackOperation | null = null

  constructor(private readonly ports: CharacterPackWorkflowPorts) {}

  get busy(): boolean {
    return this.activeOperationValue !== null
  }

  get activeOperation(): CharacterPackOperation | null {
    return this.activeOperationValue
  }

  async importCharacterPack(): Promise<CharacterPackImportResult> {
    const operation: CharacterPackOperation = 'import'
    if (this.activeOperationValue !== null) {
      return { status: 'busy', operation, activeOperation: this.activeOperationValue }
    }

    this.activeOperationValue = operation
    try {
      let sourcePath: string | null | undefined
      try {
        sourcePath = await this.ports.selectImportPath()
      } catch (cause) {
        return this.failed(operation, failure('path-selection', cause))
      }
      if (!validPath(sourcePath)) return { status: 'cancelled', operation }

      let raw: unknown
      try {
        raw = await this.ports.importPack(sourcePath)
      } catch (cause) {
        return this.failed(operation, failure('command', cause))
      }

      let payload: CharacterPackImportPayload
      try {
        payload = parseImportPayload(raw)
      } catch (cause) {
        return this.failed(operation, cause)
      }

      try {
        await this.ports.refreshDisplayData()
      } catch (cause) {
        return this.failed(operation, failure('refresh-display-data', cause))
      }
      try {
        await this.ports.bustImageCache()
      } catch (cause) {
        return this.failed(operation, failure('bust-image-cache', cause))
      }
      try {
        await this.ports.emitCharactersChanged()
      } catch (cause) {
        return this.failed(operation, failure('broadcast', cause))
      }

      return { status: 'succeeded', operation, ...payload }
    } finally {
      this.activeOperationValue = null
    }
  }

  async exportCharacterPack(characterId: string): Promise<CharacterPackExportResult> {
    const operation: CharacterPackOperation = 'export'
    if (this.activeOperationValue !== null) {
      return { status: 'busy', operation, activeOperation: this.activeOperationValue }
    }

    this.activeOperationValue = operation
    try {
      if (!validPath(characterId)) {
        return this.failed(operation, failure('command', new Error('角色 ID 不能为空')))
      }

      let destinationPath: string | null | undefined
      try {
        destinationPath = await this.ports.selectExportPath(characterId)
      } catch (cause) {
        return this.failed(operation, failure('path-selection', cause))
      }
      if (!validPath(destinationPath)) return { status: 'cancelled', operation }

      try {
        await this.ports.exportPack(characterId, destinationPath)
      } catch (cause) {
        return this.failed(operation, failure('command', cause))
      }

      return { status: 'succeeded', operation }
    } finally {
      this.activeOperationValue = null
    }
  }

  private failed(
    operation: CharacterPackOperation,
    cause: unknown,
  ): CharacterPackFailure {
    const error = cause as Partial<Failure> & { cause?: unknown }
    const step: CharacterPackFailureStep = error.step ?? 'command'
    return {
      status: 'failed',
      operation,
      step,
      reason: characterErrorReason(cause),
      cause: error.cause,
    }
  }
}

export function createCharacterPackWorkflow(ports: CharacterPackWorkflowPorts): CharacterPackWorkflow {
  return new CharacterPackWorkflow(ports)
}
