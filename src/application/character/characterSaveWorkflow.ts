import { buildCharacterJson, type CharacterEdits } from '../../character/characterJson'
import type { CharacterData, RenderKind } from '../../character/loader'
import type { CharacterFilePort } from './characterFilePort'

/** 保存编排器的固定阶段；顺序是持久化协议的一部分。 */
export type CharacterSaveStep = 'prompt' | 'definition' | 'orphan-images' | 'cache' | 'broadcast'

export interface CharacterSaveDiagnostic {
  /** 发生诊断的保存阶段。 */
  step: CharacterSaveStep
  /** 面向调用方的稳定原因文本。 */
  reason: string
  /** 孤儿图清理、缓存和广播失败不会回滚已写入文件。 */
  ignorable: boolean
  /** 发生在孤儿图阶段时标记具体文件。 */
  filename?: string
  /** 保留原始异常，供日志或调试使用。 */
  cause?: unknown
}

export interface CharacterSaveRequest {
  characterId: string
  data: CharacterData
  render: RenderKind
  edits: CharacterEdits
  prompt: string
}

/** 保存后置动作也是端口，调用方不需要记住 cache bust 或跨窗口广播。 */
export interface CharacterSaveWorkflowPorts {
  files: CharacterFilePort
  refreshCache(): void | Promise<void>
  broadcastCharactersChanged(): void | Promise<void>
}

export interface CharacterSaveResult {
  /** 必要写入成功即为 saved；可忽略诊断不会把已提交结果伪装成 failed。 */
  status: 'saved' | 'failed'
  success: boolean
  /** success 的简短别名，便于调用方在不依赖 status 字符串时判断。 */
  ok: boolean
  diagnostics: CharacterSaveDiagnostic[]
  /** 已完成或已尝试的阶段，按实际调用顺序排列。 */
  completedSteps: CharacterSaveStep[]
  /** 实际写入的 JSON 文本，便于同步层以提交快照收敛。 */
  definition: string | null
  /** 本次根据原始文件和编辑快照计算出的孤儿图集合。 */
  orphanedFiles: string[]
}

function reasonFrom(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

function diagnostic(
  step: CharacterSaveStep,
  error: unknown,
  ignorable: boolean,
  filename?: string,
): CharacterSaveDiagnostic {
  return {
    step,
    reason: reasonFrom(error),
    ignorable,
    ...(filename ? { filename } : {}),
    cause: error,
  }
}

function orphanedImageFiles(data: CharacterData, edits: CharacterEdits): string[] {
  // 只有静态立绘编辑会提供 images；Live2D 保存不能误删旧角色的图片集合。
  if (!edits.images) return []
  const currentFiles = new Set(edits.images.map(image => image.file))
  return data.images
    .map(image => image.file)
    .filter((filename, index, files) => !currentFiles.has(filename) && files.indexOf(filename) === index)
}

function failedResult(
  diagnostics: CharacterSaveDiagnostic[],
  completedSteps: CharacterSaveStep[],
  definition: string | null,
  orphanedFiles: string[],
): CharacterSaveResult {
  return {
    status: 'failed',
    success: false,
    ok: false,
    diagnostics,
    completedSteps,
    definition,
    orphanedFiles,
  }
}

/**
 * 执行角色编辑的单一保存过程。
 *
 * 严格顺序：写 prompt.txt → 写 character.json → 删除孤儿图 → 刷新缓存 → 广播。
 * 两个文件写入失败会停止流程；清理、缓存和广播失败会继续后续阶段，
 * 但都会以 ignorable=true 的结构化诊断返回，绝不静默吞掉。
 */
export async function saveCharacter(
  request: CharacterSaveRequest,
  ports: CharacterSaveWorkflowPorts,
): Promise<CharacterSaveResult> {
  const diagnostics: CharacterSaveDiagnostic[] = []
  const completedSteps: CharacterSaveStep[] = []
  const orphanedFiles = orphanedImageFiles(request.data, request.edits)
  let definition: string | null = null

  try {
    await ports.files.writePrompt(request.characterId, request.prompt)
    completedSteps.push('prompt')
  } catch (error) {
    diagnostics.push(diagnostic('prompt', error, false))
    return failedResult(diagnostics, completedSteps, definition, orphanedFiles)
  }

  try {
    // buildCharacterJson 从已有数据展开，未知字段与已有 Live2D 配置因此不会丢失。
    definition = JSON.stringify(
      buildCharacterJson(request.data, request.render, request.edits),
      null,
      2,
    )
    await ports.files.writeDefinition(request.characterId, definition)
    completedSteps.push('definition')
  } catch (error) {
    diagnostics.push(diagnostic('definition', error, false))
    return failedResult(diagnostics, completedSteps, definition, orphanedFiles)
  }

  for (const filename of orphanedFiles) {
    try {
      await ports.files.deleteImage(request.characterId, filename)
    } catch (error) {
      diagnostics.push(diagnostic('orphan-images', error, true, filename))
    }
  }
  completedSteps.push('orphan-images')

  try {
    await ports.refreshCache()
  } catch (error) {
    diagnostics.push(diagnostic('cache', error, true))
  }
  completedSteps.push('cache')

  try {
    await ports.broadcastCharactersChanged()
  } catch (error) {
    diagnostics.push(diagnostic('broadcast', error, true))
  }
  completedSteps.push('broadcast')

  return {
    status: 'saved',
    success: true,
    ok: true,
    diagnostics,
    completedSteps,
    definition,
    orphanedFiles,
  }
}

/** 面向组合根的命名别名，保留 saveCharacter 作为纯函数式入口。 */
export const runCharacterSave = saveCharacter
