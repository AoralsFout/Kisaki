<script setup lang="ts">
/**
 * 开关行（阶段 4 共享组件）
 *
 * 「标题 + 说明 + 状态开关」的统一行布局。
 * 开关用 role="switch" 表达明确状态，点击整行开关切换。
 */
import { computed, useId } from 'vue'

const props = withDefaults(defineProps<{
  title: string
  desc?: string
  checked?: boolean
  disabled?: boolean
}>(), {
  desc: '',
  checked: false,
  disabled: false,
})

const emit = defineEmits<{ 'update:checked': [value: boolean] }>()

const checked = computed(() => props.checked)
const titleId = useId()
const descId = useId()

function toggle() {
  if (!props.disabled) emit('update:checked', !props.checked)
}
</script>

<template>
  <div class="form-group">
    <div class="toggle-row">
      <div class="toggle-label">
        <span :id="titleId" class="toggle-label-text">{{ title }}</span>
        <span v-if="desc" :id="descId" class="toggle-label-desc">{{ desc }}</span>
      </div>
      <button :class="['toggle-switch', { active: checked }]" :disabled="disabled" @click="toggle"
        role="switch" :aria-checked="checked" :aria-labelledby="titleId"
        :aria-describedby="desc ? descId : undefined">
        <span class="toggle-knob" aria-hidden="true"></span>
      </button>
    </div>
  </div>
</template>
