<script setup lang="ts">
/**
 * 权限设置 - AI 对本机的操作授权
 *
 * 与「连接与能力」下的连接类配置区分：这里控制 AI 工具能对本地环境做什么。
 * 开关即改即生效（写入 toolPolicy 持久化），无需保存按钮。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAutoExecFiles, setAutoExecFiles, getCommandEnabled, setCommandEnabled } from '../../agent/toolPolicy'
import { EXPERIMENTAL_COMMAND_AVAILABLE } from '../../constants'

const { t } = useI18n()

const autoExec = ref(getAutoExecFiles())
const commandEnabled = ref(getCommandEnabled())

function onAutoExecChange() {
  autoExec.value = !autoExec.value
  setAutoExecFiles(autoExec.value)
}

function onCommandEnabledChange() {
  commandEnabled.value = !commandEnabled.value
  setCommandEnabled(commandEnabled.value)
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-user-shield"></i> {{ t('settings.permissions.title') }}</h2>
    <p class="section-desc">{{ t('settings.permissions.desc') }}</p>

    <div class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.permissions.autoExecTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.permissions.autoExecDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: autoExec }]"
          @click="onAutoExecChange" role="switch" :aria-checked="autoExec">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <div v-if="EXPERIMENTAL_COMMAND_AVAILABLE" class="form-group">
      <div class="toggle-row">
        <label class="toggle-label">
          <span class="toggle-label-text">{{ t('settings.permissions.commandTitle') }}</span>
          <span class="toggle-label-desc">{{ t('settings.permissions.commandDesc') }}</span>
        </label>
        <button :class="['toggle-switch', { active: commandEnabled }]"
          @click="onCommandEnabledChange" role="switch" :aria-checked="commandEnabled">
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>
  </div>
</template>
