<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { adjustCharacterOpacity } from '../character/opacity'

const opacity = defineModel<number>('opacity', { required: true })
const { t } = useI18n()
const opacityPercent = computed(() => Math.round(opacity.value * 100))

function onWheel(event: WheelEvent) {
  opacity.value = adjustCharacterOpacity(opacity.value, event.deltaY)
}

function onKeydown(event: KeyboardEvent) {
  const deltaY = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!deltaY) return
  event.preventDefault()
  event.stopPropagation()
  opacity.value = adjustCharacterOpacity(opacity.value, deltaY)
}
</script>

<template>
  <button class="tool-btn" type="button"
    :aria-label="t('app.aria.adjustCharacterOpacity', { value: opacityPercent })"
    :title="t('app.aria.adjustCharacterOpacity', { value: opacityPercent })"
    aria-keyshortcuts="ArrowUp ArrowDown"
    @wheel.prevent.stop="onWheel"
    @keydown="onKeydown">
    <i class="fas fa-sun btn-icon"></i>
    <span class="btn-label">{{ t('app.toolbar.adjustOpacity') }}</span>
  </button>
</template>
