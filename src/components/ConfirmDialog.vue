<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalFocus } from '../utils/modalFocus'
const props = defineProps<{
  visible: boolean; title: string; message: string; confirmLabel: string
  cancelLabel?: string; alternativeLabel?: string; busy?: boolean; danger?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: []; alternative: [] }>()
const { t } = useI18n()
const panel = ref<HTMLElement | null>(null)
const cancel = ref<HTMLButtonElement | null>(null)
const titleId = useId()
const messageId = useId()
useModalFocus(
  () => props.visible,
  panel,
  () => { if (!props.busy) emit('cancel') },
  cancel,
)
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="safety-overlay" data-pet-solid>
      <section ref="panel" class="safety-dialog" role="dialog" aria-modal="true" tabindex="-1"
        :aria-labelledby="titleId" :aria-describedby="messageId" :aria-busy="busy">
        <h2 :id="titleId">{{ title }}</h2>
        <p :id="messageId" role="status" data-selectable>{{ message }}</p>
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
.safety-overlay { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 20px; background: var(--c-scrim-overlay); }
.safety-dialog { box-sizing: border-box; width: 460px; max-width: 100%; max-height: 90vh; overflow: auto; padding: var(--space-6); border: 1px solid var(--c-border-strong); border-radius: var(--radius-overlay); background: var(--c-panel); color: var(--c-text); font: var(--fs-body)/1.6 'Segoe UI', sans-serif; box-shadow: var(--shadow-overlay); }
h2 { font-size: var(--fs-title); margin: 0 0 var(--space-3); }
p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--space-6); }
.safety-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; }
button { padding: var(--space-2) var(--space-3); border: 1px solid var(--c-border-strong); border-radius: var(--radius-control); background: var(--c-control); color: var(--c-text); cursor: pointer; font: inherit; }
button.primary { background: var(--c-brand); color: var(--c-text-bright); }
button.danger { background: var(--c-error); }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible { outline: 2px solid var(--c-brand-text); outline-offset: 3px; }
</style>
