<script setup lang="ts">
/**
 * 对话输入框组件
 * - 支持回车发送
 * - 支持 Shift+Enter 换行
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  visible?: boolean
  placeholder?: string
  disabled?: boolean
  /** 初始文本 */
  modelValue?: string
}>(), {
  visible: false,
  placeholder: '',
  disabled: false,
  modelValue: '',
})

const emit = defineEmits<{
  send: [text: string]
  'update:modelValue': [text: string]
  close: []
}>()

const inputRef = ref<HTMLTextAreaElement | null>(null)
const inputText = ref(props.modelValue)

// 同步 v-model
watch(() => props.modelValue, (v) => {
  inputText.value = v
})

watch(inputText, (v) => {
  emit('update:modelValue', v)
})

// 显示时自动聚焦，关闭时清空输入
watch(() => props.visible, (v) => {
  if (v) {
    setTimeout(() => inputRef.value?.focus(), 100)
  } else {
    inputText.value = ''
  }
})

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

function sendMessage() {
  const text = inputText.value.trim()
  if (!text || props.disabled) return
  emit('send', text)
  inputText.value = ''
}

function handleClose() {
  emit('close')
}
</script>

<template>
  <div class="input-overlay" @click.self="handleClose">
      <div class="input-container" @click.stop data-pet-solid>
        <div class="input-header">
          <span class="input-title"><i class="fas fa-comment"></i> {{ t('chat.input.title') }}</span>
          <button class="btn-close" @click="handleClose" :aria-label="t('chat.input.closeAria')">✕</button>
        </div>
        <textarea
          ref="inputRef"
          v-model="inputText"
          class="input-field"
          :placeholder="placeholder || t('chat.input.placeholder')"
          :disabled="disabled"
          rows="3"
          @keydown="handleKeydown"
        ></textarea>
        <div class="input-footer">
          <span class="hint">{{ t('chat.input.hint') }}</span>
          <button
            class="btn-send"
            :disabled="!inputText.trim() || disabled"
            @click="sendMessage"
            :aria-label="t('chat.input.sendAria')"
          >
            {{ t('chat.input.send') }}
          </button>
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

.input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
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
