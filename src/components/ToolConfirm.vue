<script setup lang="ts">
/**
 * 文件操作确认卡 —— AI 调用「改文件」工具且未开启自动执行时弹出
 *
 * 展示：工具图标 + 可读名 + 相对路径 + 一句摘要 + 行级 diff 预览。
 * 三个动作：允许 / 拒绝 / 本会话自动允许（→ chat.resolveConfirm）。
 * 数据来自 chat store 的 pendingConfirm（非空即显示）。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../stores/chat'
import type { PendingConfirm } from '../stores/chat'
import { useSessionStore } from '../stores/session'
import { toolIcon } from '../agent/toolMeta'
import { lineDiff, sliceLines, type DiffPreview } from '../utils/diff'
import { createLogger } from '../utils/logger'

const log = createLogger('ToolConfirm')
const { t, te } = useI18n()
const chat = useChatStore()
const sessionStore = useSessionStore()

const pc = computed(() => chat.pendingConfirm)
const diff = ref<DiffPreview | null>(null)
const loadingDiff = ref(false)
/** 原文件无法读取（按新建处理） */
const unreadable = ref(false)

/** 工具可读名：有 i18n 文案用文案，否则兜底原始工具名 */
function toolLabel(name: string): string {
  const key = `app.tools.${name}`
  return te(key) ? t(key) : name
}

/** 操作摘要文案 */
const summary = computed(() => {
  const p = pc.value
  if (!p) return ''
  const a = p.args || {}
  switch (p.toolName) {
    case 'write_file': return t('app.confirm.summary.write', { n: String(a.content ?? '').length })
    case 'append_file': return t('app.confirm.summary.append', { n: String(a.content ?? '').length })
    case 'delete_file': return t('app.confirm.summary.deleteFile')
    case 'replace_lines': return t('app.confirm.summary.replace', { s: a.start_line, e: a.end_line })
    case 'insert_lines': return t('app.confirm.summary.insert', { line: a.line })
    case 'delete_lines': return t('app.confirm.summary.deleteLines', { s: a.start_line, e: a.end_line })
    default: return ''
  }
})

/** 计算 diff 预览（按需读取原文件） */
async function loadPreview(p: PendingConfirm) {
  diff.value = null
  unreadable.value = false
  const name = p.toolName
  const content = String(p.args?.content ?? '')

  // 纯新增（追加 / 插入）无需读原文件
  if (name === 'append_file' || name === 'insert_lines') {
    diff.value = lineDiff('', content)
    return
  }

  const root = sessionStore.currentSession?.workspaceRoot
  if (!root) return // 无工作目录则不预览（工具执行时会报错引导）

  let oldFull = ''
  try {
    oldFull = await invoke<string>('agent_read_file', { root, relPath: p.path })
  } catch {
    // 文件不存在 / 读失败：write_file 视为新建，其它标记不可读
    if (name !== 'write_file') unreadable.value = true
  }

  switch (name) {
    case 'write_file':
      diff.value = lineDiff(oldFull, content)
      break
    case 'delete_file':
      diff.value = lineDiff(oldFull, '')
      break
    case 'replace_lines':
      diff.value = lineDiff(sliceLines(oldFull, Number(p.args.start_line), Number(p.args.end_line)), content)
      break
    case 'delete_lines':
      diff.value = lineDiff(sliceLines(oldFull, Number(p.args.start_line), Number(p.args.end_line)), '')
      break
  }
}

watch(
  () => chat.pendingConfirm,
  (p) => {
    if (!p) { diff.value = null; return }
    loadingDiff.value = true
    loadPreview(p)
      .catch(e => log.warn('生成 diff 预览失败: %s', (e as Error).message))
      .finally(() => { loadingDiff.value = false })
  },
  { immediate: true },
)
</script>

<template>
  <Transition name="confirm-fade">
    <div v-if="pc" class="tool-confirm" data-pet-solid>
      <!-- 头部：图标 + 工具名 + 路径 -->
      <div class="tc-head">
        <i class="tc-icon fas" :class="toolIcon(pc.toolName)"></i>
        <div class="tc-headtext">
          <div class="tc-title">{{ t('app.confirm.title') }}</div>
          <div class="tc-sub">
            <span class="tc-tool">{{ toolLabel(pc.toolName) }}</span>
            <span class="tc-path" :title="pc.path">{{ pc.path }}</span>
          </div>
        </div>
      </div>

      <div class="tc-summary">{{ summary }}</div>

      <!-- diff 预览 -->
      <div class="tc-diff-wrap">
        <div v-if="loadingDiff" class="tc-diff-hint">
          <i class="fas fa-spinner fa-spin"></i> {{ t('app.confirm.loading') }}
        </div>
        <div v-else-if="unreadable" class="tc-diff-hint">{{ t('app.confirm.unreadable') }}</div>
        <template v-else-if="diff && diff.rows.length">
          <div class="tc-diff-meta">
            <span class="tc-add">+{{ diff.added }}</span>
            <span class="tc-del">-{{ diff.removed }}</span>
          </div>
          <pre class="tc-diff"><code v-for="(r, i) in diff.rows" :key="i" :class="['tc-row', r.type]">{{ (r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  ') + r.text }}</code></pre>
          <div v-if="diff.truncated" class="tc-diff-hint">{{ t('app.confirm.truncated') }}</div>
        </template>
        <div v-else class="tc-diff-hint">{{ t('app.confirm.noDiff') }}</div>
      </div>

      <!-- 动作 -->
      <div class="tc-actions">
        <button class="tc-btn tc-reject" @click="chat.resolveConfirm('reject')">
          <i class="fas fa-xmark"></i> {{ t('app.confirm.reject') }}
        </button>
        <button class="tc-btn tc-auto" @click="chat.resolveConfirm('allow-session')">
          {{ t('app.confirm.allowSession') }}
        </button>
        <button class="tc-btn tc-allow" @click="chat.resolveConfirm('allow')">
          <i class="fas fa-check"></i> {{ t('app.confirm.allow') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.tool-confirm {
  width: 100%;
  max-width: 460px;
  margin-bottom: 8px;
  background: rgba(20, 20, 35, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px 14px;
  backdrop-filter: blur(16px);
  box-sizing: border-box;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

/* 头部 */
.tc-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tc-icon {
  font-size: 16px;
  color: #f0b85c;
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.tc-headtext {
  min-width: 0;
  flex: 1;
}

.tc-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.tc-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
  min-width: 0;
}

.tc-tool {
  font-size: 11px;
  color: #b9a0ff;
  flex-shrink: 0;
}

.tc-path {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tc-summary {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin: 8px 0 6px;
}

/* diff */
.tc-diff-wrap {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 6px 8px;
}

.tc-diff-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  font-family: monospace;
  margin-bottom: 4px;
}

.tc-add { color: #5fbf7f; }
.tc-del { color: #e06464; }

.tc-diff {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.45;
  font-family: 'Consolas', 'Courier New', monospace;
  white-space: pre;
}

.tc-row {
  display: block;
  padding: 0 4px;
  border-radius: 2px;
  color: rgba(255, 255, 255, 0.75);
  white-space: pre-wrap;
  word-break: break-word;
}

.tc-row.add { background: rgba(95, 191, 127, 0.16); color: #b7e6c4; }
.tc-row.del { background: rgba(224, 100, 100, 0.16); color: #f0bcbc; }
.tc-row.ctx { color: rgba(255, 255, 255, 0.45); }

.tc-diff-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  padding: 4px 0;
}

.tc-diff::-webkit-scrollbar { width: 5px; height: 5px; }
.tc-diff::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 4px; }

/* 动作 */
.tc-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  justify-content: flex-end;
}

.tc-btn {
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

.tc-reject {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.1);
}
.tc-reject:hover { background: rgba(224, 100, 100, 0.2); color: #f0bcbc; }

.tc-auto {
  background: none;
  color: rgba(255, 255, 255, 0.55);
}
.tc-auto:hover { color: rgba(255, 255, 255, 0.85); }

.tc-allow {
  background: #4a7aff;
  color: #fff;
}
.tc-allow:hover { opacity: 0.88; }

/* 进出动画 */
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
