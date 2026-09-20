<script setup lang="ts">
/**
 * 角色外观子编辑器。
 *
 * 组件只消费父层传入的草稿投影；任何业务改变都通过 edit 事件返回。
 * 图片文件操作由注入的端口完成，组件只保留选择文件、输入框和错误提示等界面状态。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import CharacterPreview from './CharacterPreview.vue'
import type { Live2DConfig, RenderKind } from '../character/loader'
import type { Live2DManifest } from '../character/live2d/manifest'
import type {
  CharacterAppearanceEditIntent,
  CharacterAppearanceImagePort,
  CharacterAppearanceLive2DImportPort,
  CharacterAppearanceProjection,
} from '../application/character/characterAppearance'
import {
  deleteCharacterAppearanceImage,
  importCharacterLive2DModel,
  saveCharacterAppearanceImage,
} from '../application/character/characterAppearance'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  characterId: string
  render: RenderKind
  draft: CharacterAppearanceProjection
  manifest?: Live2DManifest | null
  manifestError?: string
  filePort?: CharacterAppearanceImagePort
  bustImageCache?: () => void | Promise<void>
  imageUrl?: (filename: string) => string
  pickLive2dModel?: () => Promise<string | null>
  live2dPort?: CharacterAppearanceLive2DImportPort
  loadLive2dManifest?: (model: string) => Promise<Live2DManifest>
  createFilename?: (file: File, index: number) => string
}>(), {
  manifest: null,
  manifestError: '',
  filePort: undefined,
  bustImageCache: () => undefined,
  imageUrl: (filename: string) => filename,
  pickLive2dModel: undefined,
  live2dPort: undefined,
  loadLive2dManifest: undefined,
  createFilename: undefined,
})

const emit = defineEmits<{
  edit: [intent: CharacterAppearanceEditIntent]
  'select-image': [filename: string | null]
  'live2d-manifest-loaded': [manifest: Live2DManifest]
  'live2d-model-imported': [model: string]
  'file-operation-success': [operation: 'upload' | 'replace' | 'delete', filename: string]
  'file-operation-error': [operation: 'upload' | 'replace' | 'delete', error: string]
}>()

const selectedFile = ref<string | null>(null)
const newPose = ref('')
const newCostume = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const errorMessage = ref('')

const selectedImage = computed(() =>
  props.draft.images.find(image => image.file === selectedFile.value) ?? null,
)

function clearError() { errorMessage.value = '' }

function publish(intent: CharacterAppearanceEditIntent) {
  emit('edit', intent)
}

function selectImage(filename: string) {
  selectedFile.value = filename
  emit('select-image', filename)
}

function closePreview() {
  selectedFile.value = null
  emit('select-image', null)
}

function addPose() {
  const value = newPose.value.trim()
  if (!value || props.draft.poses.includes(value)) return
  publish({ type: 'add-pose', value })
  newPose.value = ''
}

function addCostume() {
  const value = newCostume.value.trim()
  if (!value || props.draft.costumes.includes(value)) return
  publish({ type: 'add-costume', value })
  newCostume.value = ''
}

function setConfig(patch: Partial<Live2DConfig>) {
  publish({ type: 'set-live2d-config', patch })
}

function imagePortError(operation: 'upload' | 'replace' | 'delete', message: string) {
  errorMessage.value = message
  emit('file-operation-error', operation, message)
}

function imagePortUnavailable(operation: 'upload' | 'replace' | 'delete') {
  imagePortError(operation, '外观文件端口未装配')
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function saveImageFile(
  file: File,
  filename: string,
  previousFilename: string | undefined,
  operation: 'upload' | 'replace',
) {
  if (!props.filePort) {
    imagePortUnavailable(operation)
    return
  }
  busy.value = true
  clearError()
  try {
    const result = await saveCharacterAppearanceImage({
      port: props.filePort,
      characterId: props.characterId,
      filename,
      previousFilename,
      dataBase64: await fileToBase64(file),
      bustImageCache: props.bustImageCache,
    })
    if (result.persisted) {
      publish(previousFilename
        ? { type: 'replace-image', file: previousFilename }
        : {
            type: 'add-image',
            image: {
              file: filename,
              pose: props.draft.poses[0] ?? '',
              costume: props.draft.costumes[0] ?? '',
              emotions: [],
            },
          })
    }
    if (!result.ok) {
      const reason = result.error?.reason ?? '图片操作失败'
      imagePortError(operation, reason)
      return
    }
    emit('file-operation-success', operation, filename)
  } catch (error) {
    imagePortError(operation, error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

function triggerUpload() {
  if (!busy.value) fileInput.value?.click()
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  const images = files.filter(file => file.type.startsWith('image/'))
  if (images.length === 0) {
    imagePortError('upload', '请选择图片文件')
    return
  }

  const replacing = selectedImage.value !== null
  if (replacing) {
    const file = images[0]
    await saveImageFile(file, selectedImage.value!.file, selectedImage.value!.file, 'replace')
    return
  }
  for (const [index, file] of images.entries()) {
    const filename = props.createFilename?.(file, index)
      ?? `${props.characterId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${file.name.split('.').pop() || 'png'}`
    await saveImageFile(file, filename, undefined, 'upload')
  }
}

async function deleteSelectedImage() {
  const image = selectedImage.value
  if (!image) return
  if (!props.filePort) {
    imagePortUnavailable('delete')
    return
  }
  busy.value = true
  clearError()
  try {
    const result = await deleteCharacterAppearanceImage({
      port: props.filePort,
      characterId: props.characterId,
      filename: image.file,
      bustImageCache: props.bustImageCache,
    })
    if (result.persisted) {
      publish({ type: 'remove-image', file: image.file })
      selectedFile.value = null
      emit('select-image', null)
    }
    if (!result.ok) {
      imagePortError('delete', result.error?.reason ?? '删除图片失败')
      return
    }
    emit('file-operation-success', 'delete', image.file)
  } catch (error) {
    imagePortError('delete', error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

async function reimportLive2dModel() {
  clearError()
  if (!props.pickLive2dModel || !props.live2dPort) {
    errorMessage.value = 'Live2D 导入端口未装配'
    return
  }
  let sourceDir: string | null
  try {
    sourceDir = await props.pickLive2dModel()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    return
  }
  if (!sourceDir) return
  busy.value = true
  try {
    const result = await importCharacterLive2DModel(props.live2dPort, props.characterId, sourceDir)
    if (!result.ok || !result.model) {
      errorMessage.value = result.error ?? 'Live2D 模型导入失败'
      return
    }
    setConfig({ model: result.model })
    emit('live2d-model-imported', result.model)
    if (props.loadLive2dManifest) {
      try {
        emit('live2d-manifest-loaded', await props.loadLive2dManifest(result.model))
      } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error)
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="appearance-editor" :aria-busy="busy">
    <p v-if="errorMessage || manifestError" class="appearance-error" role="alert" data-selectable>{{ errorMessage || manifestError }}</p>

    <template v-if="render === 'illustration'">
      <section class="appearance-section">
        <h3 class="mgr-label"><i class="fas fa-person"></i> {{ t('character.mgr.poses') }}</h3>
        <div class="tag-list">
          <button v-for="(pose, index) in draft.poses" :key="pose" type="button" class="tag-item"
            @click="publish({ type: 'remove-pose', index })">{{ pose }} ✕</button>
          <input v-model="newPose" class="tag-input" :placeholder="t('character.mgr.tagInputPlaceholder')"
            @keydown.enter.prevent="addPose" />
          <button type="button" class="tag-add" @click="addPose">{{ t('character.mgr.addTag') }}</button>
        </div>
      </section>

      <section class="appearance-section">
        <h3 class="mgr-label"><i class="fas fa-shirt"></i> {{ t('character.mgr.costumes') }}</h3>
        <div class="tag-list">
          <button v-for="(costume, index) in draft.costumes" :key="costume" type="button" class="tag-item"
            @click="publish({ type: 'remove-costume', index })">{{ costume }} ✕</button>
          <input v-model="newCostume" class="tag-input" :placeholder="t('character.mgr.tagInputPlaceholder')"
            @keydown.enter.prevent="addCostume" />
          <button type="button" class="tag-add" @click="addCostume">{{ t('character.mgr.addTag') }}</button>
        </div>
      </section>

      <section class="appearance-section">
        <div class="appearance-heading">
          <h3 class="mgr-label"><i class="fas fa-images"></i> {{ t('character.mgr.imagesTitle') }}</h3>
          <button type="button" class="tag-add" :disabled="busy" @click="triggerUpload">{{ t('character.mgr.addImage') }}</button>
        </div>
        <div class="appearance-image-grid">
          <button v-for="image in draft.images" :key="image.file" type="button"
            class="appearance-image-card" :class="{ selected: image.file === selectedFile }"
            :aria-pressed="image.file === selectedFile" @click="selectImage(image.file)">
            <img :src="imageUrl(image.file)" :alt="image.file" />
            <span>{{ image.file }}</span>
          </button>
          <button type="button" class="appearance-image-card appearance-image-add" :disabled="busy" @click="triggerUpload">+</button>
        </div>
        <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="handleFiles" />
      </section>

      <CharacterPreview v-if="selectedImage" :image="selectedImage" :image-url="imageUrl(selectedImage.file)"
        :poses="[...draft.poses]" :costumes="[...draft.costumes]"
        @update-pose="(_, pose) => publish({ type: 'set-image-pose', file: selectedImage!.file, pose })"
        @update-costume="(_, costume) => publish({ type: 'set-image-costume', file: selectedImage!.file, costume })"
        @add-emotion="(_, emotion) => publish({ type: 'add-emotion', file: selectedImage!.file, emotion })"
        @remove-emotion="(_, index) => publish({ type: 'remove-emotion', file: selectedImage!.file, index })"
        @delete="deleteSelectedImage" @close="closePreview" />
    </template>

    <template v-else>
      <section class="appearance-section">
        <div class="appearance-heading">
          <h3 class="mgr-label"><i class="fas fa-cube"></i> {{ t('character.mgr.live2d.model') }}</h3>
          <button type="button" class="tag-add" :disabled="busy" @click="reimportLive2dModel">{{ t('character.mgr.live2d.reimport') }}</button>
        </div>
        <code class="live2d-model" data-selectable>{{ draft.live2d?.model || t('character.mgr.live2d.modelNone') }}</code>
      </section>

      <section class="appearance-section" v-if="draft.live2d">
        <h3 class="mgr-label"><i class="fas fa-up-down-left-right"></i> {{ t('character.mgr.live2d.display') }}</h3>
        <div class="live2d-grid">
          <label>{{ t('character.mgr.live2d.scale') }}
            <input type="number" step="0.05" :value="draft.live2d.scale ?? ''"
              @change="setConfig({ scale: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label>{{ t('character.mgr.live2d.offsetX') }}
            <input type="number" :value="draft.live2d.offsetX ?? ''"
              @change="setConfig({ offsetX: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label>{{ t('character.mgr.live2d.offsetY') }}
            <input type="number" :value="draft.live2d.offsetY ?? ''"
              @change="setConfig({ offsetY: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="live2d-check"><input type="checkbox" :checked="draft.live2d.mouseFollow !== false"
            @change="setConfig({ mouseFollow: ($event.target as HTMLInputElement).checked })" />
            {{ t('character.mgr.live2d.mouseFollow') }}</label>
          <label>{{ t('character.mgr.live2d.idleMotion') }}
            <select :value="draft.live2d.idleMotionGroup ?? manifest?.idleGroup ?? ''"
              @change="setConfig({ idleMotionGroup: ($event.target as HTMLSelectElement).value || undefined })">
              <option v-for="motion in manifest?.motions ?? []" :key="motion.group" :value="motion.group">{{ motion.group }}</option>
            </select>
          </label>
          <label>{{ t('character.mgr.live2d.tapMotion') }}
            <select :value="draft.live2d.tapMotionGroup ?? ''"
              @change="setConfig({ tapMotionGroup: ($event.target as HTMLSelectElement).value || undefined })">
              <option value="">{{ t('character.mgr.live2d.motionNone') }}</option>
              <option v-for="motion in manifest?.motions ?? []" :key="motion.group" :value="motion.group">{{ motion.group }}</option>
            </select>
          </label>
        </div>
      </section>

      <section v-if="manifest?.expressions.length" class="appearance-section">
        <h3 class="mgr-label"><i class="fas fa-face-grin-stars"></i> {{ t('character.mgr.live2d.exprAnno') }}</h3>
        <label v-for="expression in manifest.expressions" :key="expression.id" class="live2d-annotation">
          <code>{{ expression.id }}</code>
          <input :value="draft.live2d?.expressions?.[expression.id] ?? ''"
            @input="setConfig({ expressions: { ...(draft.live2d?.expressions ?? {}), [expression.id]: ($event.target as HTMLInputElement).value } })" />
        </label>
      </section>

      <section v-if="manifest?.motions.length" class="appearance-section">
        <h3 class="mgr-label"><i class="fas fa-film"></i> {{ t('character.mgr.live2d.motionAnno') }}</h3>
        <label v-for="motion in manifest.motions" :key="motion.group" class="live2d-annotation">
          <code>{{ motion.group }}</code>
          <input :value="draft.live2d?.motions?.[motion.group] ?? ''"
            @input="setConfig({ motions: { ...(draft.live2d?.motions ?? {}), [motion.group]: ($event.target as HTMLInputElement).value } })" />
        </label>
      </section>
    </template>
  </div>
</template>

<style scoped>
.appearance-editor { display: flex; flex-direction: column; gap: 12px; }
.appearance-section { display: flex; flex-direction: column; gap: 8px; }
.appearance-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.appearance-heading .mgr-label { margin: 0; }
.appearance-error { margin: 0; padding: 8px 10px; border: 1px solid var(--c-error); border-radius: 6px; color: var(--c-error); background: rgba(239, 83, 80, .1); }
.appearance-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.appearance-image-card { min-height: 110px; display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid var(--c-border); border-radius: 6px; color: var(--c-text); background: var(--c-control); cursor: pointer; text-align: left; }
.appearance-image-card.selected { border-color: var(--c-brand); }
.appearance-image-card img { width: 100%; height: 78px; object-fit: contain; background: var(--c-panel); }
.appearance-image-card span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-aux); }
.appearance-image-add { align-items: center; justify-content: center; font-size: 28px; color: var(--c-text-muted); }
.live2d-model { display: block; padding: 8px; overflow-wrap: anywhere; color: #9fb3c8; background: #14142a; border: 1px solid var(--c-border); border-radius: 6px; }
.live2d-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.live2d-grid label { display: flex; flex-direction: column; gap: 4px; color: var(--c-text-muted); font-size: 12px; }
.live2d-grid input, .live2d-grid select, .live2d-annotation input { padding: 6px 8px; border: 1px solid var(--c-border); border-radius: 6px; color: var(--c-text); background: var(--c-control); }
.live2d-check { justify-content: end; flex-direction: row !important; align-items: center; }
.live2d-check input { width: 15px; accent-color: var(--c-brand); }
.live2d-annotation { display: flex; gap: 8px; align-items: center; }
.live2d-annotation code { min-width: 110px; color: #7c8cff; }
.live2d-annotation input { flex: 1; }
@media (max-width: 760px) { .live2d-grid { grid-template-columns: 1fr; } }
</style>
