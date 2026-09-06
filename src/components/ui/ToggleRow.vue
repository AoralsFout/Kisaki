<script setup lang="ts">
/**
 * 开关行（阶段 4 共享组件）
 *
 * 「标题 + 说明 + 状态开关」的统一行布局。
 * 开关用 role="switch" 表达明确状态，点击整行开关切换。
 */
import { computed } from 'vue'

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

function toggle() {
  if (!props.disabled) emit('update:checked', !props.checked)
}
</script>

<template>
  <div class="form-group">
    <div class="toggle-row">
      <label class="toggle-label">
        <span class="toggle-label-text">{{ title }}</span>
        <span v-if="desc" class="toggle-label-desc">{{ desc }}</span>
      </label>
      <button :class="['toggle-switch', { active: checked }]" :disabled="disabled" @click="toggle"
        role="switch" :aria-checked="checked">
        <span class="toggle-knob"></span>
      </button>
    </div>
  </div>
</template>
