<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { executionState, cancelActiveExecution } from '../agent/executionState'

const { t } = useI18n()
const statusText = computed(() => t(`app.execution.status.${executionState.status}`))
</script>

<template>
  <div v-if="executionState.active" class="execution-card" data-pet-solid role="status" aria-live="polite">
    <div class="execution-head">
      <div class="execution-title">
        <i class="fas fa-terminal" aria-hidden="true"></i>
        <span>{{ statusText }}</span>
      </div>
      <button
        v-if="executionState.status === 'running'"
        class="execution-stop"
        :disabled="executionState.cancelling"
        @click="cancelActiveExecution"
      >
        {{ executionState.cancelling ? t('app.execution.stopping') : t('app.execution.stop') }}
      </button>
    </div>
    <code v-if="executionState.command" class="execution-command" data-selectable>{{ executionState.command }}</code>
    <pre v-if="executionState.output" class="execution-output" data-selectable>{{ executionState.output }}</pre>
    <div v-else class="execution-wait">{{ t('app.execution.waitingOutput') }}</div>
  </div>
</template>

<style scoped>
.execution-card {
  width: 100%;
  max-width: 520px;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(120, 180, 255, 0.25);
  border-radius: 12px;
  background: rgba(18, 22, 35, 0.96);
  color: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(16px);
}

.execution-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.execution-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
}

.execution-stop {
  border: 1px solid rgba(240, 110, 110, 0.3);
  border-radius: 7px;
  padding: 4px 10px;
  background: rgba(240, 110, 110, 0.12);
  color: #f2b0b0;
  cursor: pointer;
}

.execution-stop:disabled { opacity: 0.55; cursor: default; }

.execution-command {
  display: block;
  margin-top: 7px;
  overflow-wrap: anywhere;
  color: #b9d6ff;
  font-size: var(--fs-aux);
}

.execution-output {
  max-height: 160px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 8px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.36);
  color: #c7e6ce;
  font: var(--fs-aux)/1.45 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.execution-wait { margin-top: 7px; font-size: var(--fs-aux); color: rgba(255, 255, 255, 0.72); }
</style>
