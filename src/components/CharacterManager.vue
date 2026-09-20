<script setup lang="ts">
/**
 * 角色管理 - 角色列表 + 编辑器
 */
import { ref, onMounted, onUnmounted, computed, watch, useId } from 'vue'
import UnsavedDialog from './UnsavedDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useI18n } from 'vue-i18n'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from '../character/loader'
import { bustImageCache, initCharacterDataDir } from '../character/loader'
import { buildCharacterJson, type CharacterEdits } from '../character/characterJson'
import {
  loadCosyVoiceConfigSecure,
  isCosyVoiceConfigValid,
  getTtsProvider,
  ttsPlaybackOrchestrator,
} from '../tts'
import { createLogger } from '../utils/logger'
import { invoke } from '@tauri-apps/api/core'
import { save, open } from '@tauri-apps/plugin-dialog'
import { emit } from '@tauri-apps/api/event'

const log = createLogger('CharacterMgr')
import { fetchVoiceList } from '../tts/api'
import type { VoiceInfo } from '../tts/types'
import { SUPPORTED_LANGUAGES } from '../stores/language'
import CharacterList from './CharacterList.vue'
import CharacterPreview from './CharacterPreview.vue'
import Live2DEditor from './Live2DEditor.vue'
import Live2DPreview from './Live2DPreview.vue'
import { loadLive2DManifest } from '../character/live2d/manifest'
import type { Live2DManifest } from '../character/live2d/manifest'
import type { Live2DConfig } from '../character/loader'
import {
  DEFAULT_VOICE_LANGUAGE,
  DEFAULT_TEXT_LANGUAGE,
  STORAGE_TTS_PROVIDER,
} from '../constants'
import { useModalFocus } from '../utils/modalFocus'
import { subscribeSettingsChange } from '../application/settings/settingsChangeStream'
import { emitCharactersChanged } from '../character/editorEvents'
import { chooseCharacterAfterDelete } from '../character/editorSafety'

const charStore = useCharacterStore()
const ttsProvider = ref(getTtsProvider())

// 跨窗口的 TTS 提供者变更经统一配置变更流到达；组件卸载时退订，避免监听器泄漏
let unsubscribeSettings: (() => void) | null = null
onMounted(() => {
  unsubscribeSettings = subscribeSettingsChange(changedKeys => {
    if (changedKeys.includes(STORAGE_TTS_PROVIDER)) ttsProvider.value = getTtsProvider()
  })
})
onUnmounted(() => {
  unsubscribeSettings?.()
  unsubscribeSettings = null
})

const { t } = useI18n()

// ---- 页面状态 ----
type ViewMode = 'list' | 'editor'
const view = ref<ViewMode>('list')
const editingId = ref('')

// ---- 编辑器状态 ----
const promptText = ref('')
const saveMsg = ref('')
const saveError = ref('')
const editFile = ref<string | null>(null)
const editableImages = ref<CharacterImageData[]>([])
const editablePoses = ref<string[]>([])
const editableCostumes = ref<string[]>([])
const editableLive2dConfig = ref<Live2DConfig>({ model: '' })
const live2dManifest = ref<Live2DManifest | null>(null)
const hasChanges = ref(false)
// 基本信息：名称在顶栏编辑，描述在「基本信息」分区
const editingName = ref('')
const editingDesc = ref('')
// 右侧预览可收起，避免固定宽度挤压编辑区
const previewCollapsed = ref(false)

// ---- 创建角色表单 ----
const showCreateForm = ref(false)
const newCharId = ref('')
const newCharName = ref('')
const newCharDesc = ref('')
const newCharRender = ref<'illustration' | 'live2d'>('illustration')
const newCharModelDir = ref('') // Live2D：选中的模型文件夹绝对路径
const createError = ref('')
const createDialogRef = ref<HTMLElement | null>(null)
const createInputRef = ref<HTMLInputElement | null>(null)
const createTitleId = useId()

function resetCreateForm() {
  newCharId.value = ''
  newCharName.value = ''
  newCharDesc.value = ''
  newCharRender.value = 'illustration'
  newCharModelDir.value = ''
  createError.value = ''
}

/** Live2D 创建：选模型文件夹 */
async function pickModelFolder() {
  const picked = await open({ directory: true, multiple: false, title: t('character.mgr.live2d.pickModel') })
  if (typeof picked === 'string') newCharModelDir.value = picked
}

// ---- 行内添加输入 ----
const addingPose = ref(false)
const newPoseName = ref('')
const poseInputRef = ref<HTMLInputElement | null>(null)
const addingCostume = ref(false)
const newCostumeName = ref('')
const costumeInputRef = ref<HTMLInputElement | null>(null)

// ---- 语音合成 ----
const availableVoices = ref<VoiceInfo[]>([])
const loadingVoices = ref(false)
const voiceError = ref('')
const selectedVoice = ref('')
const selectedVoiceModel = ref('')
const selectedVoiceLang = ref(DEFAULT_VOICE_LANGUAGE)
const selectedTextLang = ref(DEFAULT_TEXT_LANGUAGE)

// GPT-SoVITS 角色级覆盖
const gsRefAudio = ref('')
const gsPromptText = ref('')
const gsPromptLang = ref('')

/** 文件选择：参考音频 */
async function pickRefAudio() {
  const picked = await open({
    title: t('character.mgr.gptsovitsPickAudio'),
    multiple: false,
    filters: [{ name: '音频文件', extensions: ['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a'] }],
  })
  if (typeof picked === 'string') {
    gsRefAudio.value = picked
    markChanged()
  }
}

// 音色试听
const voicePreviewing = ref(false)
const voicePreviewText = 'こんにちは、元気ですか？'

async function previewVoice() {
  if (!selectedVoice.value) return
  if (voicePreviewing.value) {
    ttsPlaybackOrchestrator.cancel('preview-cancelled', true)
    voicePreviewing.value = false
    return
  }
  voicePreviewing.value = true
  try {
    await ttsPlaybackOrchestrator.play({
      requestId: `voice-preview:${editingId.value || 'new'}`,
      text: voicePreviewText,
      voiceId: selectedVoice.value,
      voiceLanguage: selectedVoiceLang.value,
      deduplicate: false,
    })
  } catch {
    // 静默
  } finally {
    voicePreviewing.value = false
  }
}

// 行内输入自动聚焦
watch(addingPose, (v) => { if (v) setTimeout(() => poseInputRef.value?.focus(), 50) })
watch(addingCostume, (v) => { if (v) setTimeout(() => costumeInputRef.value?.focus(), 50) })

onMounted(async () => {
  await initCharacterDataDir().catch(() => { /* 浏览器预览环境无原生目录 */ })
  if (charStore.availableList.length === 0) await charStore.refreshList()
})

const displayList = computed(() => charStore.availableList)
const editingImage = computed(() =>
  editableImages.value.find(i => i.file === editFile.value) ?? null
)

/** 当前编辑图片的 URL（带时间戳防缓存） */
const editingImageUrl = computed(() => {
  if (!editingImage.value) return ''
  return charStore.getImageUrl(editingImage.value.file) + `?_t=${Date.now()}`
})

// ---- 文件操作 ----

/** 打开创建角色表单 */
function openCreateForm() {
  resetCreateForm()
  showCreateForm.value = true
}

/** 创建新角色（从表单读取数据） */
async function submitCreateForm() {
  if (saving.value) return
  saving.value = true
  try { await createCharacterFromForm() }
  finally { saving.value = false }
}
async function createCharacterFromForm() {
  const id = newCharId.value.trim()
  const name = newCharName.value.trim() || id
  createError.value = ''

  if (!id) {
    createError.value = t('character.msg.errEnterId')
    return
  }
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    createError.value = t('character.msg.errIdFormat')
    return
  }
  if (charStore.availableList.includes(id)) {
    createError.value = t('character.msg.errCharExists', { id })
    return
  }

  try {
    if (newCharRender.value === 'live2d') {
      if (!newCharModelDir.value) {
        createError.value = t('character.mgr.live2d.errPickModel')
        return
      }
      // 先导入模型（会创建 characters/<id>/live2d/ 并拷贝），返回 model3.json 相对路径
      const modelRel = await invoke<string>('import_live2d_model', { id, srcDir: newCharModelDir.value })
      const json = {
        id, name, description: newCharDesc.value || name, version: 2, prompt: '',
        render: 'live2d',
        live2d: { model: modelRel, scale: 1, mouseFollow: true },
        poses: [], emotions: [], costumes: [], images: [],
        voice: '', voiceModel: '', voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
      }
      await invoke('write_character_file', {
        id, filename: 'character.json', content: JSON.stringify(json, null, 2),
      })
    } else {
      const defaultJson = {
        id, name, description: newCharDesc.value || name, version: 2, prompt: '',
        render: 'illustration',
        poses: ['standing'], emotions: ['idle'],
        costumes: ['default'], images: [],
        voice: '', voiceModel: '',
        voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
      }
      await invoke('write_character_file', {
        id, filename: 'character.json', content: JSON.stringify(defaultJson, null, 2),
      })
    }
    await invoke('write_character_file', {
      id, filename: 'prompt.txt',
      content: `你是 ${name}，一个可爱的桌面宠物。`,
    })

    await charStore.refreshList()
    void emitCharactersChanged(emit)
    showCreateForm.value = false
    await enterEditor(id)
    saveMsg.value = t('character.msg.createdCharacter', { name })
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    createError.value = t('character.msg.errCreateFailed', { msg: e instanceof Error ? e.message : String(e) })
  }
}

/** 进入角色编辑 */
async function enterEditor(id: string) {
  editingId.value = id
  if (!charStore.availableList.includes(id)) return
  await charStore.loadCharacter(id, true)
  await loadData()
  view.value = 'editor'
}

const leaveDialog = ref<InstanceType<typeof UnsavedDialog> | null>(null)
const saving = ref(false)
const dirty = computed(() => hasChanges.value || Boolean(newPoseName.value.trim() || newCostumeName.value.trim()) || (showCreateForm.value && Boolean(newCharId.value || newCharName.value || newCharDesc.value || newCharModelDir.value)))
useModalFocus(
  () => showCreateForm.value,
  createDialogRef,
  () => { if (!saving.value) void closeCreateForm() },
  createInputRef,
)
async function savePage() {
  if (showCreateForm.value) { await submitCreateForm(); return !showCreateForm.value }
  commitNewPose()
  commitNewCostume()
  return saveAll()
}
const editablePage = { get dirty() { return dirty.value }, get saving() { return saving.value }, save: savePage }
defineExpose({ dirty, saving, save: savePage })
async function closeCreateForm() {
  if (await leaveDialog.value?.ask(editablePage)) { showCreateForm.value = false; resetCreateForm() }
}
async function backToList() {
  if (!await leaveDialog.value?.ask(editablePage)) return
  view.value = 'list'
  editingId.value = ''
  editFile.value = null
  hasChanges.value = false
  newPoseName.value = ''
  newCostumeName.value = ''
}

async function loadVoices() {
  const cvConfig = await loadCosyVoiceConfigSecure()
  if (!isCosyVoiceConfigValid(cvConfig)) return
  loadingVoices.value = true
  voiceError.value = ''
  try {
    availableVoices.value = await fetchVoiceList({ apiKey: cvConfig.apiKey })
  } catch {
    // 静默失败，不影响编辑
    availableVoices.value = []
  } finally {
    loadingVoices.value = false
  }
}

async function loadData() {
  await loadPrompt()
  const data = charStore.data
  if (!data) return
  editingName.value = data.name ?? editingId.value
  editingDesc.value = (data as any).description ?? ''
  editableImages.value = JSON.parse(JSON.stringify(data.images))
  editablePoses.value = [...data.poses]
  editableCostumes.value = [...data.costumes]
  selectedVoice.value = data.voice ?? ''
  selectedVoiceModel.value = data.voiceModel ?? ''
  selectedVoiceLang.value = data.voiceLanguage || 'ja-JP'
  selectedTextLang.value = data.textLanguage || 'zh-CN'
  gsRefAudio.value = (data as any).gptsovitsRefAudio ?? ''
  gsPromptText.value = (data as any).gptsovitsPromptText ?? ''
  gsPromptLang.value = (data as any).gptsovitsPromptLang || 'ja-JP'
  editFile.value = null
  if (charStore.render === 'live2d') {
    editableLive2dConfig.value = JSON.parse(JSON.stringify(data.live2d ?? { model: '' }))
    void reloadLive2DManifest()
  }
  hasChanges.value = false
  // 异步加载音色列表
  loadVoices()
}

/** 重新加载 Live2D 清单（依当前可编辑配置的模型；导入新模型后调用） */
async function reloadLive2DManifest() {
  live2dManifest.value = null
  if (charStore.render !== 'live2d' || !editableLive2dConfig.value.model) return
  try {
    live2dManifest.value = await loadLive2DManifest(editingId.value, { live2d: editableLive2dConfig.value })
  } catch (e) {
    log.warn("character_mgr.reload_live2_dmanifest.warn", `加载 Live2D 清单失败: ${(e as Error).message}`, e)
  }
}

/** 编辑器内重新导入 Live2D 模型（选文件夹 → 后端拷贝 → 更新配置 + 重载清单） */
async function handleImportLive2dModel() {
  const picked = await open({ directory: true, multiple: false, title: t('character.mgr.live2d.pickModel') })
  if (typeof picked !== 'string') return
  try {
    const rel = await invoke<string>('import_live2d_model', { id: editingId.value, srcDir: picked })
    editableLive2dConfig.value.model = rel
    await reloadLive2DManifest()
    markChanged()
    saveMsg.value = t('character.mgr.live2d.importedMsg')
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = t('character.mgr.live2d.errImport', { msg: e instanceof Error ? e.message : String(e) })
  }
}

async function loadPrompt() {
  try {
    const text = await invoke('read_character_file', { id: editingId.value, filename: 'prompt.txt' }) as string
    promptText.value = text
  } catch {
    // data_dir 中无 prompt.txt（新角色）
    promptText.value = ''
  }
}

// ---- Tauri 文件 IO ----

async function tauriWrite(filename: string, content: string): Promise<boolean> {
  try {
    await invoke('write_character_file', { id: editingId.value, filename, content })
    return true
  } catch (e) {
    log.error("character_mgr.tauri_write.error", "写入失败", e)
    return false
  }
}

/** 删除整个角色 */
const showDeleteConfirm = ref(false)
const isDeleting = ref(false)

async function deleteCharacter() {
  if (!editingId.value) return
  isDeleting.value = true
  try {
    await invoke('delete_character', { id: editingId.value })
    await charStore.refreshList()
    void emitCharactersChanged(emit)
    // 如果删除的是当前正在使用的角色，刷新 store
    const replacement = chooseCharacterAfterDelete(
      charStore.currentId,
      editingId.value,
      charStore.availableList,
    )
    if (replacement && replacement !== charStore.currentId) {
      await charStore.loadCharacter(replacement, true)
    }
    showDeleteConfirm.value = false
    hasChanges.value = false
    await backToList()
    saveMsg.value = t('character.msg.deletedCharacter')
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = t('character.msg.errDeleteFailed', { msg: (e as Error).message })
  } finally {
    isDeleting.value = false
  }
}

function markChanged() { hasChanges.value = true }

// ---- 标签编辑 ----

function commitNewPose() {
  const p = newPoseName.value.trim()
  if (p && !editablePoses.value.includes(p)) {
    editablePoses.value.push(p)
    markChanged()
  }
  newPoseName.value = ''
  addingPose.value = false
}

function removePose(idx: number) {
  editablePoses.value.splice(idx, 1)
  markChanged()
}

function commitNewCostume() {
  const c = newCostumeName.value.trim()
  if (c && !editableCostumes.value.includes(c)) {
    editableCostumes.value.push(c)
    markChanged()
  }
  newCostumeName.value = ''
  addingCostume.value = false
}

function removeCostume(idx: number) {
  editableCostumes.value.splice(idx, 1)
  markChanged()
}

// ---- 立绘编辑 ----

function addEmotion(file: string, emotion: string) {
  const img = editableImages.value.find(i => i.file === file)
  if (img && !img.emotions.includes(emotion)) {
    img.emotions.push(emotion)
    markChanged()
  }
}

function removeEmotion(file: string, idx: number) {
  const img = editableImages.value.find(i => i.file === file)
  if (img) {
    img.emotions.splice(idx, 1)
    markChanged()
  }
}

function setImagePose(file: string, pose: string) {
  const img = editableImages.value.find(i => i.file === file)
  if (img) {
    img.pose = pose
    markChanged()
  }
}

function setImageCostume(file: string, costume: string) {
  const img = editableImages.value.find(i => i.file === file)
  if (img) {
    img.costume = costume
    markChanged()
  }
}

function deleteImage(file: string) {
  const idx = editableImages.value.findIndex(i => i.file === file)
  if (idx < 0) return
  editableImages.value.splice(idx, 1)
  editFile.value = null
  markChanged()
}

// ---- 上传立绘 ----

const fileInput = ref<HTMLInputElement | null>(null)

function triggerAddImage() {
  fileInput.value?.click()
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length === 0) return

  const images = files.filter(f => f.type.startsWith('image/'))
  if (images.length === 0) { saveError.value = t('character.msg.errSelectImage'); return }

  const defaultPose = editablePoses.value[0] ?? ''
  const defaultCostume = editableCostumes.value[0] ?? ''

  try {
    for (const file of images) {
      const ext = file.name.split('.').pop() || 'png'
      const newName = `${editingId.value}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`
      const base64 = await fileToBase64(file)
      await invoke('save_character_image', {
        id: editingId.value, filename: newName, dataBase64: base64,
      })
      editableImages.value.push({
        file: newName, pose: defaultPose, costume: defaultCostume, emotions: [],
      })
    }
    markChanged()
    saveMsg.value = t('character.msg.addedImages', { n: images.length })
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = t('character.msg.errAddFailed', { msg: (e as Error).message })
  }

  input.value = ''
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ---- 保存 ----

async function saveAll(): Promise<boolean> {
  if (saving.value) return false
  saving.value = true
  try {
    await persistAll()
    return !hasChanges.value && !saveError.value
  } catch (e) {
    saveError.value = t('safety.saveFailed', { message: e instanceof Error ? e.message : String(e) })
    return false
  } finally { saving.value = false }
}

async function persistAll() {
  saveMsg.value = ''
  saveError.value = ''
  const data = charStore.data
  if (!data) return

  const oldFiles = new Set(data.images.map((i: CharacterImageData) => i.file))
  const newFiles = new Set(editableImages.value.map(i => i.file))
  const orphaned = [...oldFiles].filter(f => !newFiles.has(f))

  const promptOk = await tauriWrite('prompt.txt', promptText.value)
  if (!promptOk) { saveError.value = t('character.msg.errSavePrompt'); return }

  const render = charStore.render
  const edits: CharacterEdits = {
    // 名称留空时回退为角色 id（与创建表单一致）；描述空串=清除
    name: editingName.value.trim() || editingId.value,
    description: editingDesc.value,
    voice: selectedVoice.value || undefined,
    voiceModel: selectedVoiceModel.value || undefined,
    voiceLanguage: selectedVoiceLang.value,
    textLanguage: selectedTextLang.value,
    // 不加 `|| undefined`：传原始空串，buildCharacterJson 才能区分「未编辑」(undefined)
    // 与「清空」('')，让用户清空输入框时真正删除该字段（否则会保留旧值，无法清空）
    gptsovitsRefAudio: gsRefAudio.value,
    gptsovitsPromptText: gsPromptText.value,
    gptsovitsPromptLang: gsPromptLang.value,
  }
  if (render === 'illustration') {
    edits.poses = [...editablePoses.value]
    edits.emotions = [...new Set(editableImages.value.flatMap(img => img.emotions))]
    edits.costumes = [...editableCostumes.value]
    edits.images = editableImages.value.map(img => ({
      file: img.file, pose: img.pose, costume: img.costume, emotions: [...img.emotions],
    }))
  } else {
    edits.live2d = editableLive2dConfig.value
  }
  // buildCharacterJson 以 {...data} 起步，保留 render/live2d 及未知字段（修复数据损坏）。
  const newData = buildCharacterJson(data, render, edits)

  const jsonOk = await tauriWrite('character.json', JSON.stringify(newData, null, 2))
  if (!jsonOk) { saveError.value = t('character.msg.errSaveConfig'); return }

  if (orphaned.length > 0) {
    await Promise.all(orphaned.map(f =>
      invoke('delete_character_image', { id: editingId.value, filename: f })
        .catch(() => { log.warn("character_mgr.persist_all.warn", `删除陈旧图片失败: ${f}`, undefined, { f: f }) })
    ))
  }

  await charStore.loadCharacter(editingId.value, true)
  await loadData()
  bustImageCache()  // 递增缓存版本，下次图片请求使用新 URL
  await emitCharactersChanged(emit).catch(() => {}) // 通知主窗口刷新
  saveMsg.value = t('character.msg.saveSuccess')
  hasChanges.value = false
  setTimeout(() => { saveMsg.value = '' }, 3000)
}

// ---- 角色包导入 / 导出 ----

const packBusy = ref(false)

/** 导出当前编辑的角色为 .zip 角色包（dialog 选保存路径 → 后端打包） */
async function exportPack() {
  if (!editingId.value || packBusy.value) return
  packBusy.value = true
  saveMsg.value = ''
  saveError.value = ''
  try {
    const destPath = await save({
      title: t('dialogs.exportPack'),
      defaultPath: `${editingId.value}.zip`,
      filters: [{ name: t('dialogs.packFilterName'), extensions: ['zip'] }],
    })
    if (!destPath) return // 用户取消
    await invoke('export_character_pack', { id: editingId.value, destPath })
    saveMsg.value = t('character.msg.packExported')
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = t('character.msg.errExportFailed', { msg: (e as Error).message })
  } finally {
    packBusy.value = false
  }
}

/** 导入 .zip 角色包（dialog 选文件 → 后端解压，跳过已存在角色） */
async function importPack() {
  if (packBusy.value) return
  packBusy.value = true
  saveMsg.value = ''
  saveError.value = ''
  try {
    const selected = await open({
      title: t('dialogs.importPack'),
      multiple: false,
      filters: [{ name: t('dialogs.packFilterName'), extensions: ['zip'] }],
    })
    if (typeof selected !== 'string') return // 用户取消
    const result = await invoke('import_character_pack', { srcPath: selected }) as { imported: string[]; skipped: string[] }
    await charStore.refreshList()
    bustImageCache()
    void emitCharactersChanged(emit)
    const parts: string[] = []
    if (result.imported.length) parts.push(t('character.msg.imported', { n: result.imported.length }))
    if (result.skipped.length) parts.push(t('character.msg.skipped', { n: result.skipped.length }))
    saveMsg.value = parts.length ? parts.join(' · ') : t('character.msg.nothingToImport')
    setTimeout(() => { saveMsg.value = '' }, 4000)
  } catch (e) {
    saveError.value = t('character.msg.errImportFailed', { msg: (e as Error).message })
  } finally {
    packBusy.value = false
  }
}
</script>

<template>
  <UnsavedDialog ref="leaveDialog" />
  <ConfirmDialog :visible="showDeleteConfirm" :busy="isDeleting"
    :title="t('character.mgr.deleteConfirmTitle')"
    :message="t('character.mgr.deleteConfirmText', { id: editingId })"
    :confirm-label="t('character.mgr.confirmDelete')" danger
    @cancel="showDeleteConfirm = false" @confirm="deleteCharacter" />
  <div class="char-mgr">
    <!-- ===== 角色卡片列表 ===== -->
    <div v-if="view === 'list'">
      <div class="mgr-header mgr-header-row">
        <h2 class="section-title"><i class="fas fa-masks-theater"></i> {{ t('character.mgr.selectTitle') }}</h2>
        <button class="btn-import" :disabled="packBusy" @click="importPack">
          <i class="fas fa-file-import"></i> {{ t('character.mgr.importPack') }}
        </button>
      </div>
      <div class="list-status">
        <span v-if="saveMsg" class="save-msg"><i class="fas fa-check-circle"></i> {{ saveMsg }}</span>
        <span v-if="saveError" class="save-err" role="alert" data-selectable><i class="fas fa-xmark-circle"></i> {{ saveError }}</span>
      </div>

      <!-- 零角色空状态引导 -->
      <div v-if="displayList.length === 0" class="empty-guide">
        <i class="fas fa-masks-theater empty-guide-icon"></i>
        <p class="empty-guide-title">{{ t('character.mgr.emptyTitle') }}</p>
        <p class="empty-guide-hint">{{ t('character.mgr.emptyHint') }}</p>
        <div class="empty-guide-actions">
          <button class="btn-import-lg" :disabled="packBusy" @click="importPack">
            <i class="fas fa-file-import"></i> {{ t('character.mgr.importPack') }}
          </button>
          <button class="btn-create-lg" @click="openCreateForm">
            <i class="fas fa-plus"></i> {{ t('character.mgr.createNew') }}
          </button>
        </div>
      </div>

      <CharacterList
        v-else
        :characters="charStore.characterDisplayList"
        :current-id="charStore.currentId"
        @select="enterEditor"
        @create="openCreateForm"
      />

      <!-- 创建角色模态框 -->
      <Transition name="modal-fade">
        <div v-if="showCreateForm" class="modal-overlay" @click.self="closeCreateForm">
          <section ref="createDialogRef" class="modal-card" role="dialog" aria-modal="true"
            :aria-labelledby="createTitleId" :aria-busy="saving" tabindex="-1">
            <div class="modal-header">
              <h3 :id="createTitleId" class="modal-title"><i class="fas fa-masks-theater"></i> {{ t('character.mgr.createTitle') }}</h3>
              <button class="modal-close" :disabled="saving" :aria-label="t('common.close')" @click="closeCreateForm">✕</button>
            </div>
            <div class="modal-body" :inert="saving">
              <div class="form-group">
                <label class="form-label" for="new-character-id">{{ t('character.mgr.idLabel') }} <span class="label-note">{{ t('character.mgr.idNote') }}</span></label>
                <input
                  ref="createInputRef"
                  id="new-character-id"
                  v-model="newCharId"
                  class="form-input"
                  :placeholder="t('character.mgr.idPlaceholder')"
                  @keydown.enter="submitCreateForm"
                  @keydown.esc="closeCreateForm"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="new-character-name">{{ t('character.mgr.nameLabel') }}</label>
                <input
                  id="new-character-name"
                  v-model="newCharName"
                  class="form-input"
                  :placeholder="t('character.mgr.namePlaceholder')"
                  @keydown.enter="submitCreateForm"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="new-character-desc">{{ t('character.mgr.descLabel') }} <span class="label-note">{{ t('character.mgr.descNote') }}</span></label>
                <input
                  id="new-character-desc"
                  v-model="newCharDesc"
                  class="form-input"
                  :placeholder="t('character.mgr.descPlaceholder')"
                />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('character.mgr.live2d.renderType') }}</label>
                <div class="render-radio">
                  <label><input type="radio" value="illustration" v-model="newCharRender" /> {{ t('character.mgr.live2d.renderIllustration') }}</label>
                  <label><input type="radio" value="live2d" v-model="newCharRender" /> {{ t('character.mgr.live2d.renderLive2d') }}</label>
                </div>
              </div>
              <div v-if="newCharRender === 'live2d'" class="form-group">
                <label class="form-label">{{ t('character.mgr.live2d.model') }}</label>
                <div class="model-pick">
                  <button type="button" class="btn-pick" @click="pickModelFolder">
                    <i class="fas fa-folder-open"></i> {{ t('character.mgr.live2d.pickModel') }}
                  </button>
                  <span class="model-path" data-selectable>{{ newCharModelDir || t('character.mgr.live2d.noFolder') }}</span>
                </div>
              </div>
              <p v-if="createError" class="form-error" role="alert" data-selectable>{{ createError }}</p>
            </div>
            <div class="modal-footer" :inert="saving">
              <button class="btn-cancel" @click="closeCreateForm">{{ t('common.cancel') }}</button>
              <button class="btn-create" @click="submitCreateForm">{{ t('character.mgr.confirmCreate') }}</button>
            </div>
          </section>
        </div>
      </Transition>
    </div>

    <!-- ===== 角色编辑器 ===== -->
    <div v-if="view === 'editor'" class="editor-view" :inert="saving">
      <!-- 左栏 -->
      <div class="editor-left">
        <div class="editor-sticky">
          <div class="editor-topbar">
            <button class="btn-back" @click="backToList">{{ t('common.back') }}</button>
            <!-- 名称固定在顶栏编辑，随保存写入 character.json -->
            <input v-model="editingName" class="editor-name-input" :placeholder="editingId"
              :aria-label="t('character.mgr.nameLabel')" @input="markChanged" />
            <div class="editor-actions">
              <button class="btn-icon-btn" :class="{ active: !previewCollapsed }" :aria-pressed="!previewCollapsed"
                :title="t('character.mgr.previewToggle')" :aria-label="t('character.mgr.previewToggle')"
                @click="previewCollapsed = !previewCollapsed">
                <i class="fas" :class="previewCollapsed ? 'fa-eye' : 'fa-eye-slash'"></i>
              </button>
              <button class="btn-save-top" :class="{ dirty: hasChanges }" @click="saveAll">
                <i v-if="hasChanges" class="fas fa-floppy-disk"></i> {{ saving ? t('safety.saving') : t('character.mgr.saveBtn') }}
              </button>
              <button class="btn-export" :disabled="packBusy" @click="exportPack" :title="t('character.mgr.exportTitle')"
                :aria-label="t('character.mgr.exportTitle')"><i class="fas fa-file-export"></i></button>
              <button class="btn-delete" @click="showDeleteConfirm = true" :title="t('character.mgr.deleteTitle')"
                :aria-label="t('character.mgr.deleteTitle')"><i class="fas fa-trash-can"></i></button>
            </div>
          </div>
          <div class="editor-status">
            <span v-if="saveMsg" class="save-msg">
              <i class="fas fa-check-circle"></i>
              {{ saveMsg }}
            </span>
            <span v-if="saveError" class="save-err" role="alert" data-selectable>
              <i class="fas fa-xmark-circle"></i>
              {{ saveError }}
            </span>
          </div>
        </div>

        <div class="editor-body">
          <!-- ── 基本信息 ── -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-id-badge"></i> {{ t('character.mgr.groupBasic') }}</h3>
            <div class="form-group">
              <label class="lang-label">{{ t('character.mgr.descLabel') }}</label>
              <input v-model="editingDesc" class="form-input" :placeholder="t('character.mgr.descPlaceholder')"
                @input="markChanged" />
            </div>
            <p class="mgr-desc"><i class="fas fa-fingerprint"></i> ID: {{ editingId }}</p>
          </section>

          <!-- ── 人设 ── -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-pencil"></i> {{ t('character.mgr.groupPersona') }}</h3>
            <textarea v-model="promptText" class="mgr-textarea" rows="8" @input="markChanged"></textarea>
          </section>

          <!-- ── 外观与动作 ── -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-images"></i> {{ t('character.mgr.groupAppearance') }}</h3>

            <template v-if="charStore.render === 'illustration'">
            <!-- 姿势 -->
            <div class="mgr-field">
              <div class="mgr-sublabel">{{ t('character.mgr.poses') }}</div>
              <div class="tag-list">
                <button v-for="(p, i) in editablePoses" :key="i" type="button" class="tag-item"
                  @click="removePose(i)" :aria-label="`${t('character.mgr.clickToRemove')}: ${p}`">{{ p }} ✕</button>
                <template v-if="addingPose">
                  <input
                    ref="poseInputRef"
                    v-model="newPoseName"
                    class="tag-input"
                    :placeholder="t('character.mgr.tagInputPlaceholder')"
                    @keydown.enter="commitNewPose"
                    @keydown.esc="addingPose = false"
                    @blur="commitNewPose"
                  />
                </template>
                <button v-else class="tag-add" @click="addingPose = true">{{ t('character.mgr.addTag') }}</button>
              </div>
            </div>

            <!-- 服装 -->
            <div class="mgr-field">
              <div class="mgr-sublabel">{{ t('character.mgr.costumes') }}</div>
              <div class="tag-list">
                <button v-for="(c, i) in editableCostumes" :key="i" type="button" class="tag-item"
                  @click="removeCostume(i)" :aria-label="`${t('character.mgr.clickToRemove')}: ${c}`">{{ c }} ✕</button>
                <template v-if="addingCostume">
                  <input
                    ref="costumeInputRef"
                    v-model="newCostumeName"
                    class="tag-input"
                    :placeholder="t('character.mgr.tagInputPlaceholder')"
                    @keydown.enter="commitNewCostume"
                    @keydown.esc="addingCostume = false"
                    @blur="commitNewCostume"
                  />
                </template>
                <button v-else class="tag-add" @click="addingCostume = true">{{ t('character.mgr.addTag') }}</button>
              </div>
            </div>

            <!-- 立绘 -->
            <div class="mgr-field">
              <div class="mgr-sublabel">{{ t('character.mgr.imagesTitle') }}</div>
              <div class="img-grid">
                <button
                  v-for="img in editableImages"
                  :key="img.file"
                  type="button"
                  :class="['img-card', { selected: editFile === img.file }]"
                  :aria-pressed="editFile === img.file"
                  @click="editFile = img.file"
                >
                  <div class="img-wrap">
                    <img class="img-grid-thumb" :src="charStore.getImageUrl(img.file)" :alt="img.file" />
                  </div>
                  <div class="img-grid-info">
                    <div class="img-grid-name">{{ img.file }}</div>
                    <div class="img-grid-tags">{{ img.pose }} · {{ img.costume }} · {{ img.emotions.join('、') }}</div>
                  </div>
                </button>
                <button type="button" class="img-card img-card-add" @click="triggerAddImage">
                  <div class="img-add-icon">+</div>
                  <div class="img-grid-info">
                    <div class="img-grid-name">{{ t('character.mgr.addImage') }}</div>
                  </div>
                </button>
              </div>
              <input ref="fileInput" type="file" accept="image/*" multiple style="display:none" @change="onFilePicked" />
            </div>
            </template>

          <!-- Live2D 编辑区 -->
          <Live2DEditor
            v-if="charStore.render === 'live2d'"
            :manifest="live2dManifest"
            :config="editableLive2dConfig"
            @change="markChanged"
            @import-model="handleImportLive2dModel"
          />

            </section>

          <!-- ── 语音 ── -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-microphone"></i> {{ t('character.mgr.groupVoice') }}</h3>

            <template v-if="ttsProvider === 'cosyvoice'">
            <div class="mgr-field">
              <div class="mgr-sublabel">{{ t('character.mgr.voiceTitle') }}</div>
              <div class="voice-select-row">
                <select v-model="selectedVoice" class="voice-select" @change="markChanged">
                  <option value="">{{ t('character.mgr.voiceNone') }}</option>
                  <option v-for="v in availableVoices" :key="v.voiceId" :value="v.voiceId">
                    {{ v.voiceId }}
                  </option>
                </select>
                <button class="voice-refresh-btn" :disabled="loadingVoices" @click="loadVoices" :title="t('character.mgr.voiceRefresh')">
                  <span class="sr-only">{{ t('character.mgr.voiceRefresh') }}</span>
                  <i class="fas fa-sync" :class="{ spinning: loadingVoices }"></i>
                </button>
              </div>
              <div v-if="selectedVoice" class="voice-preview-row">
                <button
                  class="voice-preview-btn"
                  :class="{ playing: voicePreviewing }"
                  :disabled="!selectedVoice"
                  @click="previewVoice"
                >
                  <i :class="voicePreviewing ? 'fas fa-stop' : 'fas fa-play'"></i>
                  {{ voicePreviewing ? t('character.mgr.previewStop') : t('character.mgr.preview') }}
                </button>
                <span class="voice-preview-hint">{{ voicePreviewText }}</span>
              </div>
              <p v-if="voiceError" class="voice-hint-error" role="alert" data-selectable>{{ voiceError }}</p>
              <p v-else-if="availableVoices.length === 0" class="voice-hint">
                {{ t('character.mgr.voiceNoneHint') }}
              </p>
              <p v-else-if="selectedVoice" class="voice-hint-ok">
                <i class="fas fa-check-circle"></i> {{ t('character.mgr.voiceSelectedHint') }}
              </p>
            </div>
            </template>

            <template v-if="ttsProvider === 'gptsovits'">
            <div class="mgr-field">
              <div class="mgr-sublabel">GPT-SoVITS</div>
              <p class="mgr-desc">{{ t('character.mgr.gptsovitsDesc') }}</p>

              <div class="form-group gs-field">
                <label class="lang-label">{{ t('character.mgr.gptsovitsRefAudio') }}</label>
                <div class="file-picker-row">
                  <input v-model="gsRefAudio" class="form-input file-picker-input" type="text" readonly
                    :placeholder="t('character.mgr.gptsovitsRefAudioPlaceholder')" @click="pickRefAudio" />
                  <button class="btn-browse" @click="pickRefAudio" :title="t('character.mgr.gptsovitsPickAudio')">
                    <span class="sr-only">{{ t('character.mgr.gptsovitsPickAudio') }}</span>
                    <i class="fas fa-folder-open"></i>
                  </button>
                </div>
              </div>

              <div class="form-group gs-field">
                <label class="lang-label">{{ t('character.mgr.gptsovitsPromptText') }}</label>
                <input v-model="gsPromptText" class="form-input" type="text"
                  :placeholder="t('character.mgr.gptsovitsPromptTextPlaceholder')" @input="markChanged" />
              </div>

              <div class="form-group gs-field">
                <label class="lang-label">{{ t('character.mgr.gptsovitsPromptLang') }}</label>
                <select v-model="gsPromptLang" class="voice-select" @change="markChanged">
                  <option value="ja-JP">日本語</option>
                  <option value="zh-CN">中文</option>
                  <option value="en-US">English</option>
                  <option value="ko-KR">한국어</option>
                </select>
              </div>
            </div>
            </template>

            <div v-if="ttsProvider !== 'none'" class="mgr-field">
              <div class="mgr-sublabel">{{ t('character.mgr.groupVoiceLang') }}</div>
              <div class="lang-row">
                <div class="lang-field">
                  <label class="lang-label">{{ t('character.mgr.ttsLang') }}</label>
                  <select v-model="selectedVoiceLang" class="voice-select" @change="markChanged">
                    <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
                  </select>
                </div>
                <div class="lang-field">
                  <label class="lang-label">{{ t('character.mgr.defaultDisplayLang') }}</label>
                  <select v-model="selectedTextLang" class="voice-select" @change="markChanged">
                    <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
                  </select>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- 右栏：预览（可收起，避免固定宽度挤压编辑区） -->
      <CharacterPreview
        v-if="charStore.render === 'illustration' && !previewCollapsed"
        :image="editingImage"
        :image-url="editingImageUrl"
        :poses="editablePoses"
        :costumes="editableCostumes"
        @update-pose="setImagePose"
        @update-costume="setImageCostume"
        @add-emotion="addEmotion"
        @remove-emotion="removeEmotion"
        @delete="deleteImage"
        @close="editFile = null"
      />
      <div v-else-if="charStore.render === 'live2d' && !previewCollapsed" class="l2d-preview-panel">
        <Live2DPreview :id="editingId" :config="editableLive2dConfig" />
      </div>
    </div>

    <!-- 删除角色确认弹窗 -->
  </div>
</template>

<style scoped>
.char-mgr {
  max-width: 100%;
  height: 100%;
}

.mgr-header {
  margin-bottom: 16px;
}

/* ===== 深色主题覆盖 ===== */
.section-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 4px;
  padding: 16px 16px 0;
  color: var(--c-text);
}

/* ---- 编辑器双栏布局 ---- */
.editor-view {
  display: flex;
  height: 100%;
  gap: 0;
}

.editor-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;
  height: 100%;
  box-sizing: border-box; /* 含 padding，避免 height:100%+padding 溢出导致底部被裁切 */
  scrollbar-width: none;
}
.editor-left::-webkit-scrollbar {
  display: none;
}

/* ---- 固定顶部栏 ---- */
.editor-sticky {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--c-panel);
  padding: 14px 0 12px;
  flex-shrink: 0;
}

.editor-name-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: var(--fs-body);
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text);
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}

.editor-name-input:hover {
  background: var(--c-hover);
}

.editor-name-input:focus {
  border-color: var(--c-brand);
  background: var(--c-control);
  box-shadow: var(--focus-ring);
}

.btn-icon-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-control);
  color: var(--c-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-icon-btn:hover {
  border-color: var(--c-brand);
  color: var(--c-brand);
}

.btn-icon-btn.active {
  border-color: var(--c-brand);
  color: var(--c-brand);
  background: var(--c-brand-soft);
}

.editor-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.editor-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--c-text);
  margin: 0;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-status {
  min-height: 18px;
  margin-top: 2px;
}

.btn-back {
  padding: 5px 14px;
  font-size: 13px;
  border: 1px solid var(--c-border);
  background: var(--c-control);
  color: var(--c-text-secondary);
  border-radius: 8px;
  cursor: pointer;
}

.btn-back:hover {
  border-color: var(--c-brand);
  color: var(--c-brand);
}

.btn-save-top {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: var(--c-brand);
  color: white;
  border-radius: 20px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-save-top:hover {
  opacity: 0.85;
}

.btn-save-top.dirty {
  background: var(--c-ok);
}

.editor-body {
  flex: 1;
  overflow-y: auto;
  padding-top: 12px;
  padding-bottom: 16px;
}

/* 深色滚动条 */
.editor-body::-webkit-scrollbar {
  width: 6px;
}
.editor-body::-webkit-scrollbar-track {
  background: transparent;
}
.editor-body::-webkit-scrollbar-thumb {
  background: var(--c-border);
  border-radius: 3px;
}
.editor-body::-webkit-scrollbar-thumb:hover {
  background: var(--c-border-strong);
}

/* Live2D 预览右栏 */
.l2d-preview-panel {
  width: clamp(240px, 30vw, 340px);
  min-width: 0;
  flex-shrink: 0;
  background: var(--c-bg);
  border-left: 1px solid var(--c-border);
}

/* ---- 角色包导入 / 空状态 ---- */
.mgr-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

@media (max-width: 760px) {
  .editor-left { padding: var(--space-2); }
  .editor-topbar { flex-wrap: wrap; gap: var(--space-2); }
  .editor-name-input { order: 3; flex-basis: 100%; }
  .editor-actions { margin-left: auto; }
  .l2d-preview-panel { width: min(38vw, 240px); }
}

@media (max-height: 520px) {
  .modal-card { max-height: 96vh; }
  .editor-sticky { padding-block: var(--space-1) var(--space-2); }
}
</style>
