<script setup lang="ts">
/**
 * 首次运行引导
 *
 * 主窗口首启动时覆盖显示，引导用户完成两步核心配置：
 *   ① 配置 AI 接口（API Key / 模型）
 *   ② 添加一个角色（导入角色包 / 新建）
 * 语音为可选项，仅作提示。完成后写入 STORAGE_ONBOARDING_DONE，之后不再出现。
 *
 * 就绪状态检测：
 *   - API：loadConfigSecure()（含密钥链/本地解密），跨窗口 storage 事件触发刷新
 *     （设置窗口保存配置后，主窗口同源收到 storage 事件自动重查）。
 *   - 角色：charStore.availableList 为响应式，App.vue 收到 characters-changed
 *     事件刷新列表后此处自动联动。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCharacterStore } from '../stores/character'
import { loadConfigSecure, isConfigValid } from '../ai'
import { createLogger } from '../utils/logger'
import { openUrl } from '@tauri-apps/plugin-opener'

const log = createLogger('Onboarding')

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'open-settings', tab: string): void
  (e: 'finish'): void
}>()

const { t } = useI18n()
const charStore = useCharacterStore()

const apiReady = ref(false)
const charReady = computed(() => charStore.availableList.length > 0)
const allReady = computed(() => apiReady.value && charReady.value)

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
          <button class="ob-primary" :class="{ soft: !allReady }" @click="emit('finish')">
            <i class="fas fa-paw"></i> {{ t('onboarding.start') }}
          </button>
          <button class="ob-later" @click="emit('finish')">{{ t('onboarding.later') }}</button>
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
  background: linear-gradient(180deg, #1e1e38 0%, #16162a 100%);
  border: 1px solid #2a2a4a;
  border-radius: 18px;
  padding: 26px 28px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  color: #e0e0e0;
}

.ob-head {
  text-align: center;
  margin-bottom: 20px;
}

.ob-spark {
  font-size: 30px;
  color: #4a7aff;
  margin-bottom: 6px;
}

.ob-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
}

.ob-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: #999;
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
  padding: 12px 14px;
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  transition: border-color 0.15s;
}

.ob-step.done {
  border-color: rgba(48, 185, 78, 0.4);
}

.ob-step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #2a2a4a;
  color: #aaa;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.ob-step.done .ob-step-dot {
  background: #30b94e;
  color: #fff;
}

.ob-step-body {
  flex: 1;
  min-width: 0;
}

.ob-step-title {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.ob-step-desc {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
}

.ob-step-btn {
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid #4a7aff;
  background: rgba(74, 122, 255, 0.12);
  color: #9bb4ff;
  border-radius: 16px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.ob-step-btn:hover {
  background: rgba(74, 122, 255, 0.25);
  color: #fff;
}

.ob-ready {
  font-size: 12px;
  color: #30b94e;
  white-space: nowrap;
}

.ob-pack-link {
  display: block;
  margin: 10px auto 0;
  border: 0;
  background: none;
  color: #9bb4ff;
  font-size: 12px;
  cursor: pointer;
}

.ob-voice {
  margin: 16px 0 0;
  font-size: 12px;
  color: #888;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ob-voice i {
  color: #ffa726;
}

.ob-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 20px;
}

.ob-primary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 26px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  background: #4a7aff;
  color: #fff;
  border-radius: 22px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.ob-primary:hover {
  opacity: 0.88;
}

.ob-primary.soft {
  background: rgba(74, 122, 255, 0.35);
}

.ob-later {
  padding: 8px 16px;
  font-size: 13px;
  border: none;
  background: none;
  color: #888;
  cursor: pointer;
  border-radius: 16px;
  transition: color 0.15s;
}

.ob-later:hover {
  color: #ccc;
}

.ob-hint {
  margin: 12px 0 0;
  text-align: center;
  font-size: 12px;
  color: #ffa726;
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
