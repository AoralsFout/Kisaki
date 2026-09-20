import type { CharacterFilePort } from './characterFilePort'
import type { RenderKind } from '../../character/loader'

/** 新建角色表单的渲染类型。 */
export type CharacterCreationRender = RenderKind

/** 目录选择器可以只返回路径，也可以同时返回已扫描到的文件名。 */
export interface Live2DModelSelection {
  directory: string
  files?: readonly string[]
}

export interface CharacterCreationInput {
  id: string
  name: string
  description: string
  render: CharacterCreationRender
  live2dModel?: Live2DModelSelection | string | null
  /** 与旧创建表单字段同义，便于组合根逐步迁移。 */
  modelDirectory?: string
  live2dModelDirectory?: string
}

export type CharacterCreationField = 'id' | 'name' | 'description' | 'render' | 'live2dModel'

export type CharacterCreationValidationErrorCode =
  | 'required'
  | 'invalid-format'
  | 'already-exists'
  | 'model-required'
  | 'model-file-missing'

export type CharacterCreationValidationErrors = Partial<
  Record<CharacterCreationField, CharacterCreationValidationErrorCode>
>

export interface CharacterCreationValidation {
  valid: boolean
  /** 字段级稳定错误码，界面负责映射为文案。 */
  errors: CharacterCreationValidationErrors
}

export interface CharacterCreationValidationContext {
  existingIds: readonly string[]
}

export type CharacterCreationValidationInput = CharacterCreationValidationContext | readonly string[]

function normalizeSelection(
  selection: Live2DModelSelection | string | null | undefined,
): Live2DModelSelection | null {
  if (typeof selection === 'string') return { directory: selection }
  return selection ?? null
}

/**
 * 校验创建表单，不访问文件系统，也不产生副作用。
 *
 * 当选择器能提供目录清单时，这里会提前检查后端导入所需的 `*.model3.json`；
 * 若只能提供目录路径，则由导入端口再次执行同一完整性校验。
 */
export function validateCreateCharacter(
  input: CharacterCreationInput,
  context: CharacterCreationValidationInput,
): CharacterCreationValidation {
  const errors: CharacterCreationValidationErrors = {}
  const id = input.id.trim()
  const existingIds = Array.isArray(context)
    ? context
    : (context as CharacterCreationValidationContext).existingIds

  if (!id) errors.id = 'required'
  else if (!/^[a-z][a-z0-9_]*$/.test(id)) errors.id = 'invalid-format'
  else if (existingIds.includes(id)) errors.id = 'already-exists'

  if (!input.render) errors.render = 'required'

  if (input.render === 'live2d') {
    const model = normalizeSelection(input.live2dModel ?? input.modelDirectory ?? input.live2dModelDirectory)
    if (!model?.directory.trim()) {
      errors.live2dModel = 'model-required'
    } else if (
      model.files &&
      !model.files.some(file => file.toLowerCase().endsWith('.model3.json'))
    ) {
      errors.live2dModel = 'model-file-missing'
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

/** 保持现有角色文件兼容格式的默认人设。 */
export function buildCharacterPrompt(name: string): string {
  return `你是 ${name}，一个可爱的桌面宠物。`
}

/** 构造现有 loader 可读取的 character.json 内容。 */
export function buildNewCharacterDefinition(
  input: CharacterCreationInput,
  model?: string,
): Record<string, unknown> {
  const id = input.id.trim()
  const name = input.name.trim() || id
  const description = input.description.trim() || name
  const common = {
    id,
    name,
    description,
    version: 2,
    prompt: '',
    poses: input.render === 'illustration' ? ['standing'] : [],
    emotions: input.render === 'illustration' ? ['idle'] : [],
    costumes: input.render === 'illustration' ? ['default'] : [],
    images: [],
    voice: '',
    voiceModel: '',
    voiceLanguage: 'ja-JP',
    textLanguage: 'zh-CN',
  }

  if (input.render === 'live2d') {
    return {
      ...common,
      render: 'live2d',
      live2d: { model: model ?? '', scale: 1, mouseFollow: true },
    }
  }

  return { ...common, render: 'illustration' }
}

export interface CharacterCreationPorts {
  files: Pick<CharacterFilePort, 'writePrompt' | 'writeDefinition'>
  importLive2DModel?(characterId: string, sourceDirectory: string): Promise<string>
  /** 写入阶段失败后清理已创建目录，避免留下不可见的半成品角色。 */
  deleteCharacter?(characterId: string): Promise<void>
  refreshDisplayData(): void | Promise<void>
  broadcastCharactersChanged(): void | Promise<void>
  enterEditor(characterId: string): void | Promise<void>
}

export type CharacterCreationStage =
  | 'validation'
  | 'live2d-import'
  | 'definition'
  | 'prompt'
  | 'refresh'
  | 'broadcast'
  | 'navigate'

export interface CharacterCreationError {
  stage: CharacterCreationStage
  reason: string
  cause?: unknown
}

export interface CharacterCreationResult {
  status: 'created' | 'invalid' | 'failed'
  success: boolean
  ok: boolean
  validation: CharacterCreationValidation
  error?: CharacterCreationError
  character?: {
    id: string
    name: string
    render: CharacterCreationRender
    definition: string
    prompt: string
    model?: string
  }
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

function failed(
  validation: CharacterCreationValidation,
  stage: CharacterCreationStage,
  cause: unknown,
): CharacterCreationResult {
  return {
    status: 'failed',
    success: false,
    ok: false,
    validation,
    error: { stage, reason: reasonFrom(cause), cause },
  }
}

/**
 * 新建角色的单一编排过程。
 *
 * 校验和 Live2D 导入均成功后才写入角色定义；写入中途失败时尽力调用清理端口，
 * 失败原因原样返回给表单，因此表单可以保留用户输入并显示后端诊断。
 */
export async function createCharacter(
  input: CharacterCreationInput,
  context: CharacterCreationValidationInput,
  ports: CharacterCreationPorts,
): Promise<CharacterCreationResult> {
  const validation = validateCreateCharacter(input, context)
  if (!validation.valid) {
    return {
      status: 'invalid',
      success: false,
      ok: false,
      validation,
      error: { stage: 'validation', reason: '表单校验失败' },
    }
  }

  const id = input.id.trim()
  const name = input.name.trim() || id
  const prompt = buildCharacterPrompt(name)
  let model: string | undefined
  let imported = false

  if (input.render === 'live2d') {
    const source = normalizeSelection(input.live2dModel ?? input.modelDirectory ?? input.live2dModelDirectory)
    if (!ports.importLive2DModel) {
      return failed(validation, 'live2d-import', '未配置 Live2D 导入端口')
    }
    try {
      model = await ports.importLive2DModel(id, source!.directory)
      imported = true
    } catch (error) {
      // 导入失败时没有写入 character.json/prompt，输入仍可供表单重试。
      return failed(validation, 'live2d-import', error)
    }
  }

  const definition = JSON.stringify(buildNewCharacterDefinition(input, model), null, 2)
  try {
    await ports.files.writeDefinition(id, definition)
  } catch (error) {
    if (imported) await ports.deleteCharacter?.(id).catch(() => undefined)
    return failed(validation, 'definition', error)
  }

  try {
    await ports.files.writePrompt(id, prompt)
  } catch (error) {
    await ports.deleteCharacter?.(id).catch(() => undefined)
    return failed(validation, 'prompt', error)
  }

  try {
    await ports.refreshDisplayData()
  } catch (error) {
    return failed(validation, 'refresh', error)
  }
  try {
    await ports.broadcastCharactersChanged()
  } catch (error) {
    return failed(validation, 'broadcast', error)
  }
  try {
    await ports.enterEditor(id)
  } catch (error) {
    return failed(validation, 'navigate', error)
  }

  return {
    status: 'created',
    success: true,
    ok: true,
    validation,
    character: { id, name, render: input.render, definition, prompt, ...(model ? { model } : {}) },
  }
}

/** 便于组合根按领域动作命名的别名。 */
export const runCharacterCreation = createCharacter

/** 兼容组合根/测试中更直观的命名。 */
export const validateCharacterCreation = validateCreateCharacter
export const createCharacterWorkflow = createCharacter
