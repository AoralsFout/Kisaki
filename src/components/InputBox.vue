<script setup lang="ts">
/**
 * 对话输入框组件
 * - 支持回车发送
 * - 支持 Shift+Enter 换行
 * - 支持粘贴或选择图片，发送给图像识别模型
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  createImageAttachment,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  validateImageFiles,
} from '../ai'
import type { ChatInputPayload, ImageAttachment, ImageValidationError } from '../ai'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
  placeholder?: string
  disabled?: boolean
  /** 会话草稿标识；草稿仅保留在当前窗口内存中 */
  draftKey?: string
  validDraftKeys?: string[]
  submit?: (payload: ChatInputPayload) => Promise<boolean>
  /** 初始文本 */
  modelValue?: string
  /** 头部标题（当前会话名）；缺省回退通用文案 */
  title?: string
  /** 上下文预算占用（0~1）；提供时在底栏显示圆环进度 */
  contextUtilization?: number | null
  /** 圆环悬浮提示的详细信息 */
  contextDetail?: string
}>(), {
  visible: false,
  placeholder: '',
  disabled: false,
  draftKey: 'default',
  modelValue: '',
  title: '',
  contextUtilization: null,
  contextDetail: '',
})

const emit = defineEmits<{
  send: [payload: ChatInputPayload]
  'update:modelValue': [text: string]
  close: []
}>()

const inputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
type Draft = { text: string; images: ImageAttachment[]; error: string; adding: boolean; sending: boolean }
const drafts = reactive(new Map<string, Draft>())
drafts.set(props.draftKey, { text: props.modelValue, images: [], error: '', adding: false, sending: false })
const draft = computed(() => {
  if (!drafts.has(props.draftKey)) {
    drafts.set(props.draftKey, { text: '', images: [], error: '', adding: false, sending: false })
  }
  return drafts.get(props.draftKey)!
})
const inputText = computed({ get: () => draft.value.text, set: v => { draft.value.text = v } })
const images = computed({ get: () => draft.value.images, set: v => { draft.value.images = v } })
const imageError = computed({ get: () => draft.value.error, set: v => { draft.value.error = v } })
const isAddingImages = computed(() => draft.value.adding)
watch(() => props.validDraftKeys, keys => {
  if (!keys) return
  for (const key of drafts.keys()) if (!keys.includes(key)) drafts.delete(key)
}, { deep: true })
const isSending = computed(() => draft.value.sending)
const hasContent = computed(() => Boolean(inputText.value.trim()) || images.value.length > 0)

// 同步 v-model
watch(() => props.modelValue, (v) => {
  inputText.value = v
})

watch(inputText, (v) => {
  emit('update:modelValue', v)
})

// 关闭只隐藏，文字和附件随会话保留。
watch(() => props.visible, (v) => {
  if (v) {
    setTimeout(() => inputRef.value?.focus(), 100)
  }
})

function handleKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

async function sendMessage() {
  const target = draft.value
  const text = target.text.trim()
  if (!hasContent.value || props.disabled || target.adding || target.sending) return
  const payload = { text, images: [...target.images] }
  const originalText = target.text
  const originalImages = [...target.images]
  target.error = ''
  target.sending = true
  try {
    const accepted = props.submit ? await props.submit(payload) : (emit('send', payload), true)
    if (!accepted) { target.error = t('safety.sendFailed'); return }
    if (target.text === originalText && target.images.length === originalImages.length && target.images.every((img, i) => img.id === originalImages[i].id)) {
      target.text = ''; target.images = []; target.error = ''
    }
  } catch { target.error = t('safety.sendFailed') }
  finally { target.sending = false }
}

function validationMessage(error: ImageValidationError): string {
  const sizes = {
    max: Math.round(MAX_IMAGE_BYTES / 1024 / 1024),
    total: Math.round(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024),
    count: MAX_IMAGE_COUNT,
  }
  return t(`chat.input.imageErrors.${error}`, sizes)
}

async function addFiles(files: Iterable<File>) {
  if (props.disabled || isAddingImages.value || isSending.value) return
  // 异步读图完成时仍写回原会话，避免切换会话后附件串入。
  const target = draft.value
  imageError.value = ''
  const result = validateImageFiles(files, images.value)
  if (result.error) imageError.value = validationMessage(result.error)
  if (result.accepted.length === 0) return

  target.adding = true
  try {
    const added = await Promise.all(result.accepted.map(createImageAttachment))
    target.images.push(...added)
  } catch {
    target.error = t('chat.input.imageErrors.readFailed')
  } finally {
    target.adding = false
  }
}

function handlePaste(event: ClipboardEvent) {
  const directFiles = Array.from(event.clipboardData?.files ?? [])
  const itemFiles = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  const files = (directFiles.length ? directFiles : itemFiles)
    .filter(file => file.type.startsWith('image/'))
  if (files.length === 0) return
  if (!event.clipboardData?.getData('text/plain')) event.preventDefault()
  void addFiles(files)
}

function handleFilePicked(event: Event) {
  const target = event.target as HTMLInputElement
  void addFiles(Array.from(target.files ?? []))
  target.value = ''
}

function removeImage(id: string) {
  images.value = images.value.filter(image => image.id !== id)
  imageError.value = ''
}

function handleClose() {
  emit('close')
}
</script>

<template>
  <div class="input-overlay" @click.self="handleClose">
    <div class="input-container" @click.stop data-pet-solid>
      <div class="input-header">
        <span class="input-title"><i class="fas fa-comment"></i> {{ title || t('chat.input.title') }}</span>
        <button class="btn-close" @click="handleClose" :aria-label="t('chat.input.closeAria')">✕</button>
      </div>
      <textarea ref="inputRef" v-model="inputText" class="input-field"
        :placeholder="placeholder || t('chat.input.placeholder')" :disabled="disabled || isSending" rows="3"
        @keydown="handleKeydown" @paste="handlePaste"></textarea>
      <div v-if="images.length" class="image-list" :aria-label="t('chat.input.imagesLabel')">
        <div v-for="image in images" :key="image.id" class="image-preview">
          <img :src="image.dataUrl" :alt="image.name" />
          <button type="button" class="btn-remove-image" :disabled="disabled || isSending" :aria-label="t('chat.input.removeImage', { name: image.name })"
            @click="removeImage(image.id)">✕</button>
        </div>
      </div>
      <p v-if="imageError" class="image-error" role="alert">{{ imageError }}</p>
      <div class="input-footer">
        <div class="input-actions">
          <input ref="fileInputRef" class="file-input" type="file"
            accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="handleFilePicked" />
          <button type="button" class="btn-image" :disabled="disabled || isSending || isAddingImages || images.length >= MAX_IMAGE_COUNT"
            :title="t('chat.input.chooseImageHint', { count: MAX_IMAGE_COUNT })"
            :aria-label="t('chat.input.chooseImage')" @click="fileInputRef?.click()">
            <i class="fas fa-image"></i>
            <span>{{ t('chat.input.chooseImage') }}</span>
          </button>
        </div>
        <div class="footer-right">
          <!-- 上下文用量圆环：悬浮展示详细预算信息 -->
          <svg v-if="contextUtilization !== null" class="context-ring" viewBox="0 0 22 22" width="22" height="22"
            role="img" :aria-label="contextDetail" :title="contextDetail">
            <circle class="ring-track" cx="11" cy="11" r="9" fill="none" stroke-width="3" />
            <circle class="ring-value" cx="11" cy="11" r="9" fill="none" stroke-width="3"
              :stroke-dasharray="`${2 * Math.PI * 9}`"
              :stroke-dashoffset="`${2 * Math.PI * 9 * (1 - Math.min(Math.max(contextUtilization, 0), 1))}`"
              :class="{ near: contextUtilization >= 0.9 }"
              transform="rotate(-90 11 11)" stroke-linecap="round" />
            <text class="ring-label" x="11" y="11" text-anchor="middle" dominant-baseline="central">{{ Math.round(contextUtilization * 100) }}%</text>
          </svg>
          <button class="btn-send" :disabled="!hasContent || disabled || isSending || isAddingImages" @click="sendMessage"
            :aria-label="t('chat.input.sendAria')">{{ t('chat.input.send') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.input-overlay {
  width: 100%;
  display: flex;
  justify-content: center;
  padding: 0 16px 16px;
  box-sizing: border-box;
}

.input-container {
  width: 100%;
  max-width: 500px;
  background: rgba(30, 30, 40, 0.92);
  border-radius: 16px;
  padding: 12px;
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.input-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.input-title {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
}

.btn-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}

.input-field {
  width: 100%;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 10px 12px;
  color: white;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
}

.input-field:focus {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.12);
}

.input-field::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.image-list {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  overflow-x: auto;
  padding: 2px;
}

.image-preview {
  position: relative;
  width: 64px;
  height: 64px;
  flex: 0 0 64px;
  overflow: hidden;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
}

.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.btn-remove-image {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--c-text-bright);
  background: rgba(10, 10, 16, 0.78);
  cursor: pointer;
}

.image-error {
  margin: 6px 2px 0;
  color: #ff9f9f;
  font-size: 11px;
}

.input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.input-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 上下文用量圆环 */
.context-ring .ring-track {
  stroke: rgba(255, 255, 255, 0.15);
}

.context-ring .ring-value {
  stroke: var(--c-brand);
  transition: stroke-dashoffset 0.3s ease;
}

.context-ring .ring-value.near {
  stroke: var(--c-warn);
}

.context-ring .ring-label {
  fill: rgba(255, 255, 255, 0.75);
  font-size: 7px;
  font-weight: 600;
}

.file-input {
  display: none;
}

.btn-image {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  font-size: 11px;
}

.btn-image:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.13);
}

.btn-image:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-send {
  background: linear-gradient(135deg, #667eea, #764ba2);
  border: none;
  color: white;
  padding: 6px 20px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.2s;
  font-weight: 500;
}

.btn-send:hover:not(:disabled) {
  opacity: 0.85;
}

.btn-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
