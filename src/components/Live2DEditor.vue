<script setup lang="ts">
/**
 * Live2D 角色编辑区（角色管理器内，render==='live2d' 时显示）
 *
 * 直接绑定父级传入的可编辑 live2d 配置对象；任何改动 emit('change') 让父级标脏。
 * 表情/动作来自 manifest（从 .model3.json 自动发现），逐行填中文描述注解。
 */
import { useI18n } from 'vue-i18n'
import type { Live2DManifest, Live2DConfig } from '../character'

const { t } = useI18n()

const props = defineProps<{
  manifest: Live2DManifest | null
  config: Live2DConfig
}>()
const emit = defineEmits<{ change: []; 'import-model': [] }>()

function changed() { emit('change') }

function setExpr(id: string, v: string) {
  if (!props.config.expressions) props.config.expressions = {}
  props.config.expressions[id] = v
  changed()
}
function setMotion(group: string, v: string) {
  if (!props.config.motions) props.config.motions = {}
  props.config.motions[group] = v
  changed()
}
</script>

<template>
  <div class="l2d-editor">
    <!-- 模型 -->
    <section class="mgr-section">
      <h3 class="mgr-label"><i class="fas fa-cube"></i> {{ t('character.mgr.live2d.model') }}</h3>
      <div class="l2d-model-row">
        <code class="l2d-model-path">{{ config.model || t('character.mgr.live2d.modelNone') }}</code>
        <button class="l2d-btn" @click="emit('import-model')">
          <i class="fas fa-folder-open"></i> {{ t('character.mgr.live2d.reimport') }}
        </button>
      </div>
    </section>

    <!-- 显示 -->
    <section class="mgr-section">
      <h3 class="mgr-label"><i class="fas fa-up-down-left-right"></i> {{ t('character.mgr.live2d.display') }}</h3>
      <div class="l2d-grid">
        <label class="l2d-field">{{ t('character.mgr.live2d.scale') }}
          <input type="number" step="0.05" v-model.number="config.scale" @change="changed" />
        </label>
        <label class="l2d-field">{{ t('character.mgr.live2d.offsetX') }}
          <input type="number" v-model.number="config.offsetX" @change="changed" />
        </label>
        <label class="l2d-field">{{ t('character.mgr.live2d.offsetY') }}
          <input type="number" v-model.number="config.offsetY" @change="changed" />
        </label>
        <label class="l2d-check">
          <input type="checkbox" v-model="config.mouseFollow" @change="changed" />
          {{ t('character.mgr.live2d.mouseFollow') }}
        </label>
      </div>
    </section>

    <!-- 动作组 -->
    <section class="mgr-section">
      <h3 class="mgr-label"><i class="fas fa-film"></i> {{ t('character.mgr.live2d.motions') }}</h3>
      <div class="l2d-grid">
        <label class="l2d-field">{{ t('character.mgr.live2d.idleMotion') }}
          <select v-model="config.idleMotionGroup" @change="changed">
            <option v-for="m in manifest?.motions ?? []" :key="m.group" :value="m.group">{{ m.group }}</option>
          </select>
        </label>
        <label class="l2d-field">{{ t('character.mgr.live2d.tapMotion') }}
          <select v-model="config.tapMotionGroup" @change="changed">
            <option :value="undefined">{{ t('character.mgr.live2d.motionNone') }}</option>
            <option v-for="m in manifest?.motions ?? []" :key="m.group" :value="m.group">{{ m.group }}</option>
          </select>
        </label>
      </div>
    </section>

    <!-- 表情注解 -->
    <section class="mgr-section" v-if="manifest && manifest.expressions.length">
      <h3 class="mgr-label"><i class="fas fa-face-grin-stars"></i> {{ t('character.mgr.live2d.exprAnno') }}</h3>
      <div v-for="e in manifest.expressions" :key="e.id" class="l2d-anno">
        <code>{{ e.id }}</code>
        <input :value="config.expressions?.[e.id] ?? ''" :placeholder="e.id"
          @input="setExpr(e.id, ($event.target as HTMLInputElement).value)" />
      </div>
    </section>

    <!-- 动作注解 -->
    <section class="mgr-section" v-if="manifest && manifest.motions.length">
      <h3 class="mgr-label"><i class="fas fa-film"></i> {{ t('character.mgr.live2d.motionAnno') }}</h3>
      <div v-for="m in manifest.motions" :key="m.group" class="l2d-anno">
        <code>{{ m.group }} · {{ m.count }}</code>
        <input :value="config.motions?.[m.group] ?? ''" :placeholder="m.group"
          @input="setMotion(m.group, ($event.target as HTMLInputElement).value)" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.l2d-editor { display: flex; flex-direction: column; }

.l2d-model-row { display: flex; align-items: center; gap: 8px; }
.l2d-model-path {
  flex: 1;
  font-size: 11px;
  font-family: var(--font-mono);
  color: #9fb3c8;
  word-break: break-all;
  background: #14142a;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 6px 8px;
}

.l2d-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.l2d-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #9a9ab0;
}
.l2d-field input,
.l2d-field select {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-control);
  color: var(--c-text);
  outline: none;
  transition: border-color 0.15s;
}
.l2d-field input:focus,
.l2d-field select:focus { border-color: var(--c-brand); }

.l2d-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #cdd;
  cursor: pointer;
  align-self: end;
  padding-bottom: 6px;
}
.l2d-check input { accent-color: var(--c-brand); width: 15px; height: 15px; cursor: pointer; }

.l2d-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  border: 1px solid var(--c-border-strong);
  border-radius: 6px;
  background: var(--c-control);
  color: #cdd;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.l2d-btn:hover { background: var(--c-border); border-color: var(--c-brand); color: var(--c-text-bright); }

.l2d-anno { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.l2d-anno code {
  font-size: 11px;
  font-family: var(--font-mono);
  color: #7c8cff;
  min-width: 110px;
  flex-shrink: 0;
}
.l2d-anno input {
  flex: 1;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-control);
  color: var(--c-text);
  outline: none;
  transition: border-color 0.15s;
}
.l2d-anno input:focus { border-color: var(--c-brand); }
</style>
