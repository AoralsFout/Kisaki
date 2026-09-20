import type { CharacterAppearanceEditIntent } from './characterAppearance'
import type { CharacterSaveRequest, CharacterSaveResult } from './characterSaveWorkflow'
import type { CharacterVoiceDraftField } from './characterVoiceEditor'
import { buildCharacterJson, type CharacterEdits } from '../../character/characterJson'
import type { CharacterData, CharacterImageData, Live2DConfig, RenderKind } from '../../character/loader'

/** 草稿同步层对外暴露的完整只读投影。数组和 Live2D 配置均属于投影的一部分。 */
export interface CharacterDraftProjection {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly version: number
  readonly render: RenderKind
  readonly poses: readonly string[]
  readonly emotions: readonly string[]
  readonly costumes: readonly string[]
  readonly images: readonly CharacterImageData[]
  readonly live2d?: Readonly<Live2DConfig>
  readonly voice: string
  readonly voiceModel: string
  readonly voiceLanguage: string
  readonly textLanguage: string
  readonly gptsovitsRefAudio: string
  readonly gptsovitsPromptText: string
  readonly gptsovitsPromptLang: string
}

export interface CharacterDraftLoadInput {
  /** 角色数据通常已经由 loader 合并了 prompt.txt；prompt 参数用于覆盖或补充它。 */
  data: CharacterData
  prompt?: string
  render?: RenderKind
}

export type CharacterDraftEditCommand =
  | { type: 'set-prompt'; value: string }
  | { type: 'set-name'; value: string }
  | { type: 'set-description'; value: string }
  | { type: 'set-render'; value: RenderKind }
  | { type: 'set-voice'; field: CharacterVoiceDraftField; value: string }
  | { type: 'appearance'; intent: CharacterAppearanceEditIntent }
  | { type: 'set-live2d-config'; patch: Partial<Live2DConfig> }

export interface CharacterDraftSyncError {
  type: 'save-failed' | 'save-threw' | 'save-busy' | 'not-loaded'
  message: string
  diagnostics?: CharacterSaveResult['diagnostics']
  result?: CharacterSaveResult
}

export interface CharacterDraftSyncOptions {
  /** #45 的保存工作流适配器；同步层不直接依赖 Tauri。 */
  save: (request: CharacterSaveRequest) => Promise<CharacterSaveResult>
}

export interface CharacterDraftSync {
  readonly projection: Readonly<CharacterDraftProjection> | null
  readonly dirty: boolean
  readonly saving: boolean
  readonly error: CharacterDraftSyncError | null
  readonly lastResult: CharacterSaveResult | null
  load(input: CharacterDraftLoadInput | CharacterData, prompt?: string): void
  edit(command: CharacterDraftEditCommand): boolean
  setPrompt(value: string): boolean
  setName(value: string): boolean
  setDescription(value: string): boolean
  setRender(value: RenderKind): boolean
  setVoice(field: CharacterVoiceDraftField, value: string): boolean
  applyAppearance(intent: CharacterAppearanceEditIntent): boolean
  save(): Promise<boolean>
  reset(): boolean
}

interface InternalState {
  /** 最近一次成功提交的文件基础；未知字段必须一直从这里传给 #45。 */
  baseData: CharacterData
  draft: MutableDraft
  baseline: string
}

interface MutableDraft {
  id: string
  name: string
  description: string
  prompt: string
  version: number
  render: RenderKind
  poses: string[]
  emotions: string[]
  costumes: string[]
  images: CharacterImageData[]
  live2d?: Live2DConfig
  voice: string
  voiceModel: string
  voiceLanguage: string
  textLanguage: string
  gptsovitsRefAudio: string
  gptsovitsPromptText: string
  gptsovitsPromptLang: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function reasonFrom(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    const serialized = JSON.stringify(error)
    return serialized === undefined ? String(error) : serialized
  } catch {
    return String(error)
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value)
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  return value
}

function defaultRender(data: CharacterData, render?: RenderKind): RenderKind {
  return render ?? data.render ?? 'illustration'
}

function projectionFromData(data: CharacterData, prompt: string, render?: RenderKind): MutableDraft {
  const resolvedRender = defaultRender(data, render)
  return {
    id: data.id,
    name: data.name || data.id,
    description: data.description ?? '',
    prompt,
    version: data.version ?? 2,
    render: resolvedRender,
    poses: clone(data.poses ?? ['standing']),
    emotions: clone(data.emotions ?? ['idle']),
    costumes: clone(data.costumes ?? ['default']),
    images: clone(data.images ?? []),
    live2d: data.live2d ? clone(data.live2d) : undefined,
    voice: data.voice ?? '',
    voiceModel: data.voiceModel ?? '',
    voiceLanguage: data.voiceLanguage ?? 'ja-JP',
    textLanguage: data.textLanguage ?? 'zh-CN',
    gptsovitsRefAudio: data.gptsovitsRefAudio ?? '',
    gptsovitsPromptText: data.gptsovitsPromptText ?? '',
    gptsovitsPromptLang: data.gptsovitsPromptLang ?? 'ja-JP',
  }
}

function editsFromProjection(draft: Readonly<CharacterDraftProjection>): CharacterEdits {
  return {
    name: draft.name,
    description: draft.description,
    voice: draft.voice,
    voiceModel: draft.voiceModel,
    voiceLanguage: draft.voiceLanguage,
    textLanguage: draft.textLanguage,
    gptsovitsRefAudio: draft.gptsovitsRefAudio,
    gptsovitsPromptText: draft.gptsovitsPromptText,
    gptsovitsPromptLang: draft.gptsovitsPromptLang,
    poses: Array.from(draft.poses),
    emotions: Array.from(draft.emotions),
    costumes: Array.from(draft.costumes),
    images: draft.images.map(image => clone(image)),
    live2d: draft.live2d ? clone(draft.live2d) : undefined,
  }
}

function committedData(
  request: CharacterSaveRequest,
  result: CharacterSaveResult,
): CharacterData {
  let definition: Record<string, unknown>
  if (result.definition) {
    try {
      definition = JSON.parse(result.definition) as Record<string, unknown>
    } catch {
      definition = buildCharacterJson(request.data, request.render, request.edits)
    }
  } else {
    definition = buildCharacterJson(request.data, request.render, request.edits)
  }
  return {
    ...clone(request.data),
    ...definition,
    id: request.characterId,
    prompt: request.prompt,
  } as CharacterData
}

function applyAppearance(draft: MutableDraft, intent: CharacterAppearanceEditIntent): MutableDraft {
  const next = clone(draft)
  switch (intent.type) {
    case 'add-pose':
      if (!next.poses.includes(intent.value)) next.poses.push(intent.value)
      break
    case 'remove-pose':
      if (intent.index >= 0 && intent.index < next.poses.length) next.poses.splice(intent.index, 1)
      break
    case 'add-costume':
      if (!next.costumes.includes(intent.value)) next.costumes.push(intent.value)
      break
    case 'remove-costume':
      if (intent.index >= 0 && intent.index < next.costumes.length) next.costumes.splice(intent.index, 1)
      break
    case 'set-image-pose':
      next.images = next.images.map(image => image.file === intent.file ? { ...image, pose: intent.pose } : image)
      break
    case 'set-image-costume':
      next.images = next.images.map(image => image.file === intent.file ? { ...image, costume: intent.costume } : image)
      break
    case 'add-emotion':
      next.images = next.images.map(image => image.file === intent.file && !image.emotions.includes(intent.emotion)
        ? { ...image, emotions: [...image.emotions, intent.emotion] }
        : image)
      break
    case 'remove-emotion':
      next.images = next.images.map(image => {
        if (image.file !== intent.file || intent.index < 0 || intent.index >= image.emotions.length) return image
        return { ...image, emotions: image.emotions.filter((_emotion, index) => index !== intent.index) }
      })
      break
    case 'add-image':
      if (!next.images.some(image => image.file === intent.image.file)) next.images.push(clone(intent.image))
      break
    case 'remove-image':
      next.images = next.images.filter(image => image.file !== intent.file)
      break
    case 'replace-image':
      // 文件端口已用同一文件名替换内容；元数据没有变化，不能伪造一条草稿修改。
      break
    case 'set-live2d-config':
      next.live2d = { ...(next.live2d ?? {}), ...clone(intent.patch) } as Live2DConfig
      break
  }
  return next
}

function applyCommand(draft: MutableDraft, command: CharacterDraftEditCommand): MutableDraft {
  switch (command.type) {
    case 'set-prompt': return { ...draft, prompt: command.value }
    case 'set-name': return { ...draft, name: command.value }
    case 'set-description': return { ...draft, description: command.value }
    case 'set-render': return { ...draft, render: command.value }
    case 'set-voice': return { ...draft, [command.field]: command.value }
    case 'appearance': return applyAppearance(draft, command.intent)
    case 'set-live2d-config':
      return { ...draft, live2d: { ...(draft.live2d ?? {}), ...clone(command.patch) } as Live2DConfig }
  }
}

/**
 * 角色编辑草稿的唯一可变状态 Owner。
 *
 * 组件只能拿到 projection 并发送编辑意图；保存时捕获一次快照，
 * 保存期间发生的新编辑不会被成功结果错误地标记为已保存。
 */
export function createCharacterDraftSync(options: CharacterDraftSyncOptions): CharacterDraftSync {
  let state: InternalState | null = null
  let savingState = false
  let errorState: CharacterDraftSyncError | null = null
  let lastResultState: CharacterSaveResult | null = null
  let revision = 0

  function readProjection(): Readonly<CharacterDraftProjection> | null {
    return state ? freezeDeep(clone(state.draft)) : null
  }

  function load(input: CharacterDraftLoadInput | CharacterData, prompt?: string): void {
    const normalized = 'data' in input ? input : { data: input, prompt }
    const data = clone(normalized.data)
    const draft = projectionFromData(data, normalized.prompt ?? data.prompt ?? '', normalized.render)
    state = { baseData: data, draft, baseline: serialize(draft) }
    revision++
    errorState = null
    lastResultState = null
  }

  function edit(command: CharacterDraftEditCommand): boolean {
    if (!state) {
      errorState = { type: 'not-loaded', message: '尚未载入角色草稿' }
      return false
    }
    const before = serialize(state.draft)
    const next = applyCommand(state.draft, command)
    state = { ...state, draft: next }
    revision++
    if (serialize(next) !== before) errorState = null
    return serialize(next) !== before
  }

  function setPrompt(value: string) { return edit({ type: 'set-prompt', value }) }
  function setName(value: string) { return edit({ type: 'set-name', value }) }
  function setDescription(value: string) { return edit({ type: 'set-description', value }) }
  function setRender(value: RenderKind) { return edit({ type: 'set-render', value }) }
  function setVoice(field: CharacterVoiceDraftField, value: string) { return edit({ type: 'set-voice', field, value }) }
  function applyAppearance(intent: CharacterAppearanceEditIntent) { return edit({ type: 'appearance', intent }) }

  async function save(): Promise<boolean> {
    if (savingState) {
      errorState = { type: 'save-busy', message: '角色保存正在进行中' }
      return false
    }
    const current = state
    if (!current) {
      errorState = { type: 'not-loaded', message: '尚未载入角色草稿' }
      return false
    }

    const snapshot = clone(current.draft)
    const snapshotRevision = revision
    const request: CharacterSaveRequest = {
      characterId: snapshot.id,
      data: clone(current.baseData),
      render: snapshot.render,
      edits: editsFromProjection(snapshot),
      prompt: snapshot.prompt,
    }
    savingState = true
    errorState = null
    lastResultState = null
    try {
      const result = await options.save(request)
      lastResultState = result
      if (!result.success || result.status !== 'saved') {
        errorState = {
          type: 'save-failed',
          message: result.diagnostics[0]?.reason ?? '角色保存失败',
          diagnostics: result.diagnostics,
          result,
        }
        return false
      }

      // 只更新成功提交快照对应的基础；不从磁盘重读，也不覆盖保存期间的新编辑。
      const latest = state
      if (latest && latest.draft.id === snapshot.id) {
        state = {
          baseData: committedData(request, result),
          draft: latest.draft,
          baseline: serialize(snapshot),
        }
        // revision 变化意味着保存期间有新编辑；draft 保持原样，因此 dirty 仍为 true。
        if (revision === snapshotRevision) state = { ...state, draft: snapshot }
      }
      return true
    } catch (cause) {
      const message = reasonFrom(cause)
      errorState = { type: 'save-threw', message }
      return false
    } finally {
      savingState = false
    }
  }

  function reset(): boolean {
    if (!state) return false
    const restored = clone(JSON.parse(state.baseline) as MutableDraft)
    state = { ...state, draft: restored }
    revision++
    errorState = null
    return true
  }

  return {
    get projection() { return readProjection() },
    get dirty() {
      const current = readProjection()
      return current !== null && state !== null && serialize(current) !== state.baseline
    },
    get saving() { return savingState },
    get error() { return errorState },
    get lastResult() { return lastResultState },
    load, edit, setPrompt, setName, setDescription, setRender, setVoice, applyAppearance, save, reset,
  }
}

/** composable 命名别名，便于 Vue 组合根按现有约定接入。 */
export const useCharacterDraftSync = createCharacterDraftSync
