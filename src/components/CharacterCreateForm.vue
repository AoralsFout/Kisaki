<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  CharacterCreationInput,
  CharacterCreationPorts,
  CharacterCreationRender,
  CharacterCreationValidationErrorCode,
  Live2DModelSelection,
} from '../application/character/characterCreation'
import { createCharacter } from '../application/character/characterCreation'

const props = withDefaults(defineProps<{
  existingIds: readonly string[]
  ports: CharacterCreationPorts
  modelPicker?: () => Promise<Live2DModelSelection | string | null>
}>(), {
  modelPicker: undefined,
})

const emit = defineEmits<{
  (event: 'created', characterId: string): void
  (event: 'close'): void
}>()

const id = ref('')
const name = ref('')
const description = ref('')
const render = ref<CharacterCreationRender>('illustration')
const live2dModel = ref<Live2DModelSelection | null>(null)
const errors = ref<Record<string, CharacterCreationValidationErrorCode>>({})
const errorMessage = ref('')
const busy = ref(false)

const modelLabel = computed(() => live2dModel.value?.directory ?? '')

function input(): CharacterCreationInput {
  return {
    id: id.value,
    name: name.value,
    description: description.value,
    render: render.value,
    live2dModel: live2dModel.value,
  }
}

async function pickModel() {
  if (!props.modelPicker || busy.value) return
  try {
    const selected = await props.modelPicker()
    if (selected === null) return
    live2dModel.value = typeof selected === 'string' ? { directory: selected } : selected
    delete errors.value.live2dModel
    errorMessage.value = ''
  } catch (error) {
    // 选择器失败也是可见诊断，但不得清空用户已有输入。
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function errorText(field: CharacterCreationValidationErrorCode | undefined): string {
  switch (field) {
    case 'required': return '必填项'
    case 'invalid-format': return 'ID 必须以小写字母开头，仅含小写字母、数字和下划线'
    case 'already-exists': return '该角色 ID 已存在'
    case 'model-required': return '请选择 Live2D 模型文件夹'
    case 'model-file-missing': return '模型文件夹内缺少 *.model3.json'
    default: return ''
  }
}

async function submit() {
  if (busy.value) return
  busy.value = true
  errors.value = {}
  errorMessage.value = ''
  try {
    const result = await createCharacter(input(), { existingIds: props.existingIds }, props.ports)
    errors.value = { ...result.validation.errors }
    if (!result.success) {
      errorMessage.value = result.error?.reason ?? '创建失败'
      return
    }
    const createdId = result.character!.id
    id.value = ''
    name.value = ''
    description.value = ''
    render.value = 'illustration'
    live2dModel.value = null
    emit('created', createdId)
    emit('close')
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) emit('close')
}

defineExpose({ submit, busy, reset: () => {
  id.value = ''
  name.value = ''
  description.value = ''
  render.value = 'illustration'
  live2dModel.value = null
  errors.value = {}
  errorMessage.value = ''
} })
</script>

<template>
  <form class="character-create-form" data-testid="character-create-form" @submit.prevent="submit">
    <label class="create-field">
      <span>ID</span>
      <input v-model="id" data-testid="character-create-id" autocomplete="off" />
      <small v-if="errors.id" role="alert">{{ errorText(errors.id) }}</small>
    </label>
    <label class="create-field">
      <span>名称</span>
      <input v-model="name" data-testid="character-create-name" autocomplete="off" />
    </label>
    <label class="create-field">
      <span>描述</span>
      <textarea v-model="description" data-testid="character-create-description" />
    </label>
    <fieldset class="create-field">
      <legend>渲染方式</legend>
      <label><input v-model="render" type="radio" value="illustration" /> 静态立绘</label>
      <label><input v-model="render" type="radio" value="live2d" /> Live2D</label>
    </fieldset>
    <div v-if="render === 'live2d'" class="create-field">
      <span>模型</span>
      <button type="button" :disabled="busy || !modelPicker" @click="pickModel">选择模型文件夹</button>
      <span v-if="modelLabel" data-testid="character-create-model">{{ modelLabel }}</span>
      <small v-if="errors.live2dModel" role="alert">{{ errorText(errors.live2dModel) }}</small>
    </div>
    <p v-if="errorMessage" role="alert" data-testid="character-create-error">{{ errorMessage }}</p>
    <div class="create-actions">
      <button type="button" :disabled="busy" @click="close">取消</button>
      <button type="submit" :disabled="busy">{{ busy ? '创建中…' : '确认创建' }}</button>
    </div>
  </form>
</template>

<style scoped>
.character-create-form { display: grid; gap: 12px; }
.create-field { display: grid; gap: 6px; }
.create-field span, .create-field legend { color: #b9b7d4; font-size: 12px; }
.create-field input, .create-field textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid #3a3a5c; border-radius: 5px; background: #15152b; color: #eee; }
.create-field textarea { min-height: 64px; resize: vertical; }
.create-field small, [role='alert'] { color: #ff8f9a; font-size: 12px; }
.create-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
