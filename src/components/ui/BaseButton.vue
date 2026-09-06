<script setup lang="ts">
/**
 * 统一按钮（阶段 4 共享组件）
 *
 * 语义变体：
 *   - primary   实色主按钮（品牌蓝）
 *   - secondary 描边浅底次按钮
 *   - danger    危险按钮
 * 圆角为控件级 8px；胶囊形仅用于标签类元素，不在按钮上使用。
 * 其余属性（type、class、aria-* 等）透传到原生 button。
 */
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
}>(), {
  variant: 'primary',
  disabled: false,
})
</script>

<template>
  <button class="btn" :class="`btn-${variant}`" :disabled="disabled">
    <slot />
  </button>
</template>
