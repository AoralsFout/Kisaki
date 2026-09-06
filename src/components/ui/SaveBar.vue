<script setup lang="ts">
/**
 * 设置页保存栏（阶段 4 共享组件）
 *
 * 统一「保存 + 附加操作 + 状态提示」的布局与文案状态：
 *   - 保存中显示「保存中…」，保存成功且无新输入显示「✓ 已保存」；
 *   - 附加操作按钮（如测试连接）放默认插槽；
 *   - 保存后的附加状态（如「已保存，连接未验证」）放 status 插槽；
 *   - 保存失败显示错误并在保存结束后保留（错误由父级 editableForm 提供）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseButton from './BaseButton.vue'

const props = withDefaults(defineProps<{
  saving?: boolean
  saved?: boolean
  dirty?: boolean
  error?: string
  /** 自定义保存按钮文案（默认「保存」） */
  saveText?: string
}>(), {
  saving: false,
  saved: false,
  dirty: false,
  error: '',
  saveText: '',
})

defineEmits<{ save: [] }>()

const { t } = useI18n()

const saveLabel = computed(() => {
  if (props.saving) return t('safety.saving')
  if (props.saved && !props.dirty) return t('common.saved')
  return props.saveText || t('common.save')
})
</script>

<template>
  <div class="form-actions">
    <BaseButton :disabled="saving" @click="$emit('save')">{{ saveLabel }}</BaseButton>
    <!-- 附加操作（测试连接、获取音色等） -->
    <slot />
    <!-- 保存后的附加状态说明 -->
    <slot name="status" />
  </div>
  <p v-if="error" class="status-error" role="alert">{{ t('safety.saveFailed', { message: error }) }}</p>
</template>
