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
import ToggleRow from '../ui/ToggleRow.vue'

const { t } = useI18n()

const autoExec = ref(getAutoExecFiles())
const commandEnabled = ref(getCommandEnabled())

function onAutoExecChange() {
  setAutoExecFiles(autoExec.value)
}

function onCommandEnabledChange() {
  setCommandEnabled(commandEnabled.value)
}
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-user-shield"></i> {{ t('settings.permissions.title') }}</h2>
    <p class="section-desc">{{ t('settings.permissions.desc') }}</p>

    <ToggleRow v-model:checked="autoExec" :title="t('settings.permissions.autoExecTitle')"
      :desc="t('settings.permissions.autoExecDesc')" @update:checked="onAutoExecChange" />

    <ToggleRow v-if="EXPERIMENTAL_COMMAND_AVAILABLE" v-model:checked="commandEnabled"
      :title="t('settings.permissions.commandTitle')" :desc="t('settings.permissions.commandDesc')"
      @update:checked="onCommandEnabledChange" />
  </div>
</template>
