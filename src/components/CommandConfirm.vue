<script setup lang="ts">
/**
 * 命令执行确认卡 —— AI 调用 execute_command 时弹出
 *
 * 独立于 ToolConfirm（不共享 auto-allow 逻辑），每次执行都必须确认。
 * 展示：警告图标 + 描述 + 完整命令 + 工作目录 + 超时。
 * 两个动作：允许 / 拒绝（无「本会话自动允许」选项）。
 * 数据来自 chat store 的 pendingCommandConfirm（非空即显示）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { toolIcon } from '../agent/toolMeta'

const { t, te } = useI18n()
const chat = useChatStore()
const sessionStore = useSessionStore()

const pc = computed(() => chat.pendingCommandConfirm)
const workspaceRoot = computed(() => sessionStore.currentSession?.workspaceRoot ?? '')

/** 工具可读名：有 i18n 文案用文案，否则兜底原始工具名 */
function toolLabel(name: string): string {
  const key = `app.tools.${name}`
  return te(key) ? t(key) : name
}

/** 超时秒数（从参数取，默认 30） */
const timeoutSecs = computed(() => {
  const a = pc.value?.args
  return a?.timeout_secs != null ? Number(a.timeout_secs) : 30
})

/** 命令文本 */
const commandText = computed(() => String(pc.value?.args?.command ?? ''))

/** 描述文本 */
const descriptionText = computed(() => String(pc.value?.args?.description ?? ''))
</script>

<template>
  <Transition name="confirm-fade">
    <div v-if="pc" class="command-confirm" data-pet-solid>
      <!-- 头部：警告图标 + 标题 -->
      <div class="cc-head">
        <i class="cc-icon fas fa-triangle-exclamation"></i>
        <div class="cc-headtext">
          <div class="cc-title">{{ t('app.confirm.command.title') }}</div>
          <div class="cc-sub">
            <i class="fas" :class="toolIcon(pc.toolName)"></i>
            <span class="cc-tool">{{ toolLabel(pc.toolName) }}</span>
          </div>
        </div>
      </div>

      <!-- 描述（模型生成，仅供参考，不可信） -->
      <div v-if="descriptionText" class="cc-desc">
        <div class="cc-desc-label">{{ t('app.confirm.command.untrustedDesc') }}</div>
        {{ descriptionText }}
      </div>

      <!-- 命令代码块 -->
      <div class="cc-command-wrap">
        <pre class="cc-command"><code>{{ commandText }}</code></pre>
      </div>

      <!-- 元信息 -->
      <div class="cc-meta">
        <div class="cc-meta-item">
          <i class="fas fa-folder-open"></i>
          <span :title="workspaceRoot">{{ workspaceRoot ? workspaceRoot.split(/[/\\]+/).filter(Boolean).pop() : t('app.confirm.command.noWorkspace') }}</span>
        </div>
        <div class="cc-meta-item">
          <i class="fas fa-hourglass-half"></i>
          <span>{{ t('app.confirm.command.timeout', { sec: timeoutSecs }) }}</span>
        </div>
      </div>

      <!-- 完整权限风险提示 -->
      <div class="cc-warning cc-warning-danger">
        <i class="fas fa-skull-crossbones"></i>
        <span>{{ t('app.confirm.command.fullAccess') }}</span>
      </div>

      <!-- 回档风险提示 -->
      <div class="cc-warning">
        <i class="fas fa-triangle-exclamation"></i>
        <span>{{ t('app.confirm.command.noRollback') }}</span>
      </div>

      <!-- 动作：仅拒绝和允许，无自动允许 -->
      <div class="cc-actions">
        <button class="cc-btn cc-reject" @click="chat.resolveCommandConfirm('reject')">
          <i class="fas fa-xmark"></i> {{ t('app.confirm.reject') }}
        </button>
        <button class="cc-btn cc-allow" @click="chat.resolveCommandConfirm('allow')">
          <i class="fas fa-terminal"></i> {{ t('app.confirm.command.execute') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.command-confirm {
  width: 100%;
  max-width: 460px;
  margin-bottom: 8px;
  background: rgba(20, 20, 35, 0.96);
  border: 1px solid rgba(255, 180, 40, 0.25);
  border-radius: 14px;
  padding: 12px 14px;
  backdrop-filter: blur(16px);
  box-sizing: border-box;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

/* 头部 */
.cc-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cc-icon {
  font-size: 18px;
  color: #f0b85c;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
}

.cc-headtext {
  min-width: 0;
  flex: 1;
}

.cc-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.cc-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 11px;
  color: #b9a0ff;
}

.cc-sub .fas {
  font-size: 11px;
}

/* 描述 */
.cc-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  margin: 8px 0 6px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  border-left: 2px solid #f0b85c;
}

.cc-desc-label {
  font-size: 10px;
  color: #f0b85c;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 2px;
}

/* 命令代码块 */
.cc-command-wrap {
  background: rgba(0, 0, 0, 0.4);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 6px 0;
}

.cc-command {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  font-family: 'Consolas', 'Courier New', monospace;
  color: #b7e6c4;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: auto;
}

.cc-command::-webkit-scrollbar { width: 5px; height: 5px; }
.cc-command::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 4px; }

/* 元信息 */
.cc-meta {
  display: flex;
  gap: 16px;
  margin: 6px 0 10px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

.cc-meta-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.cc-meta-item .fas {
  font-size: 11px;
  width: 12px;
  text-align: center;
}

/* 回档风险提示 */
.cc-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 10px;
  padding: 6px 8px;
  background: rgba(240, 184, 92, 0.1);
  border: 1px solid rgba(240, 184, 92, 0.2);
  border-radius: 6px;
  font-size: 11px;
  color: #f0b85c;
  line-height: 1.4;
}

.cc-warning .fas {
  font-size: 11px;
  flex-shrink: 0;
}

.cc-warning-danger {
  background: rgba(224, 100, 100, 0.12);
  border-color: rgba(224, 100, 100, 0.28);
  color: #f0a0a0;
}

/* 动作按钮 */
.cc-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.cc-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
}

.cc-reject {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.1);
}
.cc-reject:hover { background: rgba(224, 100, 100, 0.2); color: #f0bcbc; }

.cc-allow {
  background: #f0b85c;
  color: #1a1a2e;
  font-weight: 600;
}
.cc-allow:hover { opacity: 0.88; }

/* 动画（与 ToolConfirm 一致） */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
