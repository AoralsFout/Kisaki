import type { CharacterFilePort } from './characterFilePort'
import type { CharacterImageData, Live2DConfig } from '../../character/loader'
import { characterErrorReason } from './characterError'

/** 外观编辑器可以发出的草稿编辑意图。草稿本身不由外观编辑器持有。 */
export type CharacterAppearanceEditIntent =
  | { type: 'add-pose'; value: string }
  | { type: 'remove-pose'; index: number }
  | { type: 'add-costume'; value: string }
  | { type: 'remove-costume'; index: number }
  | { type: 'set-image-pose'; file: string; pose: string }
  | { type: 'set-image-costume'; file: string; costume: string }
  | { type: 'add-emotion'; file: string; emotion: string }
  | { type: 'remove-emotion'; file: string; index: number }
  | { type: 'add-image'; image: CharacterImageData }
  | { type: 'remove-image'; file: string }
  | { type: 'replace-image'; file: string }
  | { type: 'set-live2d-config'; patch: Partial<Live2DConfig> }

/** 供受控组件使用的只读外观投影。数组和对象都属于父层草稿的投影。 */
export interface CharacterAppearanceProjection {
  readonly images: readonly CharacterImageData[]
  readonly poses: readonly string[]
  readonly costumes: readonly string[]
  readonly live2d?: Readonly<Live2DConfig>
}

export interface AppearanceOperationError {
  step: 'save-image' | 'delete-image' | 'cache'
  reason: string
}

export interface AppearanceOperationResult {
  ok: boolean
  /** 文件已落盘，但后置步骤失败时仍为 true，调用方必须同步草稿。 */
  persisted: boolean
  cacheBusted: boolean
  error?: AppearanceOperationError
}

export interface CharacterAppearanceImagePort {
  saveImage: CharacterFilePort['saveImage']
  deleteImage: CharacterFilePort['deleteImage']
}

export interface CharacterAppearanceImageOperationInput {
  port: CharacterAppearanceImagePort
  characterId: string
  filename: string
  dataBase64: string
  /** 替换时传入旧文件名；相同文件名表示原地覆盖。 */
  previousFilename?: string
  bustImageCache: () => void | Promise<void>
}

async function bustCache(
  bustImageCache: () => void | Promise<void>,
): Promise<{ cacheBusted: boolean; error?: AppearanceOperationError }> {
  try {
    await bustImageCache()
    return { cacheBusted: true }
  } catch (error) {
    return {
      cacheBusted: false,
      error: { step: 'cache', reason: characterErrorReason(error) },
    }
  }
}

/** 上传一张立绘；替换时先写新内容，再删除旧文件，最后击穿图片缓存。 */
export async function saveCharacterAppearanceImage(
  input: CharacterAppearanceImageOperationInput,
): Promise<AppearanceOperationResult> {
  try {
    await input.port.saveImage(input.characterId, input.filename, input.dataBase64)
  } catch (error) {
    return {
      ok: false,
      persisted: false,
      cacheBusted: false,
      error: { step: 'save-image', reason: characterErrorReason(error) },
    }
  }

  let postError: AppearanceOperationError | undefined
  if (input.previousFilename && input.previousFilename !== input.filename) {
    try {
      await input.port.deleteImage(input.characterId, input.previousFilename)
    } catch (error) {
      postError = { step: 'delete-image', reason: characterErrorReason(error) }
    }
  }

  const cacheResult = await bustCache(input.bustImageCache)
  postError ??= cacheResult.error
  return {
    ok: !postError,
    persisted: true,
    cacheBusted: cacheResult.cacheBusted,
    ...(postError ? { error: postError } : {}),
  }
}

export interface DeleteCharacterAppearanceImageInput {
  port: CharacterAppearanceImagePort
  characterId: string
  filename: string
  bustImageCache: () => void | Promise<void>
}

/** 删除一张立绘，并在成功后刷新图片缓存。 */
export async function deleteCharacterAppearanceImage(
  input: DeleteCharacterAppearanceImageInput,
): Promise<AppearanceOperationResult> {
  try {
    await input.port.deleteImage(input.characterId, input.filename)
  } catch (error) {
    return {
      ok: false,
      persisted: false,
      cacheBusted: false,
      error: { step: 'delete-image', reason: characterErrorReason(error) },
    }
  }

  const cacheResult = await bustCache(input.bustImageCache)
  return {
    ok: !cacheResult.error,
    persisted: true,
    cacheBusted: cacheResult.cacheBusted,
    ...(cacheResult.error ? { error: cacheResult.error } : {}),
  }
}

export interface CharacterAppearanceLive2DImportPort {
  importLive2dModel(characterId: string, sourceDir: string): Promise<string>
}

export interface Live2DImportResult {
  ok: boolean
  model?: string
  error?: string
}

/** 调用既有 Live2D 导入命令；错误保持原始原因，供界面明确展示。 */
export async function importCharacterLive2DModel(
  port: CharacterAppearanceLive2DImportPort,
  characterId: string,
  sourceDir: string,
): Promise<Live2DImportResult> {
  if (!sourceDir.trim()) return { ok: false, error: '未选择 Live2D 模型目录' }
  try {
    const model = await port.importLive2dModel(characterId, sourceDir)
    if (!model) return { ok: false, error: '导入命令未返回模型路径' }
    return { ok: true, model }
  } catch (error) {
    return { ok: false, error: characterErrorReason(error) }
  }
}
