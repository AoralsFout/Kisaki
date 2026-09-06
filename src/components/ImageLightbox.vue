<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalFocus } from '../utils/modalFocus'

const props = withDefaults(defineProps<{
  visible: boolean
  src?: string
  alt?: string
}>(), {
  src: '',
  alt: '',
})

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const titleId = useId()

useModalFocus(() => props.visible, panelRef, () => emit('close'), closeRef)
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="lightbox-overlay" data-pet-solid @click.self="emit('close')">
      <section ref="panelRef" class="lightbox" role="dialog" aria-modal="true"
        :aria-labelledby="titleId" tabindex="-1">
        <header class="lightbox-header">
          <div>
            <h2 :id="titleId">{{ t('chat.history.imageViewerTitle') }}</h2>
            <p v-if="alt" data-selectable>{{ alt }}</p>
          </div>
          <button ref="closeRef" type="button" class="lightbox-close"
            :aria-label="t('common.close')" @click="emit('close')">✕</button>
        </header>
        <div class="lightbox-stage">
          <img :src="src" :alt="alt" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: rgba(8, 8, 18, 0.86);
  backdrop-filter: blur(8px);
}

.lightbox {
  width: min(920px, 96vw);
  max-height: 94vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-overlay);
  background: var(--c-bg);
  color: var(--c-text);
  box-shadow: var(--shadow-overlay);
}

.lightbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--c-border);
}

h2 {
  margin: 0;
  font-size: var(--fs-body);
}

p {
  margin: var(--space-1) 0 0;
  color: var(--c-text-secondary);
  font: var(--fs-aux)/1.4 var(--font-mono);
  overflow-wrap: anywhere;
}

.lightbox-close {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-control);
  color: var(--c-text);
  cursor: pointer;
}

.lightbox-stage {
  min-height: 0;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  overflow: auto;
  background:
    linear-gradient(45deg, rgba(255, 255, 255, 0.025) 25%, transparent 25%) 0 0 / 20px 20px,
    linear-gradient(-45deg, rgba(255, 255, 255, 0.025) 25%, transparent 25%) 0 10px / 20px 20px;
}

.lightbox-stage img {
  display: block;
  max-width: 100%;
  max-height: calc(94vh - 92px);
  object-fit: contain;
}
</style>
