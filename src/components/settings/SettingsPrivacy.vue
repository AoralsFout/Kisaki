<script setup lang="ts">
/**
 * 隐私政策
 *
 * 向用户说明数据如何被存储与使用。文案经 i18n 分发，见各 locales 的
 * settings.privacy 命名空间。
 */
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const SECTIONS = [
  { key: 'local', icon: 'fa-database' },
  { key: 'network', icon: 'fa-globe' },
  { key: 'logs', icon: 'fa-receipt' },
  { key: 'delete', icon: 'fa-trash-can' },
] as const
</script>

<template>
  <div class="content-section">
    <h2 class="section-title"><i class="fas fa-shield-halved"></i> {{ t('settings.privacy.title') }}</h2>
    <p class="section-desc">{{ t('settings.privacy.desc') }}</p>

    <div v-for="s in SECTIONS" :key="s.key" class="privacy-section">
      <h3 class="privacy-title">
        <i class="fas" :class="s.icon"></i> {{ t(`settings.privacy.${s.key}.title`) }}
      </h3>
      <p class="privacy-body">{{ t(`settings.privacy.${s.key}.body`) }}</p>
    </div>

    <div class="privacy-note">
      <i class="fas fa-circle-check"></i> {{ t('settings.privacy.noTelemetry') }}
    </div>
  </div>
</template>

<style scoped>
.privacy-section {
  background: #16162a;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 12px;
}

.privacy-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.privacy-title i {
  color: #4a7aff;
  width: 16px;
  text-align: center;
}

.privacy-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: #aaa;
}

.privacy-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 12px 16px;
  font-size: 13px;
  color: #30b94e;
  background: rgba(48, 185, 78, 0.08);
  border: 1px solid rgba(48, 185, 78, 0.2);
  border-radius: 10px;
}
</style>
