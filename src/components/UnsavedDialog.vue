<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from './ConfirmDialog.vue'
import type { EditablePage } from '../utils/editableForm'
const { t } = useI18n()
const visible = ref(false)
const busy = ref(false)
const failed = ref(false)
let resolve: ((result: boolean) => void) | undefined
let page: EditablePage | null = null
onUnmounted(() => resolve?.(false))
function ask(target?: EditablePage | null): Promise<boolean> {
  if (visible.value || target?.saving) return Promise.resolve(false)
  if (!target?.dirty) return Promise.resolve(true)
  page = target
  failed.value = false
  visible.value = true
  return new Promise(r => { resolve = r })
}
function finish(result: boolean) {
  if (busy.value) return
  visible.value = false
  resolve?.(result)
  resolve = undefined
}
async function save() {
  if (busy.value) return
  busy.value = true
  try {
    const ok = await page?.save()
    busy.value = false
    if (ok && !page?.dirty) finish(true)
    else failed.value = true
  } catch { failed.value = true }
  finally { busy.value = false }
}
defineExpose({ ask })
</script>

<template>
  <ConfirmDialog :visible="visible" :busy="busy" :title="t('safety.unsavedTitle')"
    :message="failed ? t('safety.leaveFailed') : t('safety.unsavedBody')"
    :confirm-label="t('safety.saveLeave')" :cancel-label="t('safety.keepEditing')"
    :alternative-label="t('safety.discard')" @confirm="save" @cancel="finish(false)" @alternative="finish(true)" />
</template>
