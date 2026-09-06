<script setup lang="ts">
/**
 * 首次运行引导
 *
 * 主窗口首启动时覆盖显示，引导用户完成两步核心配置：
 *   ① 配置 AI 接口（API Key / 模型）
 *   ② 添加一个角色（导入角色包 / 新建）
 * 语音为可选项，仅作提示。
 *
 * 完成语义：
 *   - 两步齐全后点击「开始使用」才 emit('finish')，由父组件写入 STORAGE_ONBOARDING_DONE。
 *   - 配置未完成时主按钮为「继续配置」，定位到第一个未完成步骤；不产生完成标记。
 *   - 「稍后再说」emit('later') 仅收起引导，父组件记录搁置状态并保留可恢复的配置待办。
 *
 * 就绪状态检测：
 *   - API：loadConfigSecure()（含密钥链/本地解密），跨窗口 storage 事件触发刷新
 *     （设置窗口保存配置后，主窗口同源收到 storage 事件自动重查）。就绪仅表示配置已保存，
 *     不代表连接测试通过。
 *   - 角色：charStore.availableList 为响应式，App.vue 收到 characters-changed
 *     事件刷新列表后此处自动联动。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCharacterStore } from '../stores/character'
import { loadConfigSecure, isConfigValid } from '../ai'
import { createLogger } from '../utils/logger'
import { openUrl } from '@tauri-apps/plugin-opener'
import BaseButton from './ui/BaseButton.vue'

const log = createLogger('Onboarding')

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'open-settings', tab: string): void
  (e: 'finish'): void
  (e: 'later'): void
}>()

const { t } = useI18n()
const charStore = useCharacterStore()

const apiReady = ref(false)
const charReady = computed(() => charStore.availableList.length > 0)
const allReady = computed(() => apiReady.value && charReady.value)

/** 第一个未完成的步骤：API 未配置先去配置，否则去添加角色 */
const pendingTab = computed(() => (apiReady.value ? 'character' : 'api'))

/** 重新检测 API 是否已配置（异步解密） */
async function refreshApi() {
  try {
    const cfg = await loadConfigSecure()
    apiReady.value = isConfigValid(cfg)
  } catch (e) {
    log.warn('检测 API 配置失败', e)
    apiReady.value = false
  }
}

function onStorage() {
  void refreshApi()
}

async function downloadOfficialCharacters() {
  await openUrl('https://github.com/AoralsFout/Kisaki/releases/latest/download/characters.zip')
}

watch(() => props.visible, (v) => {
  if (v) void refreshApi()
})

onMounted(() => {
  void refreshApi()
  window.addEventListener('storage', onStorage)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<template>
  <Transition name="ob-fade">
    <div v-if="visible" class="ob-overlay" data-pet-solid>
      <div class="ob-card">
        <div class="ob-head">
          <i class="fas fa-sparkles ob-spark"></i>
          <h2 class="ob-title">{{ t('onboarding.title') }}</h2>
          <p class="ob-subtitle">{{ t('onboarding.subtitle') }}</p>
        </div>

        <ul class="ob-steps">
          <li class="ob-step" :class="{ done: apiReady }">
            <div class="ob-step-dot">
              <i v-if="apiReady" class="fas fa-check"></i>
              <span v-else>1</span>
            </div>
            <div class="ob-step-body">
              <div class="ob-step-title">{{ t('onboarding.api.title') }}</div>
              <div class="ob-step-desc">{{ t('onboarding.api.desc') }}</div>
            </div>
            <button v-if="!apiReady" class="ob-step-btn" @click="emit('open-settings', 'api')">
              {{ t('onboarding.api.action') }}
            </button>
            <span v-else class="ob-ready">{{ t('onboarding.api.ready') }}</span>
          </li>

          <li class="ob-step" :class="{ done: charReady }">
            <div class="ob-step-dot">
              <i v-if="charReady" class="fas fa-check"></i>
              <span v-else>2</span>
            </div>
            <div class="ob-step-body">
              <div class="ob-step-title">{{ t('onboarding.character.title') }}</div>
              <div class="ob-step-desc">{{ t('onboarding.character.desc') }}</div>
            </div>
            <button v-if="!charReady" class="ob-step-btn" @click="emit('open-settings', 'character')">
              {{ t('onboarding.character.action') }}
            </button>
            <span v-else class="ob-ready">{{ t('onboarding.character.ready') }}</span>
          </li>
        </ul>

        <button v-if="!charReady" class="ob-pack-link" @click="downloadOfficialCharacters">
          <i class="fas fa-download"></i> {{ t('onboarding.character.downloadOfficial') }}
        </button>

        <p class="ob-voice"><i class="fas fa-volume-high"></i> {{ t('onboarding.voice') }}</p>

        <div class="ob-actions">
          <BaseButton v-if="allReady" class="ob-primary" @click="emit('finish')">
            <i class="fas fa-paw"></i> {{ t('onboarding.start') }}
          </BaseButton>
          <BaseButton v-else class="ob-primary" @click="emit('open-settings', pendingTab)">
            <i class="fas fa-arrow-right"></i> {{ t('onboarding.continue') }}
          </BaseButton>
          <button v-if="!allReady" class="ob-later" @click="emit('later')">{{ t('onboarding.later') }}</button>
        </div>
        <p v-if="!allReady" class="ob-hint">{{ t('onboarding.notReady') }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ob-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(12, 12, 24, 0.6);
  backdrop-filter: blur(4px);
}

.ob-card {
  width: 460px;
  max-width: 92vw;
  background: linear-gradient(180deg, var(--c-control) 0%, var(--c-bg) 100%);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-overlay);
  padding: var(--space-6) 28px;
  box-shadow: var(--shadow-overlay);
  color: var(--c-text);
}

.ob-head {
  text-align: center;
  margin-bottom: 20px;
}

.ob-spark {
  font-size: 30px;
  color: var(--c-brand);
  margin-bottom: 6px;
}

.ob-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--c-text-bright);
}

.ob-subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-aux);
  color: var(--c-text-muted);
}

.ob-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ob-step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: var(--space-3) var(--space-4);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-card);
  transition: border-color 0.15s;
}

.ob-step.done {
  border-color: rgba(48, 185, 78, 0.4);
}

.ob-step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--c-border);
  color: var(--c-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-aux);
  font-weight: 600;
  flex-shrink: 0;
}

.ob-step.done .ob-step-dot {
  background: var(--c-ok);
  color: var(--c-text-bright);
}

.ob-step-body {
  flex: 1;
  min-width: 0;
}

.ob-step-title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--c-text);
}

.ob-step-desc {
  font-size: var(--fs-aux);
  color: var(--c-text-muted);
  margin-top: 2px;
}

.ob-step-btn {
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-aux);
  font-weight: 500;
  border: 1px solid var(--c-brand);
  background: var(--c-brand-soft);
  color: var(--c-brand-text);
  border-radius: var(--radius-control);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.ob-step-btn:hover {
  background: var(--c-brand-soft-strong);
  color: var(--c-text-bright);
}

.ob-ready {
  font-size: var(--fs-aux);
  color: var(--c-ok);
  white-space: nowrap;
}

.ob-pack-link {
  display: block;
  margin: 10px auto 0;
  border: 0;
  background: none;
  color: var(--c-brand-text);
  font-size: var(--fs-aux);
  cursor: pointer;
}

.ob-voice {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-aux);
  color: var(--c-text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.ob-voice i {
  color: var(--c-warn);
}

.ob-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 20px;
}

.ob-primary {
  padding: 10px 28px;
  font-weight: 600;
}

.ob-later {
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-body);
  border: none;
  background: none;
  color: var(--c-text-muted);
  cursor: pointer;
  border-radius: var(--radius-control);
  transition: color 0.15s;
}

.ob-later:hover {
  color: var(--c-text-secondary);
}

.ob-hint {
  margin: var(--space-3) 0 0;
  text-align: center;
  font-size: var(--fs-aux);
  color: var(--c-warn);
}

.ob-fade-enter-active,
.ob-fade-leave-active {
  transition: opacity 0.25s;
}

.ob-fade-enter-from,
.ob-fade-leave-to {
  opacity: 0;
}
</style>
