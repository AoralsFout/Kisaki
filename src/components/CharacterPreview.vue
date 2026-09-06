<script setup lang="ts">
/**
 * 立绘预览与编辑面板（右侧）
 *
 * 展示选中立绘的大图，支持编辑姿势/服装/情绪标签。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CharacterImageData } from '../character/loader'

const { t } = useI18n()

const props = defineProps<{
  image: CharacterImageData | null
  imageUrl: string
  poses: string[]
  costumes: string[]
}>()

const emit = defineEmits<{
  'update-pose': [file: string, pose: string]
  'update-costume': [file: string, costume: string]
  'add-emotion': [file: string, emotion: string]
  'remove-emotion': [file: string, index: number]
  delete: [file: string]
  close: []
}>()

const emotionInput = ref('')

function handleEmotionKeydown(e: KeyboardEvent) {
  if (!e.isComposing && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault()
    const val = emotionInput.value.trim()
    if (!val || !props.image) return
    emit('add-emotion', props.image.file, val)
    emotionInput.value = ''
  }
}
</script>

<template>
  <div class="preview-panel" :class="{ open: image !== null }">
    <template v-if="image">
      <div class="preview-header">
        <span class="preview-filename">{{ image.file }}</span>
        <div class="preview-actions">
          <button class="preview-btn preview-btn-del" @click="emit('delete', image.file)"
            :title="t('character.preview.deleteTitle')" :aria-label="t('character.preview.deleteTitle')"><i class="fas fa-trash-can"></i></button>
          <button class="preview-btn" @click="emit('close')" :title="t('common.close')"
            :aria-label="t('common.close')">✕</button>
        </div>
      </div>

      <div class="preview-image">
        <img :src="imageUrl" :alt="image.file" />
      </div>

      <div class="preview-editor">
        <div class="edit-row">
          <label>{{ t('character.preview.pose') }}</label>
          <select
            :value="image.pose"
            @change="emit('update-pose', image.file, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="p in poses" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>

        <div class="edit-row">
          <label>{{ t('character.preview.costume') }}</label>
          <select
            :value="image.costume"
            @change="emit('update-costume', image.file, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in costumes" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>

        <div class="edit-row">
          <label>{{ t('character.preview.emotion') }}</label>
          <div class="emotion-edit">
            <button type="button"
              v-for="(em, ei) in image.emotions"
              :key="ei"
              class="em-tag"
              @click="emit('remove-emotion', image.file, ei)"
              :aria-label="`${t('character.preview.clickToRemove')}: ${em}`"
            >{{ em }} ✕</button>
            <input
              v-model="emotionInput"
              class="emotion-input"
              @keydown="handleEmotionKeydown"
              :placeholder="t('character.preview.emotionPlaceholder')"
            />
          </div>
        </div>
      </div>
    </template>
    <div v-else class="preview-empty">
      {{ t('character.preview.empty') }}
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  width: 0;
  overflow: hidden;
  background: var(--c-bg);
  border-left: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;
}

.preview-panel.open {
  width: 340px;
  flex-shrink: 0;
  overflow: hidden;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--c-border);
  flex-shrink: 0;
}

.preview-filename {
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--c-text-secondary);
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
  color: var(--c-text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}

.preview-btn:hover {
  background: var(--c-border);
  color: var(--c-text);
}
.preview-btn-del:hover {
  background: rgba(239, 83, 80, 0.15);
  color: var(--c-error);
}

.preview-image {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: var(--c-panel);
  overflow: hidden;
}

.preview-image img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-editor {
  padding: 10px 12px;
  border-top: 1px solid var(--c-border);
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
  color: #555;
  font-size: 13px;
}

.edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-row label {
  font-size: var(--fs-aux);
  color: var(--c-text-muted);
  width: 40px;
  flex-shrink: 0;
}

.edit-row select {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-control);
  color: var(--c-text);
  outline: none;
}

.emotion-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  flex: 1;
}

.em-tag {
  font-size: var(--fs-aux);
  background: rgba(74, 122, 255, 0.15);
  color: #7c8cff;
  padding: 2px 7px;
  border-radius: 4px;
  font-family: var(--font-mono);
  border: 0;
  cursor: pointer;
}

.em-tag:hover {
  background: rgba(239, 83, 80, 0.15);
  color: var(--c-error);
}

@media (max-width: 760px) {
  .preview-panel.open { width: min(38vw, 240px); }
}

.emotion-input {
  flex: 1;
  min-width: 120px;
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-control);
  color: var(--c-text);
  outline: none;
  font-family: inherit;
}

.emotion-input:focus {
  border-color: var(--c-brand);
}
</style>
