<script setup lang="ts">
/** 角色管理组合根：只拥有页面状态并装配角色编辑协作者。 */
import { computed, onMounted, onUnmounted, ref, watch, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCharacterStore } from '../stores/character'
import { getTtsProvider } from '../tts'
import { STORAGE_TTS_PROVIDER } from '../constants'
import { subscribeSettingsChange } from '../application/settings/settingsChangeStream'
import { createCharacterPackWorkflow } from '../application/character/characterPackWorkflow'
import { createCharacterDeletionWorkflow } from '../application/character/characterDeletion'
import { type CharacterCreationPorts } from '../application/character/characterCreation'
import { createCharacterDraftSync } from '../application/character/characterDraftSync'
import { saveCharacter } from '../application/character/characterSaveWorkflow'
import { createTauriCharacterPackPort } from '../infrastructure/character/tauriCharacterPackPort'
import { createTauriCharacterManagerPorts } from '../infrastructure/character/tauriCharacterManagerPorts'
import type { CharacterManagerPorts } from '../application/character/characterManagerPorts'
import { defaultCharacterVoiceEditorPorts } from '../application/character/characterVoiceEditor'
import CharacterList from './CharacterList.vue'
import CharacterCreateForm from './CharacterCreateForm.vue'
import CharacterAppearanceEditor from './CharacterAppearanceEditor.vue'
import CharacterVoiceEditor from './CharacterVoiceEditor.vue'
import Live2DPreview from './Live2DPreview.vue'
import UnsavedDialog from './UnsavedDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const { t } = useI18n()
const charStore = useCharacterStore()
const ports: CharacterManagerPorts = createTauriCharacterManagerPorts()
type ViewMode = 'list' | 'editor'
const view = ref<ViewMode>('list')
const editingId = ref('')
const previewCollapsed = ref(false)
const saveMsg = ref('')
const saveError = ref('')
const showCreateForm = ref(false)
const showDeleteConfirm = ref(false)
const createFormRef = ref<InstanceType<typeof CharacterCreateForm> | null>(null)
const leaveDialog = ref<InstanceType<typeof UnsavedDialog> | null>(null)
const isDeleting = ref(false)
const ttsProvider = ref(getTtsProvider())
type CharacterManagerManifest = Awaited<ReturnType<CharacterManagerPorts['loadLive2dManifest']>>
const live2dManifest = ref<CharacterManagerManifest | null>(null)
const live2dManifestError = ref('')
const draftTick = ref(0)

const draftSync = createCharacterDraftSync({
  save: request => saveCharacter(request, {
    files: ports.files,
    refreshCache: ports.bustImageCache,
    broadcastCharactersChanged: ports.broadcastCharactersChanged,
  }),
})
const packWorkflow = createCharacterPackWorkflow({
  ...createTauriCharacterPackPort(),
  refreshDisplayData: () => charStore.refreshList(),
  bustImageCache: ports.bustImageCache,
  emitCharactersChanged: ports.broadcastCharactersChanged,
})
const deletionWorkflow = createCharacterDeletionWorkflow({
  deleteCharacter: ports.deleteCharacter,
  refreshDisplayData: async () => { await charStore.refreshList(); return charStore.availableList },
  loadReplacement: async id => {
    if (id) await charStore.loadCharacter(id, true)
    else charStore.clearCurrentCharacter()
  },
  emitCharactersChanged: ports.broadcastCharactersChanged,
})

const draft = computed(() => { void draftTick.value; return draftSync.projection })
const appearanceDraft = computed(() => draft.value
  ? { images: draft.value.images, poses: draft.value.poses, costumes: draft.value.costumes, live2d: draft.value.live2d }
  : { images: [], poses: [], costumes: [], live2d: undefined })
const voiceDraft = computed(() => draft.value ?? {
  voice: '', voiceModel: '', voiceLanguage: 'ja-JP', textLanguage: 'zh-CN',
  gptsovitsRefAudio: '', gptsovitsPromptText: '', gptsovitsPromptLang: 'ja-JP',
})
const dirty = computed(() => { void draftTick.value; return draftSync.dirty })
const saving = computed(() => draftSync.saving)
const editablePage = { get dirty() { return draftSync.dirty }, get saving() { return draftSync.saving }, save: savePage }
const createTitleId = useId()

let unsubscribeSettings: (() => void) | null = null
onMounted(async () => {
  unsubscribeSettings = subscribeSettingsChange(keys => { if (keys.includes(STORAGE_TTS_PROVIDER)) ttsProvider.value = getTtsProvider() })
  await ports.initializeDataDir().catch(() => undefined)
  if (charStore.availableList.length === 0) await charStore.refreshList()
})
onUnmounted(() => { unsubscribeSettings?.(); unsubscribeSettings = null })
watch(() => draft.value?.render, render => {
  if (render === 'live2d' && draft.value?.live2d?.model) void refreshLive2dManifest(draft.value.live2d.model)
  else { live2dManifest.value = null; live2dManifestError.value = '' }
})

async function refreshLive2dManifest(model: string) {
  try {
    live2dManifestError.value = ''
    live2dManifest.value = await ports.loadLive2dManifest(editingId.value, { live2d: { ...(draft.value?.live2d ?? { model }), model } })
  } catch (error) {
    live2dManifest.value = null
    live2dManifestError.value = error instanceof Error ? error.message : String(error)
  }
}

async function enterEditor(id: string) {
  if (!charStore.availableList.includes(id)) return
  editingId.value = id
  saveError.value = ''
  try {
    await charStore.loadCharacter(id, true)
    if (!charStore.data) return
    draftSync.load(charStore.data)
    draftTick.value++
    view.value = 'editor'
    if (charStore.data.render === 'live2d' && charStore.data.live2d?.model) await refreshLive2dManifest(charStore.data.live2d.model)
  } catch (error) { saveError.value = error instanceof Error ? error.message : String(error) }
}

function openCreateForm() { showCreateForm.value = true; createFormRef.value?.reset() }
async function pickModelFolder() {
  return ports.pickLive2dModel()
}
function creationPorts(): CharacterCreationPorts {
  return {
    files: ports.creationFiles,
    importLive2DModel: ports.live2d.importLive2dModel,
    deleteCharacter: ports.deleteCharacter,
    refreshDisplayData: () => charStore.refreshList(),
    broadcastCharactersChanged: ports.broadcastCharactersChanged,
    enterEditor,
  }
}
function onCreated(id: string) {
  showCreateForm.value = false
  showSaveMessage(t('character.msg.createdCharacter', { name: id }))
}
function showSaveMessage(message: string, duration = 3000) {
  saveMsg.value = message
  window.setTimeout(() => {
    if (saveMsg.value === message) saveMsg.value = ''
  }, duration)
}
function closeCreateForm() { if (!saving.value) showCreateForm.value = false }

async function savePage(): Promise<boolean> {
  const ok = await draftSync.save()
  draftTick.value++
  if (ok) {
    saveError.value = ''
    showSaveMessage(t('character.msg.saveSuccess'))
    return true
  }
  saveError.value = draftSync.error?.message ?? t('safety.saveFailed')
  return false
}
defineExpose({ dirty, saving, save: savePage })

async function backToList() {
  if (!await leaveDialog.value?.ask(editablePage)) return
  view.value = 'list'; editingId.value = ''; live2dManifest.value = null; live2dManifestError.value = ''
}
async function deleteCurrentCharacter() {
  if (!editingId.value) return
  isDeleting.value = true; saveError.value = ''
  try {
    const result = await deletionWorkflow.delete({ targetId: editingId.value, currentId: charStore.currentId, availableIds: charStore.availableList, confirmed: true })
    if (result.status === 'succeeded') {
      showDeleteConfirm.value = false; view.value = 'list'; editingId.value = ''; live2dManifest.value = null; live2dManifestError.value = ''
      showSaveMessage(t('character.msg.deletedCharacter'))
    } else if (result.status === 'failed') saveError.value = result.reason
  } finally { isDeleting.value = false }
}
function editDraft(command: () => boolean) { command(); draftTick.value++ }
function handleAppearanceEdit(intent: Parameters<typeof draftSync.applyAppearance>[0]) { editDraft(() => draftSync.applyAppearance(intent)) }
function handleVoiceChange(field: 'voice' | 'voiceModel' | 'voiceLanguage' | 'textLanguage' | 'gptsovitsRefAudio' | 'gptsovitsPromptText' | 'gptsovitsPromptLang', value: string) { editDraft(() => draftSync.setVoice(field, value)) }
function handleNameInput(value: string) { editDraft(() => draftSync.setName(value)) }
function handleDescriptionInput(value: string) { editDraft(() => draftSync.setDescription(value)) }
function handlePromptInput(value: string) { editDraft(() => draftSync.setPrompt(value)) }
async function importPack() {
    const result = await packWorkflow.importCharacterPack()
  if (result.status === 'succeeded') {
    const parts: string[] = []
    if (result.imported.length) parts.push(t('character.msg.imported', { n: result.imported.length }))
    if (result.skipped.length) parts.push(t('character.msg.skipped', { n: result.skipped.length }))
    showSaveMessage(parts.length ? parts.join(' · ') : t('character.msg.nothingToImport'), 4000)
  } else if (result.status === 'failed') saveError.value = result.reason
}
async function exportPack() {
  if (!editingId.value) return
  const result = await packWorkflow.exportCharacterPack(editingId.value)
  if (result.status === 'succeeded') showSaveMessage(t('character.msg.packExported'))
  else if (result.status === 'failed') saveError.value = result.reason
}
</script>

<template>
  <UnsavedDialog ref="leaveDialog" />
  <ConfirmDialog :visible="showDeleteConfirm" :busy="isDeleting" :title="t('character.mgr.deleteConfirmTitle')" :message="t('character.mgr.deleteConfirmText', { id: editingId })" :confirm-label="t('character.mgr.confirmDelete')" danger @cancel="showDeleteConfirm = false" @confirm="deleteCurrentCharacter" />
  <div class="char-mgr">
    <div v-if="view === 'list'">
      <div class="mgr-header mgr-header-row"><h2 class="section-title"><i class="fas fa-masks-theater"></i> {{ t('character.mgr.selectTitle') }}</h2><button class="btn-import" :disabled="packWorkflow.busy" @click="importPack"><i class="fas fa-file-import"></i> {{ t('character.mgr.importPack') }}</button></div>
      <div class="list-status"><span v-if="saveMsg" class="save-msg"><i class="fas fa-check-circle"></i> {{ saveMsg }}</span><span v-if="saveError" class="save-err" role="alert" data-selectable><i class="fas fa-xmark-circle"></i> {{ saveError }}</span></div>
      <div v-if="charStore.characterDisplayList.length === 0" class="empty-guide"><i class="fas fa-masks-theater empty-guide-icon"></i><p class="empty-guide-title">{{ t('character.mgr.emptyTitle') }}</p><p class="empty-guide-hint">{{ t('character.mgr.emptyHint') }}</p><div class="empty-guide-actions"><button class="btn-import-lg" :disabled="packWorkflow.busy" @click="importPack"><i class="fas fa-file-import"></i> {{ t('character.mgr.importPack') }}</button><button class="btn-create-lg" @click="openCreateForm"><i class="fas fa-plus"></i> {{ t('character.mgr.createNew') }}</button></div></div>
      <CharacterList v-else :characters="charStore.characterDisplayList" :current-id="charStore.currentId" @select="enterEditor" @create="openCreateForm" />
      <Transition name="modal-fade"><div v-if="showCreateForm" class="modal-overlay" @click.self="closeCreateForm"><section class="modal-card" role="dialog" aria-modal="true" :aria-labelledby="createTitleId"><div class="modal-header"><h3 :id="createTitleId" class="modal-title"><i class="fas fa-masks-theater"></i> {{ t('character.mgr.createTitle') }}</h3><button class="modal-close" @click="closeCreateForm">✕</button></div><div class="modal-body"><CharacterCreateForm ref="createFormRef" :existing-ids="charStore.availableList" :ports="creationPorts()" :model-picker="pickModelFolder" @created="onCreated" @close="closeCreateForm" /></div></section></div></Transition>
    </div>
    <div v-else class="editor-view">
      <div class="editor-left">
        <div class="editor-sticky"><div class="editor-topbar"><button class="btn-back" @click="backToList">{{ t('common.back') }}</button><input :value="draft?.name" class="editor-name-input" :placeholder="editingId" :aria-label="t('character.mgr.nameLabel')" @input="handleNameInput(($event.target as HTMLInputElement).value)" /><div class="editor-actions"><button class="btn-icon-btn" :class="{ active: !previewCollapsed }" :aria-pressed="!previewCollapsed" :title="t('character.mgr.previewToggle')" @click="previewCollapsed = !previewCollapsed"><i class="fas" :class="previewCollapsed ? 'fa-eye' : 'fa-eye-slash'"></i></button><button class="btn-save-top" :class="{ dirty }" :disabled="saving" @click="savePage"><i v-if="dirty" class="fas fa-floppy-disk"></i> {{ saving ? t('safety.saving') : t('character.mgr.saveBtn') }}</button><button class="btn-export" :disabled="packWorkflow.busy" @click="exportPack" :title="t('character.mgr.exportTitle')"><i class="fas fa-file-export"></i></button><button class="btn-delete" :disabled="isDeleting" @click="showDeleteConfirm = true" :title="t('character.mgr.deleteTitle')"><i class="fas fa-trash-can"></i></button></div></div><div class="editor-status"><span v-if="saveMsg" class="save-msg"><i class="fas fa-check-circle"></i> {{ saveMsg }}</span><span v-if="saveError" class="save-err" role="alert" data-selectable><i class="fas fa-xmark-circle"></i> {{ saveError }}</span></div></div>
        <div class="editor-body">
          <section class="mgr-section"><h3 class="mgr-label"><i class="fas fa-id-badge"></i> {{ t('character.mgr.groupBasic') }}</h3><div class="form-group"><label class="lang-label">{{ t('character.mgr.descLabel') }}</label><input :value="draft?.description" class="form-input" :placeholder="t('character.mgr.descPlaceholder')" @input="handleDescriptionInput(($event.target as HTMLInputElement).value)" /></div><p class="mgr-desc"><i class="fas fa-fingerprint"></i> ID: {{ editingId }}</p></section>
          <section class="mgr-section"><h3 class="mgr-label"><i class="fas fa-pencil"></i> {{ t('character.mgr.groupPersona') }}</h3><textarea :value="draft?.prompt" class="mgr-textarea" rows="8" @input="handlePromptInput(($event.target as HTMLTextAreaElement).value)"></textarea></section>
          <section class="mgr-section"><h3 class="mgr-label"><i class="fas fa-images"></i> {{ t('character.mgr.groupAppearance') }}</h3><CharacterAppearanceEditor v-if="draft" :character-id="editingId" :render="draft.render" :draft="appearanceDraft" :manifest="live2dManifest" :manifest-error="live2dManifestError" :file-port="ports.appearanceFiles" :bust-image-cache="ports.bustImageCache" :image-url="charStore.getImageUrl" :pick-live2d-model="pickModelFolder" :live2d-port="ports.live2d" :load-live2d-manifest="model => ports.loadLive2dManifest(editingId, { live2d: { ...(draft?.live2d ?? { model }), model } })" preview-target="#character-illustration-preview" @edit="handleAppearanceEdit" @live2d-manifest-loaded="live2dManifest = $event; live2dManifestError = ''" @file-operation-error="saveError = $event" /></section>
          <section class="mgr-section"><h3 class="mgr-label"><i class="fas fa-microphone"></i> {{ t('character.mgr.groupVoice') }}</h3><CharacterVoiceEditor v-if="draft" :draft="voiceDraft" :provider="ttsProvider" :character-id="editingId" :ports="defaultCharacterVoiceEditorPorts" @change="handleVoiceChange" @provider-change="ttsProvider = $event" /></section>
        </div>
      </div>
      <div v-if="draft?.render === 'illustration'" id="character-illustration-preview"
        class="illustration-preview-host" :class="{ collapsed: previewCollapsed }"></div>
      <div v-if="draft?.render === 'live2d' && !previewCollapsed" class="l2d-preview-panel"><Live2DPreview :id="editingId" :config="draft.live2d ? { ...draft.live2d } : undefined" /></div>
    </div>
  </div>
</template>

<style scoped>
.char-mgr { max-width: 100%; height: 100%; }
.mgr-header { margin-bottom: 16px; }
.section-title { font-size: 20px; font-weight: 700; margin: 0 0 4px; padding: 16px 16px 0; color: var(--c-text); }
.editor-view { display: flex; height: 100%; gap: 0; }
.editor-left { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 16px; overflow: hidden; height: 100%; box-sizing: border-box; scrollbar-width: none; }
.editor-left::-webkit-scrollbar { display: none; }
.editor-sticky { position: sticky; top: 0; z-index: 10; background: var(--c-panel); padding: 14px 0 12px; flex-shrink: 0; }
.editor-name-input { flex: 1; min-width: 0; padding: 6px 10px; font-size: var(--fs-body); font-weight: 600; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--c-text); outline: none; transition: border-color 0.15s, background 0.15s; }
.editor-name-input:hover { background: var(--c-hover); }
.editor-name-input:focus { border-color: var(--c-brand); background: var(--c-control); box-shadow: var(--focus-ring); }
.btn-icon-btn { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-control); color: var(--c-text-secondary); cursor: pointer; transition: all 0.15s; }
.btn-icon-btn:hover { border-color: var(--c-brand); color: var(--c-brand); }
.btn-icon-btn.active { border-color: var(--c-brand); color: var(--c-brand); background: var(--c-brand-soft); }
.editor-topbar { display: flex; align-items: center; justify-content: space-between; }
.editor-actions { display: flex; align-items: center; gap: 8px; }
.editor-status { min-height: 18px; margin-top: 2px; }
.btn-back { padding: 5px 14px; font-size: 13px; border: 1px solid var(--c-border); background: var(--c-control); color: var(--c-text-secondary); border-radius: 8px; cursor: pointer; }
.btn-back:hover { border-color: var(--c-brand); color: var(--c-brand); }
.btn-save-top { padding: 6px 18px; font-size: 13px; font-weight: 500; border: none; background: var(--c-brand); color: white; border-radius: 20px; cursor: pointer; transition: opacity 0.15s; }
.btn-save-top:hover { opacity: 0.85; }
.btn-save-top.dirty { background: var(--c-ok); }
.editor-body { flex: 1; overflow-y: auto; padding-top: 12px; padding-bottom: 16px; }
.editor-body::-webkit-scrollbar { width: 6px; }
.editor-body::-webkit-scrollbar-track { background: transparent; }
.editor-body::-webkit-scrollbar-thumb { background: var(--c-border); border-radius: 3px; }
.editor-body::-webkit-scrollbar-thumb:hover { background: var(--c-border-strong); }
.illustration-preview-host { display: flex; min-width: 0; flex-shrink: 0; }
.illustration-preview-host.collapsed { display: none; }
.l2d-preview-panel { width: clamp(240px, 30vw, 340px); min-width: 0; flex-shrink: 0; background: var(--c-bg); border-left: 1px solid var(--c-border); }
.mgr-header-row { display: flex; align-items: center; justify-content: space-between; }
@media (max-width: 760px) { .editor-left { padding: var(--space-2); } .editor-topbar { flex-wrap: wrap; gap: var(--space-2); } .editor-name-input { order: 3; flex-basis: 100%; } .editor-actions { margin-left: auto; } .l2d-preview-panel { width: min(38vw, 240px); } }
@media (max-height: 520px) { .modal-card { max-height: 96vh; } .editor-sticky { padding-block: var(--space-1) var(--space-2); } }
</style>
