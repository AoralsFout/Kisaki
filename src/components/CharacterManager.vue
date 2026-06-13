<script setup lang="ts">
/**
 * 角色管理 - 角色列表 + 编辑器
 */
import { ref, onMounted, computed, watch } from 'vue'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from '../character/loader'
import { bustImageCache } from '../character/loader'
import { loadCosyVoiceConfigSecure, isCosyVoiceConfigValid } from '../tts'
import { createLogger } from '../utils/logger'
import { invoke } from '@tauri-apps/api/core'
import { save, open } from '@tauri-apps/plugin-dialog'
import { emit } from '@tauri-apps/api/event'
import { speakTextStreaming, cancelSpeak } from '../tts/speak'

const log = createLogger('CharacterMgr')
import { fetchVoiceList } from '../tts/api'
import type { VoiceInfo } from '../tts/types'
import { SUPPORTED_LANGUAGES } from '../stores/language'
import CharacterList from './CharacterList.vue'
import CharacterPreview from './CharacterPreview.vue'
import { DEFAULT_VOICE_LANGUAGE, DEFAULT_TEXT_LANGUAGE, EVENT_CHARACTERS_CHANGED } from '../constants'

const charStore = useCharacterStore()

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
const hasChanges = ref(false)

// ---- 创建角色表单 ----
const showCreateForm = ref(false)
const newCharId = ref('')
const newCharName = ref('')
const newCharDesc = ref('')
const createError = ref('')

function resetCreateForm() {
  newCharId.value = ''
  newCharName.value = ''
  newCharDesc.value = ''
  createError.value = ''
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

// 音色试听
const voicePreviewing = ref(false)
const voicePreviewText = 'こんにちは、元気ですか？'

async function previewVoice() {
  if (!selectedVoice.value) return
  if (voicePreviewing.value) {
    cancelSpeak()
    voicePreviewing.value = false
    return
  }
  voicePreviewing.value = true
  try {
    await speakTextStreaming(voicePreviewText, selectedVoice.value)
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
  if (!charStore.data) await charStore.init()
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
  const id = newCharId.value.trim()
  const name = newCharName.value.trim() || id
  createError.value = ''

  if (!id) {
    createError.value = '请输入角色 ID'
    return
  }
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    createError.value = 'ID 必须是小写字母开头，仅含字母数字下划线'
    return
  }
  if (charStore.availableList.includes(id)) {
    createError.value = `角色 "${id}" 已存在`
    return
  }

  try {
    // invoke 已静态导入

    const defaultJson = {
      id, name, description: newCharDesc.value || name, version: 1,
      prompt: '',
      poses: ['standing'], emotions: ['idle'],
      costumes: ['default'], images: [],
      voice: '', voiceModel: '',
      voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
    }
    await invoke('write_character_file', {
      id, filename: 'character.json',
      content: JSON.stringify(defaultJson, null, 2),
    })
    await invoke('write_character_file', {
      id, filename: 'prompt.txt',
      content: `你是 ${name}，一个可爱的桌面宠物。`,
    })

    await charStore.refreshList()
    emit(EVENT_CHARACTERS_CHANGED)
    showCreateForm.value = false
    enterEditor(id)
    saveMsg.value = `已创建角色 "${name}"`
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    createError.value = `创建失败: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** 进入角色编辑 */
async function enterEditor(id: string) {
  editingId.value = id
  if (!charStore.availableList.includes(id)) return
  await charStore.loadCharacter(id, true)
  loadData()
  view.value = 'editor'
}

/** 返回角色列表（有未保存更改时先提醒，再次点击才确认退出） */
const pendingExit = ref(false)

function backToList() {
  if (hasChanges.value && !pendingExit.value) {
    pendingExit.value = true
    saveMsg.value = '有未保存的更改，再次点击「← 返回」确认退出'
    setTimeout(() => { if (!pendingExit.value) return; pendingExit.value = false; saveMsg.value = '' }, 4000)
    return
  }
  pendingExit.value = false
  view.value = 'list'
  editingId.value = ''
  editFile.value = null
  hasChanges.value = false
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

function loadData() {
  loadPrompt()
  const data = charStore.data
  if (!data) return
  editableImages.value = JSON.parse(JSON.stringify(data.images))
  editablePoses.value = [...data.poses]
  editableCostumes.value = [...data.costumes]
  selectedVoice.value = data.voice ?? ''
  selectedVoiceModel.value = data.voiceModel ?? ''
  selectedVoiceLang.value = data.voiceLanguage || 'ja-JP'
  selectedTextLang.value = data.textLanguage || 'zh-CN'
  editFile.value = null
  // 异步加载音色列表
  loadVoices()
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
    log.error('写入失败', e)
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
    emit(EVENT_CHARACTERS_CHANGED)
    // 如果删除的是当前正在使用的角色，刷新 store
    if (charStore.currentId === editingId.value) {
      const list = charStore.availableList
      if (list.length > 0) {
        await charStore.loadCharacter(list[0], true)
      }
    }
    showDeleteConfirm.value = false
    backToList()
    saveMsg.value = `已删除角色`
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = `删除失败: ${(e as Error).message}`
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
  if (images.length === 0) { saveError.value = '请选择图片文件'; return }

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
    saveMsg.value = `已添加 ${images.length} 张立绘`
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = `添加失败: ${(e as Error).message}`
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

async function saveAll() {
  saveMsg.value = ''
  saveError.value = ''
  const data = charStore.data
  if (!data) return

  const oldFiles = new Set(data.images.map((i: CharacterImageData) => i.file))
  const newFiles = new Set(editableImages.value.map(i => i.file))
  const orphaned = [...oldFiles].filter(f => !newFiles.has(f))

  const promptOk = await tauriWrite('prompt.txt', promptText.value)
  if (!promptOk) { saveError.value = '保存提示词失败'; return }

  const collectedEmotions = [...new Set(editableImages.value.flatMap(img => img.emotions))]
  const newData: Record<string, any> = {
    id: data.id, name: data.name, description: data.description, version: data.version,
    poses: [...editablePoses.value],
    emotions: collectedEmotions,
    costumes: [...editableCostumes.value],
    images: editableImages.value.map(img => ({
      file: img.file, pose: img.pose, costume: img.costume, emotions: [...img.emotions],
    })),
  }
  if (selectedVoice.value) {
    newData.voice = selectedVoice.value
    newData.voiceModel = selectedVoiceModel.value || undefined
  }
  newData.voiceLanguage = selectedVoiceLang.value
  newData.textLanguage = selectedTextLang.value

  const jsonOk = await tauriWrite('character.json', JSON.stringify(newData, null, 2))
  if (!jsonOk) { saveError.value = '保存角色配置失败'; return }

  if (orphaned.length > 0) {
    await Promise.all(orphaned.map(f =>
      invoke('delete_character_image', { id: editingId.value, filename: f })
        .catch(() => { log.warn('删除陈旧图片失败: %s', f) })
    ))
  }

  await charStore.loadCharacter(editingId.value, true)
  loadData()
  bustImageCache()  // 递增缓存版本，下次图片请求使用新 URL
  emit(EVENT_CHARACTERS_CHANGED) // 通知主窗口刷新（角色内容已变）
  saveMsg.value = '保存成功！文件已更新'
  hasChanges.value = false
  pendingExit.value = false
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
      title: '导出角色包',
      defaultPath: `${editingId.value}.zip`,
      filters: [{ name: '角色包', extensions: ['zip'] }],
    })
    if (!destPath) return // 用户取消
    await invoke('export_character_pack', { id: editingId.value, destPath })
    saveMsg.value = '角色包已导出'
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = `导出失败: ${(e as Error).message}`
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
      title: '导入角色包',
      multiple: false,
      filters: [{ name: '角色包', extensions: ['zip'] }],
    })
    if (typeof selected !== 'string') return // 用户取消
    const result = await invoke('import_character_pack', { srcPath: selected }) as { imported: string[]; skipped: string[] }
    await charStore.refreshList()
    bustImageCache()
    emit(EVENT_CHARACTERS_CHANGED)
    const parts: string[] = []
    if (result.imported.length) parts.push(`导入 ${result.imported.length} 个角色`)
    if (result.skipped.length) parts.push(`跳过 ${result.skipped.length} 个（已存在）`)
    saveMsg.value = parts.length ? parts.join('，') : '角色包中没有可导入的角色'
    setTimeout(() => { saveMsg.value = '' }, 4000)
  } catch (e) {
    saveError.value = `导入失败: ${(e as Error).message}`
  } finally {
    packBusy.value = false
  }
}
</script>

<template>
  <div class="char-mgr">
    <!-- ===== 角色卡片列表 ===== -->
    <div v-if="view === 'list'">
      <div class="mgr-header mgr-header-row">
        <h2 class="section-title"><i class="fas fa-masks-theater"></i> 选择角色</h2>
        <button class="btn-import" :disabled="packBusy" @click="importPack">
          <i class="fas fa-file-import"></i> 导入角色包
        </button>
      </div>
      <div class="list-status">
        <span v-if="saveMsg" class="save-msg"><i class="fas fa-check-circle"></i> {{ saveMsg }}</span>
        <span v-if="saveError" class="save-err"><i class="fas fa-xmark-circle"></i> {{ saveError }}</span>
      </div>

      <!-- 零角色空状态引导 -->
      <div v-if="displayList.length === 0" class="empty-guide">
        <i class="fas fa-masks-theater empty-guide-icon"></i>
        <p class="empty-guide-title">还没有任何角色</p>
        <p class="empty-guide-hint">导入一个角色包，或新建一个角色开始</p>
        <div class="empty-guide-actions">
          <button class="btn-import-lg" :disabled="packBusy" @click="importPack">
            <i class="fas fa-file-import"></i> 导入角色包
          </button>
          <button class="btn-create-lg" @click="openCreateForm">
            <i class="fas fa-plus"></i> 新建角色
          </button>
        </div>
      </div>

      <CharacterList
        v-else
        :available-list="displayList"
        :current-id="charStore.currentId"
        :get-character-name="charStore.getCharacterName"
        @select="enterEditor"
        @create="openCreateForm"
      />

      <!-- 创建角色模态框 -->
      <Transition name="modal-fade">
        <div v-if="showCreateForm" class="modal-overlay" @click.self="showCreateForm = false">
          <div class="modal-card">
            <div class="modal-header">
              <h3 class="modal-title"><i class="fas fa-masks-theater"></i> 创建新角色</h3>
              <button class="modal-close" @click="showCreateForm = false">✕</button>
            </div>
            <div class="modal-body">
              <div class="form-group">
                <label class="form-label">角色 ID <span class="label-note">（英文小写，如 "new_char"）</span></label>
                <input
                  v-model="newCharId"
                  class="form-input"
                  placeholder="my_character"
                  autofocus
                  @keydown.enter="submitCreateForm"
                  @keydown.esc="showCreateForm = false"
                />
              </div>
              <div class="form-group">
                <label class="form-label">显示名称</label>
                <input
                  v-model="newCharName"
                  class="form-input"
                  placeholder="我的角色（留空则使用 ID）"
                  @keydown.enter="submitCreateForm"
                />
              </div>
              <div class="form-group">
                <label class="form-label">描述 <span class="label-note">（可选）</span></label>
                <input
                  v-model="newCharDesc"
                  class="form-input"
                  placeholder="角色的简短描述"
                />
              </div>
              <p v-if="createError" class="form-error">{{ createError }}</p>
            </div>
            <div class="modal-footer">
              <button class="btn-cancel" @click="showCreateForm = false">取消</button>
              <button class="btn-create" @click="submitCreateForm">确认创建</button>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- ===== 角色编辑器 ===== -->
    <div v-if="view === 'editor'" class="editor-view">
      <!-- 左栏 -->
      <div class="editor-left">
        <div class="editor-sticky">
          <div class="editor-topbar">
            <h2 class="editor-title"><i class="fas fa-masks-theater"></i> {{ editingId.charAt(0).toUpperCase() + editingId.slice(1) }}</h2>
            <div class="editor-actions">
              <button class="btn-back" @click="backToList">← 返回</button>
              <button class="btn-save-top" :class="{ dirty: hasChanges }" @click="saveAll">
                <i v-if="hasChanges" class="fas fa-floppy-disk"></i> 保存
              </button>
              <button class="btn-export" :disabled="packBusy" @click="exportPack" title="导出角色包"><i class="fas fa-file-export"></i></button>
              <button class="btn-delete" @click="showDeleteConfirm = true" title="删除角色"><i class="fas fa-trash-can"></i></button>
            </div>
          </div>
          <div class="editor-status">
            <span v-if="saveMsg" class="save-msg">
              <i class="fas fa-check-circle"></i>
              {{ saveMsg }}
            </span>
            <span v-if="saveError" class="save-err">
              <i class="fas fa-xmark-circle"></i>
              {{ saveError }}
            </span>
          </div>
        </div>

        <div class="editor-body">
          <!-- 提示词 -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-pencil"></i> 提示词</h3>
            <textarea v-model="promptText" class="mgr-textarea" rows="8" @input="markChanged"></textarea>
          </section>

          <!-- 姿势列表 -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-person"></i> 姿势</h3>
            <div class="tag-list">
              <span v-for="(p, i) in editablePoses" :key="i" class="tag-item" @click="removePose(i)" title="点击移除">{{ p }} ✕</span>
              <template v-if="addingPose">
                <input
                  ref="poseInputRef"
                  v-model="newPoseName"
                  class="tag-input"
                  placeholder="输入名称后回车"
                  @keydown.enter="commitNewPose"
                  @keydown.esc="addingPose = false"
                  @blur="commitNewPose"
                />
              </template>
              <button v-else class="tag-add" @click="addingPose = true">+ 添加</button>
            </div>
          </section>

          <!-- 服装列表 -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-shirt"></i> 服装</h3>
            <div class="tag-list">
              <span v-for="(c, i) in editableCostumes" :key="i" class="tag-item" @click="removeCostume(i)" title="点击移除">{{ c }} ✕</span>
              <template v-if="addingCostume">
                <input
                  ref="costumeInputRef"
                  v-model="newCostumeName"
                  class="tag-input"
                  placeholder="输入名称后回车"
                  @keydown.enter="commitNewCostume"
                  @keydown.esc="addingCostume = false"
                  @blur="commitNewCostume"
                />
              </template>
              <button v-else class="tag-add" @click="addingCostume = true">+ 添加</button>
            </div>
          </section>

          <!-- 语音合成音色 -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-microphone"></i> 语音音色</h3>
            <div class="voice-select-row">
              <select v-model="selectedVoice" class="voice-select" @change="markChanged">
                <option value="">不使用语音合成</option>
                <option v-for="v in availableVoices" :key="v.voiceId" :value="v.voiceId">
                  {{ v.voiceId }}
                </option>
              </select>
              <button class="voice-refresh-btn" :disabled="loadingVoices" @click="loadVoices" title="刷新音色列表">
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
                {{ voicePreviewing ? '停止' : '试听' }}
              </button>
              <span class="voice-preview-hint">{{ voicePreviewText }}</span>
            </div>
            <p v-if="voiceError" class="voice-hint-error">{{ voiceError }}</p>
            <p v-else-if="availableVoices.length === 0" class="voice-hint">
              暂无音色，请先在设置中配置 CosyVoice API Key 并获取音色列表
            </p>
            <p v-else-if="selectedVoice" class="voice-hint-ok">
              <i class="fas fa-check-circle"></i> 已选择语音音色
            </p>

            <div class="lang-row">
              <div class="lang-field">
                <label class="lang-label">语音语言（TTS）</label>
                <select v-model="selectedVoiceLang" class="voice-select" @change="markChanged">
                  <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
                </select>
              </div>
              <div class="lang-field">
                <label class="lang-label">默认显示语言</label>
                <select v-model="selectedTextLang" class="voice-select" @change="markChanged">
                  <option v-for="l in SUPPORTED_LANGUAGES" :key="l.value" :value="l.value">{{ l.label }}</option>
                </select>
              </div>
            </div>
          </section>

          <!-- 立绘网格 -->
          <section class="mgr-section">
            <h3 class="mgr-label"><i class="fas fa-image"></i> 立绘</h3>
            <div class="img-grid">
              <div
                v-for="img in editableImages"
                :key="img.file"
                :class="['img-card', { selected: editFile === img.file }]"
                @click="editFile = img.file"
              >
                <div class="img-wrap">
                  <img class="img-grid-thumb" :src="charStore.getImageUrl(img.file)" :alt="img.file" />
                </div>
                <div class="img-grid-info">
                  <div class="img-grid-name">{{ img.file }}</div>
                  <div class="img-grid-tags">{{ img.pose }} · {{ img.costume }} · {{ img.emotions.join('、') }}</div>
                </div>
              </div>
              <div class="img-card img-card-add" @click="triggerAddImage">
                <div class="img-add-icon">+</div>
                <div class="img-grid-info">
                  <div class="img-grid-name">添加立绘</div>
                </div>
              </div>
            </div>
            <input ref="fileInput" type="file" accept="image/*" multiple style="display:none" @change="onFilePicked" />
          </section>
        </div>
      </div>

      <!-- 右栏：立绘预览 -->
      <CharacterPreview
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
    </div>

    <!-- 删除角色确认弹窗 -->
    <Transition name="modal-fade">
      <div v-if="showDeleteConfirm" class="modal-overlay" @click.self="showDeleteConfirm = false">
        <div class="modal-card modal-warn">
          <div class="modal-header">
            <h3 class="modal-title"><i class="fas fa-triangle-exclamation"></i> 确认删除</h3>
            <button class="modal-close" @click="showDeleteConfirm = false">✕</button>
          </div>
          <div class="modal-body">
            <p class="delete-warn-text">
              确定要删除角色 <strong>{{ editingId }}</strong> 吗？<br />
              此操作会删除该角色的所有立绘、提示词和配置，<strong>不可恢复</strong>。
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn-cancel" @click="showDeleteConfirm = false">取消</button>
            <button class="btn-delete-confirm" :disabled="isDeleting" @click="deleteCharacter">
              {{ isDeleting ? '删除中...' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
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
  color: #e0e0e0;
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
  background: #1a1a2e;
  padding: 14px 0 12px;
  flex-shrink: 0;
}

.editor-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.editor-title {
  font-size: 18px;
  font-weight: 700;
  color: #e0e0e0;
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
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 8px;
  cursor: pointer;
}

.btn-back:hover {
  border-color: #4a7aff;
  color: #4a7aff;
}

.btn-save-top {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #4a7aff;
  color: white;
  border-radius: 20px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-save-top:hover {
  opacity: 0.85;
}

.btn-save-top.dirty {
  background: #30b94e;
}

.save-msg {
  font-size: 12px;
  color: #30b94e;
}

.save-err {
  font-size: 12px;
  color: #ef5350;
}

.editor-body {
  flex: 1;
  overflow-y: auto;
  padding-top: 12px;
}

/* 深色滚动条 */
.editor-body::-webkit-scrollbar {
  width: 6px;
}
.editor-body::-webkit-scrollbar-track {
  background: transparent;
}
.editor-body::-webkit-scrollbar-thumb {
  background: #2a2a4a;
  border-radius: 3px;
}
.editor-body::-webkit-scrollbar-thumb:hover {
  background: #3a3a5a;
}

/* ---- 立绘 Grid ---- */
.img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.img-card {
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.12s;
}

.img-card:hover {
  border-color: #4a7aff;
}

.img-card.selected {
  border-color: #4a7aff;
  box-shadow: 0 0 0 2px rgba(74, 122, 255, 0.2);
}

.img-wrap {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  height: 100px;
  background: #1e1e38;
  overflow: hidden;
}

.img-grid-thumb {
  min-width: 100%;
  min-height: 100%;
  object-fit: cover;
}

.img-grid-info {
  padding: 5px 7px;
}

.img-grid-name {
  font-size: 10px;
  font-family: monospace;
  color: #aaa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.img-card-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: 2px dashed #2a2a4a;
  background: #1a1a2e;
  min-height: 140px;
  transition: border-color 0.12s, background 0.12s;
}
.img-card-add:hover {
  border-color: #4a7aff;
  background: rgba(74, 122, 255, 0.08);
}

.img-add-icon {
  font-size: 32px;
  color: #666;
  line-height: 1;
  margin-top: 12px;
}

.img-grid-tags {
  font-size: 10px;
  color: #777;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

/* ---- 表单 ---- */
.mgr-section {
  margin-bottom: 20px;
}

.mgr-label {
  font-size: 13px;
  font-weight: 600;
  color: #aaa;
  margin: 0 0 8px;
}

.mgr-textarea {
  width: 100%;
  min-height: 140px;
  padding: 12px;
  font-size: 13px;
  font-family: monospace;
  border: 1px solid #2a2a4a;
  border-radius: 10px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  box-sizing: border-box;
  resize: vertical;
  line-height: 1.5;
}

.mgr-textarea:focus {
  border-color: #4a7aff;
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

/* textarea 深色滚动条 */
.mgr-textarea::-webkit-scrollbar {
  width: 6px;
}
.mgr-textarea::-webkit-scrollbar-track {
  background: transparent;
}
.mgr-textarea::-webkit-scrollbar-thumb {
  background: #2a2a4a;
  border-radius: 3px;
}
.mgr-textarea::-webkit-scrollbar-thumb:hover {
  background: #3a3a5a;
}

/* textarea 右下角调整柄深色 */
.mgr-textarea::-webkit-resizer {
  background: #2a2a4a;
  border-radius: 0 0 10px 0;
}

/* 标签列表 */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.tag-item {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  cursor: pointer;
  transition: all 0.12s;
}

.tag-item:hover {
  border-color: #ef5350;
  color: #ef5350;
  background: rgba(239, 83, 80, 0.1);
}

.tag-add {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px dashed #555;
  background: none;
  color: #777;
  border-radius: 14px;
  cursor: pointer;
}

.tag-add:hover {
  border-color: #4a7aff;
  color: #4a7aff;
}

/* ---- 行内标签输入 ---- */
.tag-input {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid #4a7aff;
  border-radius: 14px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  font-family: inherit;
  min-width: 120px;
  transition: border-color 0.15s;
}

.tag-input:focus {
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

/* ---- 创建角色模态框 ---- */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(4px);
}

.modal-card {
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 16px;
  width: 420px;
  max-width: 90vw;
  box-shadow: 0 16px 64px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 20px 0;
}

.modal-title {
  font-size: 16px;
  font-weight: 700;
  color: #e0e0e0;
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  font-size: 18px;
  color: #666;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 6px;
}

.modal-close:hover {
  background: #2a2a4a;
  color: #ddd;
}

.modal-body {
  padding: 16px 20px;
}

.modal-body .form-group {
  margin-bottom: 14px;
}

.modal-body .form-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #aaa;
  margin-bottom: 5px;
}

.modal-body .label-note {
  font-weight: 400;
  color: #777;
}

.modal-body .form-input {
  width: 100%;
  padding: 9px 12px;
  font-size: 14px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s;
}

.modal-body .form-input:focus {
  border-color: #4a7aff;
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

.form-error {
  font-size: 13px;
  color: #ef5350;
  margin: 0;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 20px 18px;
}

.btn-cancel {
  padding: 8px 18px;
  font-size: 13px;
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
  border-radius: 8px;
  cursor: pointer;
}

.btn-cancel:hover {
  border-color: #555;
  color: #ddd;
}

.btn-create {
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #4a7aff;
  color: white;
  border-radius: 8px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-create:hover {
  opacity: 0.85;
}

/* ---- 模态切换动画 ---- */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: all 0.2s ease;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.modal-fade-enter-from .modal-card,
.modal-fade-leave-to .modal-card {
  transform: scale(0.95);
}

/* ---- 角色包导入 / 空状态 ---- */
.mgr-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.btn-import {
  margin: 16px 16px 0 0;
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid #4a7aff;
  background: rgba(74, 122, 255, 0.12);
  color: #6f9bff;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-import:hover:not(:disabled) {
  background: rgba(74, 122, 255, 0.22);
}
.btn-import:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.list-status {
  min-height: 16px;
  padding: 4px 16px 0;
}

.empty-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 16px;
  text-align: center;
}
.empty-guide-icon {
  font-size: 48px;
  color: #3a3a5a;
  margin-bottom: 16px;
}
.empty-guide-title {
  font-size: 16px;
  font-weight: 600;
  color: #ccc;
  margin: 0 0 6px;
}
.empty-guide-hint {
  font-size: 13px;
  color: #777;
  margin: 0 0 20px;
}
.empty-guide-actions {
  display: flex;
  gap: 12px;
}
.btn-import-lg,
.btn-create-lg {
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-import-lg {
  border: none;
  background: #4a7aff;
  color: white;
}
.btn-import-lg:hover:not(:disabled) {
  opacity: 0.85;
}
.btn-import-lg:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-create-lg {
  border: 1px solid #2a2a4a;
  background: #1e1e38;
  color: #aaa;
}
.btn-create-lg:hover {
  border-color: #4a7aff;
  color: #ccc;
}

/* ---- 导出角色包按钮 ---- */
.btn-export {
  background: none;
  border: none;
  font-size: 16px;
  color: #aaa;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  opacity: 0.6;
  transition: all 0.15s;
}
.btn-export:hover:not(:disabled) {
  opacity: 1;
  background: rgba(74, 122, 255, 0.15);
  color: #6f9bff;
}
.btn-export:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* ---- 删除按钮 ---- */
.btn-delete {
  background: none;
  border: none;
  font-size: 16px;
  color: #aaa;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  opacity: 0.6;
  transition: all 0.15s;
}

.btn-delete:hover {
  opacity: 1;
  background: rgba(239, 83, 80, 0.15);
}

.btn-delete-confirm {
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #ef5350;
  color: white;
  border-radius: 8px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-delete-confirm:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-delete-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-warn-text {
  font-size: 14px;
  line-height: 1.7;
  color: #aaa;
  margin: 0;
}

.delete-warn-text strong {
  color: #e0e0e0;
}

.modal-warn {
  border-top: 3px solid #ef5350;
}

/* ---- 语音音色选择 ---- */
.voice-select-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.voice-select {
  flex: 1;
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #1e1e38;
  color: #e0e0e0;
  outline: none;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
}

.voice-select:focus {
  border-color: #4a7aff;
  box-shadow: 0 0 0 3px rgba(74, 122, 255, 0.15);
}

.voice-refresh-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #1e1e38;
  color: #888;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.voice-refresh-btn:hover:not(:disabled) {
  border-color: #4a7aff;
  color: #4a7aff;
}

.voice-refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-hint {
  font-size: 11px;
  color: #999;
  margin: 6px 0 0;
}

.voice-hint-ok {
  font-size: 11px;
  color: #30b94e;
  margin: 6px 0 0;
}

.voice-hint-error {
  font-size: 11px;
  color: #d00;
  margin: 6px 0 0;
}

/* ---- 语音/显示语言选择 ---- */
.lang-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.lang-field {
  flex: 1;
  min-width: 0;
}

.lang-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #777;
  margin-bottom: 4px;
}

/* ---- 音色试听 ---- */
.voice-preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.voice-preview-btn {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid #30b94e;
  background: transparent;
  color: #30b94e;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.voice-preview-btn:hover:not(:disabled) {
  background: #30b94e;
  color: #1a1a2e;
}

.voice-preview-btn.playing {
  background: #ff4444;
  border-color: #ff4444;
  color: white;
}

.voice-preview-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.voice-preview-hint {
  font-size: 11px;
  color: #aaa;
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
