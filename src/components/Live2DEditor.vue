<script setup lang="ts">
/**
 * Live2D 角色编辑区（角色管理器内，render==='live2d' 时显示）
 *
 * 直接绑定父级传入的可编辑 live2d 配置对象；任何改动 emit('change') 让父级标脏。
 * 表情/动作来自 manifest（从 .model3.json 自动发现），逐行填中文描述注解。
 */
import type { Live2DManifest, Live2DConfig } from '../character'

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
      <h3 class="mgr-label"><i class="fas fa-cube"></i> 模型</h3>
      <div class="l2d-model-row">
        <code class="l2d-model-path">{{ config.model || '未导入' }}</code>
        <button class="btn-pick" @click="emit('import-model')">重新导入</button>
      </div>
    </section>

    <!-- 显示 -->
    <section class="mgr-section">
      <h3 class="mgr-label"><i class="fas fa-up-down-left-right"></i> 显示</h3>
      <div class="l2d-grid">
        <label>缩放<input type="number" step="0.05" v-model.number="config.scale" @change="changed" /></label>
        <label>X 偏移<input type="number" v-model.number="config.offsetX" @change="changed" /></label>
        <label>Y 偏移<input type="number" v-model.number="config.offsetY" @change="changed" /></label>
        <label class="l2d-check"><input type="checkbox" v-model="config.mouseFollow" @change="changed" /> 鼠标跟随</label>
      </div>
    </section>

    <!-- 动作组 -->
    <section class="mgr-section">
      <h3 class="mgr-label"><i class="fas fa-film"></i> 动作</h3>
      <div class="l2d-grid">
        <label>空闲动作
          <select v-model="config.idleMotionGroup" @change="changed">
            <option v-for="m in manifest?.motions ?? []" :key="m.group" :value="m.group">{{ m.group }}</option>
          </select>
        </label>
        <label>点击动作
          <select v-model="config.tapMotionGroup" @change="changed">
            <option :value="undefined">（无）</option>
            <option v-for="m in manifest?.motions ?? []" :key="m.group" :value="m.group">{{ m.group }}</option>
          </select>
        </label>
      </div>
    </section>

    <!-- 表情注解 -->
    <section class="mgr-section" v-if="manifest && manifest.expressions.length">
      <h3 class="mgr-label"><i class="fas fa-face-grin-stars"></i> 表情注解（给 AI 的描述）</h3>
      <div v-for="e in manifest.expressions" :key="e.id" class="l2d-anno">
        <code>{{ e.id }}</code>
        <input :value="config.expressions?.[e.id] ?? ''" :placeholder="e.id"
          @input="setExpr(e.id, ($event.target as HTMLInputElement).value)" />
      </div>
    </section>

    <!-- 动作注解 -->
    <section class="mgr-section" v-if="manifest && manifest.motions.length">
      <h3 class="mgr-label"><i class="fas fa-film"></i> 动作注解</h3>
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
.l2d-model-path { font-size: 11px; font-family: monospace; color: #9fb; word-break: break-all; flex: 1; }
.l2d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.l2d-grid label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #aaa; }
.l2d-grid label.l2d-check { flex-direction: row; align-items: center; gap: 6px; }
.l2d-grid input[type="number"], .l2d-grid select {
  padding: 4px 8px; font-size: 12px; border: 1px solid #2a2a4a; border-radius: 6px;
  background: #1e1e38; color: #e0e0e0; outline: none;
}
.btn-pick {
  padding: 6px 12px; font-size: 12px; border: 1px solid #3a3a5a; border-radius: 6px;
  background: #1e1e38; color: #cdd; cursor: pointer; flex-shrink: 0;
}
.btn-pick:hover { background: #2a2a4a; }
.l2d-anno { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.l2d-anno code { font-size: 11px; font-family: monospace; color: #7c8cff; min-width: 110px; }
.l2d-anno input {
  flex: 1; padding: 3px 8px; font-size: 12px; border: 1px solid #2a2a4a; border-radius: 6px;
  background: #1e1e38; color: #e0e0e0; outline: none;
}
</style>
