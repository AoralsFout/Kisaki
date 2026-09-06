<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps<{
  visible: boolean; title: string; message: string; confirmLabel: string
  cancelLabel?: string; alternativeLabel?: string; busy?: boolean; danger?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: []; alternative: [] }>()
const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)
const cancel = ref<HTMLButtonElement | null>(null)
let previous: HTMLElement | null = null
function keydown(event: KeyboardEvent) {
  if (!props.visible) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation()
    if (!props.busy) emit('cancel')
  }
  if (event.key === 'Tab') {
    const buttons = [...(panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!buttons.length) { event.preventDefault(); return }
    const first = buttons[0], last = buttons[buttons.length - 1]
    if (event.shiftKey && (document.activeElement === first || !panel.value?.contains(document.activeElement))) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !panel.value?.contains(document.activeElement))) {
      event.preventDefault(); first.focus()
    }
  }
}
watch(() => props.visible, async value => {
  if (value) {
    previous = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', keydown, true)
    await nextTick()
    cancel.value?.focus()
  } else {
    document.removeEventListener('keydown', keydown, true)
    if (previous?.isConnected) previous.focus()
  }
}, { immediate: true })
onUnmounted(() => document.removeEventListener('keydown', keydown, true))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="safety-overlay" data-pet-solid>
      <section ref="panel" class="safety-dialog" role="dialog" aria-modal="true" :aria-label="title" :aria-busy="busy">
        <h2>{{ title }}</h2>
        <p role="status">{{ message }}</p>
        <div class="safety-actions">
          <button ref="cancel" :disabled="busy" @click="emit('cancel')">{{ cancelLabel || t('common.cancel') }}</button>
          <button v-if="alternativeLabel" :disabled="busy" @click="emit('alternative')">{{ alternativeLabel }}</button>
          <button :class="['primary', { danger }]" :disabled="busy" @click="emit('confirm')">{{ busy ? t('safety.working') : confirmLabel }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.safety-overlay { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 20px; background: #0c0c1899; }
.safety-dialog { box-sizing: border-box; width: 460px; max-width: 100%; max-height: 90vh; overflow: auto; padding: 24px; border: 1px solid #3a3a5a; border-radius: 16px; background: #1a1a2e; color: #e0e0e0; font: 14px/1.6 'Segoe UI', sans-serif; box-shadow: 0 12px 40px #0008; }
h2 { font-size: 18px; margin: 0 0 12px; }
p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 24px; }
.safety-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
button { padding: 8px 12px; border: 1px solid #3a3a5a; border-radius: 8px; background: #252540; color: #e0e0e0; cursor: pointer; font: inherit; }
button.primary { background: #4a7aff; color: white; }
button.danger { background: #b83245; }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible { outline: 2px solid #9bb4ff; outline-offset: 3px; }
</style>
