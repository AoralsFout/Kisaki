<script setup lang="ts">
/** 屏幕截图逐次授权卡：只允许一次或拒绝，不提供会话自动授权。 */
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../stores/chat'

const { t } = useI18n()
const chat = useChatStore()
const pending = computed(() => chat.pendingScreenCaptureConfirm)
const rejectRef = ref<HTMLButtonElement | null>(null)
const titleId = useId()

watch(pending, value => {
  if (value) void nextTick(() => rejectRef.value?.focus())
})
</script>

<template>
  <Transition name="confirm-fade">
    <section v-if="pending" class="screen-confirm" data-pet-solid role="alertdialog"
      :aria-labelledby="titleId" tabindex="-1">
      <div class="sc-head">
        <i class="sc-icon fas fa-camera"></i>
        <div>
          <div :id="titleId" class="sc-title">{{ t('app.confirm.screen.title') }}</div>
          <div class="sc-sub">{{ t('app.tools.capture_screen') }}</div>
        </div>
      </div>

      <div class="sc-target">
        <i class="fas fa-display"></i>
        <span>{{ pending.target === 'primary_monitor'
          ? t('app.confirm.screen.primaryMonitor')
          : t('app.confirm.screen.cursorMonitor') }}</span>
      </div>

      <div class="sc-note">
        <i class="fas" :class="pending.includeKisaki ? 'fa-eye' : 'fa-eye-slash'"></i>
        <span>{{ pending.includeKisaki
          ? t('app.confirm.screen.includeKisaki')
          : t('app.confirm.screen.hideKisaki') }}</span>
      </div>

      <div class="sc-warning">
        <i class="fas fa-shield-halved"></i>
        <span>{{ t('app.confirm.screen.privacy') }}</span>
      </div>

      <div class="sc-actions">
        <button ref="rejectRef" class="sc-btn sc-reject"
          @click="chat.resolveScreenCaptureConfirm('reject')">
          <i class="fas fa-xmark"></i> {{ t('app.confirm.reject') }}
        </button>
        <button class="sc-btn sc-allow" @click="chat.resolveScreenCaptureConfirm('allow')">
          <i class="fas fa-camera"></i> {{ t('app.confirm.screen.allowOnce') }}
        </button>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.screen-confirm {
  width: 100%;
  max-width: 460px;
  margin-bottom: 8px;
  padding: 12px 14px;
  box-sizing: border-box;
  border: 1px solid rgba(109, 169, 255, 0.28);
  border-radius: 14px;
  background: rgba(20, 20, 35, 0.96);
  backdrop-filter: blur(16px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.sc-head,
.sc-target,
.sc-note,
.sc-warning,
.sc-actions {
  display: flex;
  align-items: center;
}

.sc-head { gap: 10px; }
.sc-icon { width: 22px; text-align: center; font-size: 18px; color: #86b7ff; }
.sc-title { font-size: 13px; font-weight: 600; color: var(--c-text-bright); }
.sc-sub { margin-top: 2px; font-size: var(--fs-aux); color: #b9a0ff; }

.sc-target,
.sc-note {
  gap: 7px;
  margin-top: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.76);
}
.sc-target .fas,
.sc-note .fas { width: 14px; text-align: center; color: #86b7ff; }

.sc-warning {
  gap: 7px;
  margin: 10px 0;
  padding: 7px 8px;
  border: 1px solid rgba(240, 184, 92, 0.2);
  border-radius: 7px;
  background: rgba(240, 184, 92, 0.1);
  color: #f0c985;
  font-size: var(--fs-aux);
  line-height: 1.4;
}
.sc-warning .fas { flex-shrink: 0; }

.sc-actions { justify-content: flex-end; gap: 6px; }
.sc-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  transition: opacity 0.15s, background 0.15s;
}
.sc-reject {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
}
.sc-reject:hover { background: rgba(224, 100, 100, 0.2); color: #f0bcbc; }
.sc-allow { background: #6da9ff; color: #10101c; font-weight: 600; }
.sc-allow:hover { opacity: 0.88; }

.confirm-fade-enter-active,
.confirm-fade-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.confirm-fade-enter-from,
.confirm-fade-leave-to { opacity: 0; transform: translateY(10px); }
</style>
