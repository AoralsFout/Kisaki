import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useEditableForm } from '../editableForm'

describe('editable form persistence', () => {
  it('keeps changed input dirty on failure and permits retry', async () => {
    const input = ref({ model: 'old' })
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
    const form = useEditableForm(() => input.value, persist)
    input.value.model = 'new'
    expect(await form.save()).toBe(false)
    expect(form.error.value).toBe('disk full')
    expect(form.dirty.value).toBe(true)
    expect(input.value.model).toBe('new')
    expect(await form.save()).toBe(true)
    expect(form.dirty.value).toBe(false)
    expect(form.error.value).toBe('')
  })

  it('does not mark edits made during saving as saved or submit twice', async () => {
    const input = ref({ model: 'old' })
    let finish!: () => void
    const persist = vi.fn(() => new Promise<void>(r => { finish = r }))
    const form = useEditableForm(() => input.value, persist)
    input.value.model = 'first'
    const save = form.save()
    expect(form.saving.value).toBe(true)
    input.value.model = 'second'
    expect(await form.save()).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith({ model: 'first' })
    finish()
    expect(await save).toBe(false)
    expect(form.dirty.value).toBe(true)
    expect(form.saving.value).toBe(false)
  })
})
