<script setup lang="ts">
/**
 * 角色管理 - 角色列表 + 编辑器
 */
import { ref, onMounted, computed } from 'vue'
import { useCharacterStore } from '../stores/character'
import type { CharacterImageData } from '../character/loader'

const charStore = useCharacterStore()

// ---- 页面状态 ----
type ViewMode = 'list' | 'editor'
const view = ref<ViewMode>('list')
const editingId = ref('')

// ---- 编辑器状态 ----
const promptText = ref('')
const saveMsg = ref('')
const saveError = ref('')
const editIndex = ref<number | null>(null)
const emotionInputs = ref<Record<number, string>>({})
const editableImages = ref<CharacterImageData[]>([])
const editablePoses = ref<string[]>([])
const editableCostumes = ref<string[]>([])
const hasChanges = ref(false)

onMounted(async () => {
  if (!charStore.data) await charStore.init()
})

const displayList = computed(() => charStore.availableList)

/** 创建新角色 */
async function createCharacter() {
  const id = prompt('角色 ID（英文小写，如 "new_char"）:')
  if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) {
    saveError.value = 'ID 必须是小写字母开头，仅含字母数字下划线'
    setTimeout(() => { saveError.value = '' }, 3000)
    return
  }
  const name = prompt('角色显示名称（如 "新角色"）:') || id
  if (charStore.availableList.includes(id)) {
    saveError.value = `角色 "${id}" 已存在`
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')

    // 创建默认 character.json
    const defaultJson = {
      id, name, description: name, version: 1,
      prompt: '',
      poses: ['standing'], emotions: ['idle'],
      costumes: ['default'], images: [],
    }
    await invoke('write_character_file', {
      id, filename: 'character.json',
      content: JSON.stringify(defaultJson, null, 2),
    })
    // 创建默认 prompt.txt
    await invoke('write_character_file', {
      id, filename: 'prompt.txt',
      content: `你是 ${name}，一个可爱的桌面宠物。`,
    })
    // 创建 images 目录（通过写入一个空标记文件来确保目录存在）
    await invoke('write_character_file', {
      id, filename: 'images/.gitkeep',
      content: '',
    })

    // 刷新列表并进入编辑
    await charStore.refreshList()
    enterEditor(id)
    saveMsg.value = `✅ 已创建角色 "${name}"`
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = `❌ 创建失败: ${(e as Error).message}`
  }
}

/** 从卡片列表进入角色编辑 */
async function enterEditor(id: string) {
  editingId.value = id
  if (!charStore.availableList.includes(id)) return
  await charStore.loadCharacter(id, true)
  loadData()
  view.value = 'editor'
}

/** 返回角色列表 */
function backToList() {
  view.value = 'list'
  editingId.value = ''
  hasChanges.value = false
}

function loadData() {
  loadPrompt()
  const data = charStore.data
  if (!data) return
  editableImages.value = JSON.parse(JSON.stringify(data.images))
  editablePoses.value = [...data.poses]
  editableCostumes.value = [...data.costumes]
  editIndex.value = null
  emotionInputs.value = {}
}

async function loadPrompt() {
  try {
    const res = await fetch(`/character/${editingId.value}/prompt.txt?_t=${Date.now()}`)
    if (res.ok) promptText.value = await res.text()
  } catch { }
}

// ---- Tauri 写文件 ----
async function tauriWrite(filename: string, content: string) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_character_file', {
      id: editingId.value,
      filename,
      content,
    })
    return true
  } catch (e) {
    console.error('写入失败:', e)
    return false
  }
}

function markChanged() { hasChanges.value = true }

// ---- 编辑姿势列表 ----
function addPose() {
  const p = prompt('输入新姿势名称:')
  if (p && !editablePoses.value.includes(p)) {
    editablePoses.value.push(p)
    markChanged()
  }
}
function removePose(idx: number) {
  editablePoses.value.splice(idx, 1)
  markChanged()
}

// ---- 编辑服装列表 ----
function addCostume() {
  const c = prompt('输入新服装名称:')
  if (c && !editableCostumes.value.includes(c)) {
    editableCostumes.value.push(c)
    markChanged()
  }
}
function removeCostume(idx: number) {
  editableCostumes.value.splice(idx, 1)
  markChanged()
}

// ---- 编辑图片标签 ----
function startEdit(idx: number) {
  editIndex.value = editIndex.value === idx ? null : idx
}

function onEmotionKeydown(idx: number, e: KeyboardEvent) {
  if (e.key === ' ') {
    e.preventDefault()
    const val = emotionInputs.value[idx]?.trim()
    if (!val) return
    const img = editableImages.value[idx]
    if (img && !img.emotions.includes(val)) {
      img.emotions.push(val)
      markChanged()
    }
    emotionInputs.value[idx] = ''
  }
}

function removeEmotion(imgIdx: number, emIdx: number) {
  editableImages.value[imgIdx].emotions.splice(emIdx, 1)
  markChanged()
}

function setImagePose(idx: number, pose: string) {
  editableImages.value[idx].pose = pose
  markChanged()
}

function deleteImage(idx: number) {
  if (idx < 0 || idx >= editableImages.value.length) return
  editableImages.value.splice(idx, 1)
  editIndex.value = null
  markChanged()
}

function setImageCostume(idx: number, costume: string) {
  editableImages.value[idx].costume = costume
  markChanged()
}

// ---- 新增立绘 ----
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

  const { invoke } = await import('@tauri-apps/api/core')
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
    const count = images.length
    saveMsg.value = `✅ 已添加 ${count} 张立绘`
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (e) {
    saveError.value = `❌ 添加失败: ${(e as Error).message}`
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

  // 0. 记录旧图片文件列表（用于清理已删除的）
  const oldFiles = new Set(data.images.map((i: CharacterImageData) => i.file))
  const newFiles = new Set(editableImages.value.map(i => i.file))
  const orphaned = [...oldFiles].filter(f => !newFiles.has(f))

  // 1. 保存 prompt.txt
  const promptOk = await tauriWrite('prompt.txt', promptText.value)
  if (!promptOk) { saveError.value = '❌ 保存提示词失败'; return }

  // 2. 构建新的 character.json
  const collectedEmotions = [...new Set(editableImages.value.flatMap(img => img.emotions))]

  const newData = {
    id: data.id, name: data.name, description: data.description, version: data.version,
    poses: [...editablePoses.value],
    emotions: collectedEmotions,
    costumes: [...editableCostumes.value],
    images: editableImages.value.map(img => ({
      file: img.file, pose: img.pose, costume: img.costume, emotions: [...img.emotions],
    })),
  }

  const jsonOk = await tauriWrite('character.json', JSON.stringify(newData, null, 2))
  if (!jsonOk) { saveError.value = '❌ 保存角色配置失败'; return }

  // 3. 删除已移除的图片文件
  if (orphaned.length > 0) {
    const { invoke } = await import('@tauri-apps/api/core')
    await Promise.all(orphaned.map(f =>
      invoke('delete_character_image', { id: editingId.value, filename: f })
        .catch(() => {/* 忽略删除失败 */})
    ))
  }

  // 4. 强制重新加载
  await charStore.loadCharacter(editingId.value, true)
  loadData()
  saveMsg.value = '✅ 保存成功！文件已更新'
  hasChanges.value = false
  setTimeout(() => { saveMsg.value = '' }, 3000)
}
</script>

<template>
  <div class="char-mgr">

    <!-- ========== 角色卡片列表 ========== -->
    <div v-if="view === 'list'">
      <div class="mgr-header">
        <h2 class="section-title">🎭 选择角色</h2>
      </div>

      <div class="char-grid">
        <div v-for="id in displayList" :key="id" class="char-card" @click="enterEditor(id)">
          <div class="card-icon">{{ id === charStore.currentId ? '⭐' : '🎀' }}</div>
          <div class="card-name">{{ id.charAt(0).toUpperCase() + id.slice(1) }}</div>
          <div class="card-id">{{ id }}</div>
          <div v-if="id === charStore.currentId" class="card-badge">当前</div>
        </div>
        <div class="char-card char-card-add" @click="createCharacter">
          <div class="card-icon" style="font-size:32px;color:#aaa;">+</div>
          <div class="card-name" style="color:#999;">添加角色</div>
        </div>
      </div>
    </div>

    <!-- ========== 角色编辑器 ========== -->
    <div v-if="view === 'editor'" class="editor-view">
      <!-- 左栏：固定顶部栏 + 可滚动内容 -->
      <div class="editor-left">
        <div class="editor-sticky">
          <div class="editor-topbar">
            <h2 class="editor-title">🎭 {{ editingId.charAt(0).toUpperCase() + editingId.slice(1) }}</h2>
            <div class="editor-actions">
              <button class="btn-back" @click="backToList">← 返回</button>
              <button class="btn-save-top" :class="{ dirty: hasChanges }" @click="saveAll">
                {{ hasChanges ? '💾 保存' : '保存' }}
              </button>
            </div>
          </div>
          <div class="editor-status">
            <span class="save-msg">{{ saveMsg }}</span>
            <span class="save-err">{{ saveError }}</span>
          </div>
        </div>

        <div class="editor-body">
          <!-- 📝 提示词 -->
          <section class="mgr-section">
            <h3 class="mgr-label">📝 提示词</h3>
            <textarea v-model="promptText" class="mgr-textarea" rows="8" @input="markChanged"></textarea>
          </section>

          <!-- 姿势列表 -->
          <section class="mgr-section">
            <h3 class="mgr-label">🧍 姿势</h3>
            <div class="tag-list">
              <span v-for="(p, i) in editablePoses" :key="i" class="tag-item" @click="removePose(i)" title="点击移除">{{ p
              }} ✕</span>
              <button class="tag-add" @click="addPose">+ 添加</button>
            </div>
          </section>

          <!-- 服装列表 -->
          <section class="mgr-section">
            <h3 class="mgr-label">👗 服装</h3>
            <div class="tag-list">
              <span v-for="(c, i) in editableCostumes" :key="i" class="tag-item" @click="removeCostume(i)"
                title="点击移除">{{ c }} ✕</span>
              <button class="tag-add" @click="addCostume">+ 添加</button>
            </div>
          </section>

          <!-- 🖼️ 立绘列表（grid） -->
          <section class="mgr-section">
            <h3 class="mgr-label">🖼️ 立绘</h3>
            <div class="img-grid">
              <div v-for="(img, idx) in editableImages" :key="img.file"
                :class="['img-card', { selected: editIndex === idx }]" @click="startEdit(idx)">
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

      <!-- 右栏：立绘预览 + 编辑（选中时显示） -->
      <div class="editor-right" :class="{ open: editIndex !== null }">
        <template v-if="editIndex !== null">
          <div class="preview-header">
            <span class="preview-filename">{{ editableImages[editIndex]?.file }}</span>
            <div class="preview-actions">
              <button class="preview-btn preview-btn-del" @click="deleteImage(editIndex)" title="删除此立绘">🗑️</button>
              <button class="preview-btn" @click="editIndex = null" title="关闭">✕</button>
            </div>
          </div>
          <div class="preview-image">
            <img :src="charStore.getImageUrl(editableImages[editIndex]?.file ?? '')" />
          </div>
          <div class="preview-editor">
            <div class="edit-row">
              <label>姿势</label>
              <select :value="editableImages[editIndex]?.pose"
                @change="setImagePose(editIndex, ($event.target as HTMLSelectElement).value)">
                <option v-for="p in editablePoses" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <div class="edit-row">
              <label>服装</label>
              <select :value="editableImages[editIndex]?.costume"
                @change="setImageCostume(editIndex, ($event.target as HTMLSelectElement).value)">
                <option v-for="c in editableCostumes" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="edit-row">
              <label>情绪</label>
              <div class="emotion-edit">
                <code v-for="(em, ei) in editableImages[editIndex]?.emotions" :key="ei" class="em-tag"
                  @click="removeEmotion(editIndex, ei)" title="点击移除">{{ em }} ✕</code>
                <input class="emotion-input" :value="emotionInputs[editIndex] ?? ''"
                  @input="emotionInputs[editIndex] = ($event.target as HTMLInputElement).value"
                  @keydown="onEmotionKeydown(editIndex, $event)" placeholder="输入后按空格添加" />
              </div>
            </div>
          </div>
        </template>
        <div v-else class="preview-empty">
          ← 从左侧选择一张立绘
        </div>
      </div>
    </div>
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

/* ---- 角色卡片网格 ---- */
.char-grid {
  display: grid;
  padding: 16px;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
}

.char-card {
  background: white;
  border: 1px solid #e5e5e7;
  border-radius: 12px;
  padding: 16px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.char-card:hover {
  border-color: #0071e3;
  box-shadow: 0 2px 8px rgba(0, 113, 227, 0.08);
  transform: translateY(-1px);
}
.char-card-add { border: 2px dashed #d2d2d7; cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100px; background:#fafafa; }
.char-card-add:hover { border-color:#0071e3; background:#f0f7ff; }

.card-icon {
  font-size: 28px;
  margin-bottom: 6px;
}

.card-name {
  font-size: 14px;
  font-weight: 600;
  color: #1d1d1f;
}

.card-id {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.card-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 10px;
  background: #0071e3;
  color: white;
  padding: 1px 6px;
  border-radius: 8px;
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

  &::-webkit-scrollbar {
    display: none;
  }

  scrollbar-width: none;
  scrollbar-color: transparent transparent;
}

.editor-right {
  width: 0;
  overflow: hidden;
  background: white;
  border-left: 1px solid #e5e5e7;
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
}

.editor-right.open {
  width: 340px;
  flex-shrink: 0;
  overflow: hidden;
}

/* ---- 固定顶部栏 ---- */
.editor-sticky {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #f5f5f7;
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
  color: #1d1d1f;
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
  border: 1px solid #d2d2d7;
  background: white;
  color: #555;
  border-radius: 8px;
  cursor: pointer;
}

.btn-back:hover {
  border-color: #0071e3;
  color: #0071e3;
}

.btn-save-top {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #0071e3;
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
  color: #d00;
}

.editor-body {
  flex: 1;
  overflow-y: auto;
  padding-top: 12px;
}

/* ---- 立绘 Grid ---- */
.img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.img-card {
  border: 1px solid #e5e5e7;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.12s;
}

.img-card:hover {
  border-color: #0071e3;
}

.img-card.selected {
  border-color: #0071e3;
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
}

.img-wrap {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  height: 100px;
  background: #fafafa;
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
  color: #555;
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
  border: 2px dashed #d2d2d7;
  background: #fafafa;
  min-height: 140px;
  transition: border-color 0.12s, background 0.12s;
}
.img-card-add:hover { border-color: #0071e3; background: #f0f7ff; }

.img-add-icon {
  font-size: 32px;
  color: #aaa;
  line-height: 1;
  margin-top: 12px;
}

.img-grid-tags {
  font-size: 10px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

/* ---- 右侧预览 ---- */
.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  flex-shrink: 0;
}

.preview-filename {
  font-size: 12px;
  font-family: monospace;
  color: #555;
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.preview-btn {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  color: #999;
  padding: 2px 6px;
  border-radius: 4px;
}

.preview-btn:hover {
  background: #f0f0f0;
  color: #333;
}
.preview-btn-del:hover { background: #ffe0e0; color: #d00; }

.preview-image {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: #fafafa;
  overflow: hidden;
}

.preview-image img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-editor {
  padding: 10px 12px;
  border-top: 1px solid #eee;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.preview-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bbb;
  font-size: 13px;
}

.mgr-section {
  margin-bottom: 20px;
}

.mgr-label {
  font-size: 13px;
  font-weight: 600;
  color: #555;
  margin: 0 0 8px;
}

.mgr-textarea {
  width: 100%;
  min-height: 140px;
  padding: 12px;
  font-size: 13px;
  font-family: monospace;
  border: 1px solid #d2d2d7;
  border-radius: 10px;
  background: white;
  color: #1d1d1f;
  outline: none;
  box-sizing: border-box;
  resize: vertical;
  line-height: 1.5;
}

.mgr-textarea:focus {
  border-color: #0071e3;
  box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
}

/* 标签列表（姿势/服装/情绪） */
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
  border: 1px solid #ddd;
  background: white;
  color: #555;
  cursor: pointer;
  transition: all 0.12s;
}

.tag-item:hover {
  border-color: #d00;
  color: #d00;
  background: #fff5f5;
}

.tag-auto {
  border-color: #e8f0ff;
  background: #e8f0ff;
  color: #0071e3;
  cursor: default;
}

.tag-auto:hover {
  border-color: #e8f0ff;
  color: #0071e3;
  background: #e8f0ff;
}

.tag-add {
  font-size: 12px;
  padding: 4px 10px;
  border: 1px dashed #aaa;
  background: none;
  color: #888;
  border-radius: 14px;
  cursor: pointer;
}

.tag-add:hover {
  border-color: #0071e3;
  color: #0071e3;
}

/* 图片列表 */
.img-list {}

.img-card {
  border: 1px solid #e5e5e7;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 4px;
}

.img-card.editing {
  border-color: #0071e3;
}

.img-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
}

.img-preview:hover {
  background: #f5f9ff;
}

.img-thumb {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #e5e5e7;
  background: #fafafa;
  flex-shrink: 0;
}

.img-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.img-file {
  font-family: monospace;
  color: #555;
  font-size: 11px;
}

.img-summary {
  color: #999;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 图片编辑区 */
.img-editor {
  background: #fafafa;
  border-top: 1px solid #e5e5e7;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-row label {
  font-size: 11px;
  color: #888;
  width: 40px;
  flex-shrink: 0;
}

.edit-row select {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid #d2d2d7;
  border-radius: 6px;
  background: white;
  outline: none;
}

.emotion-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
}

.em-tag {
  font-size: 11px;
  background: #e8f0ff;
  color: #0071e3;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  font-family: monospace;
}

.em-tag:hover {
  background: #ffe0e0;
  color: #d00;
}

.emotion-input {
  flex: 1;
  min-width: 120px;
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid #d2d2d7;
  border-radius: 6px;
  background: white;
  outline: none;
  font-family: inherit;
}

.emotion-input:focus {
  border-color: #0071e3;
}

.btn-add-em {
  width: 22px;
  height: 22px;
  border: 1px dashed #aaa;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: #888;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}

.btn-add-em:hover {
  border-color: #0071e3;
  color: #0071e3;
}

/* 底部 */
.mgr-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e5e5e7;
}

.btn-save {
  padding: 8px 24px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  background: #0071e3;
  color: white;
  border-radius: 20px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-save:hover {
  opacity: 0.85;
}

.btn-save.dirty {
  background: #30b94e;
}

.save-msg {
  font-size: 12px;
  color: #30b94e;
}

.save-err {
  font-size: 12px;
  color: #d00;
}
</style>
