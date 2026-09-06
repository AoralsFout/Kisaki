import { computed, ref } from 'vue'

export interface EditablePage {
  dirty: boolean
  saving: boolean
  save: () => Promise<boolean>
}

/** Only advance the saved baseline for the exact snapshot that was persisted. */
export function useEditableForm<T>(read: () => T, persist: (value: T) => Promise<void> | void) {
  const baseline = ref(JSON.stringify(read()))
  const saving = ref(false)
  const error = ref('')
  const saved = ref(false)
  const dirty = computed(() => JSON.stringify(read()) !== baseline.value)
  function reset() { baseline.value = JSON.stringify(read()); saved.value = false }
  async function save(): Promise<boolean> {
    if (saving.value) return false
    saving.value = true
    error.value = ''
    saved.value = false
    const snapshot = JSON.stringify(read())
    try {
      await persist(JSON.parse(snapshot) as T)
      baseline.value = snapshot
      saved.value = true
      return !dirty.value
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally { saving.value = false }
  }
  return { dirty, saving, error, saved, reset, save }
}
