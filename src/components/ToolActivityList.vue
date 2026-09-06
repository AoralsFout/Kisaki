<script setup lang="ts">
/**
 * 工具调用过程列表 —— 主窗口右侧实时展示 AI 正在调用哪些工具
 *
 * 仅在处理时自动显现（chat.showToolActivity 控制），回复完成后延时淡出。
 * 纯展示：pointer-events:none、不加 data-pet-solid，绝不拦截桌面点击（穿透友好）。
 * 数据来自 chat store 的 toolActivities（临时态，不持久化）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { toolIcon } from '../agent/toolMeta'

const { t, te } = useI18n()
const chat = useChatStore()

const visible = computed(() => chat.showToolActivity && chat.toolActivities.length > 0)

/** 工具可读名：有 i18n 文案用文案，否则兜底显示原始工具名 */
function toolLabel(name: string): string {
  const key = `app.tools.${name}`
  return te(key) ? t(key) : name
}
</script>

<template>
  <Transition name="tools-fade">
    <div v-if="visible" class="tool-activity">
      <TransitionGroup name="tools-list" tag="div" class="ta-list">
        <div
          v-for="a in chat.toolActivities"
          :key="a.id"
          class="ta-item"
          :class="a.status"
        >
          <i class="ta-icon fas" :class="toolIcon(a.name)"></i>
          <span class="ta-name">{{ toolLabel(a.name) }}</span>
          <i
            class="ta-status fas"
            :class="{
              'fa-spinner fa-spin': a.status === 'running',
              'fa-check': a.status === 'done',
              'fa-xmark': a.status === 'error',
              'fa-ban': a.status === 'skipped',
            }"
          ></i>
        </div>
      </TransitionGroup>
    </div>
  </Transition>
</template>

<style scoped>
.tool-activity {
  /* 就近展示：贴在底部交互区上方（输入/确认卡附近），处理时自动显现 */
  position: absolute;
  right: 8px;
  bottom: 140px;
  z-index: 60;
  max-height: 46vh;
  overflow: hidden;
  pointer-events: none; /* 纯展示，不拦截鼠标 */
}

.ta-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.ta-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 150px;
  padding: 6px 9px;
  background: rgba(20, 20, 35, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  box-sizing: border-box;
}

.ta-icon {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}

.ta-name {
  flex: 1;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ta-status {
  font-size: 11px;
  flex-shrink: 0;
  width: 13px;
  text-align: center;
}

/* 状态配色：执行中=主题色，完成=绿，失败=红，跳过=灰 */
.ta-item.running .ta-status { color: #667eea; }
.ta-item.done .ta-status { color: #5fbf7f; }
.ta-item.error .ta-status { color: #e06464; }
.ta-item.skipped .ta-status { color: #9a9aa8; }
.ta-item.done .ta-icon { color: rgba(255, 255, 255, 0.85); }
.ta-item.error { border-color: rgba(224, 100, 100, 0.35); }
.ta-item.skipped { opacity: 0.7; }

/* 整体淡入淡出 */
.tools-fade-enter-active,
.tools-fade-leave-active {
  transition: opacity 0.3s ease;
}
.tools-fade-enter-from,
.tools-fade-leave-to {
  opacity: 0;
}

/* 列表项逐条进出（右侧滑入 + 淡入） */
.tools-list-enter-active,
.tools-list-leave-active {
  transition: all 0.25s ease;
}
.tools-list-enter-from,
.tools-list-leave-to {
  transform: translateX(20px);
  opacity: 0;
}
</style>
