# 设计：角色管理器 Live2D 支持

- 日期：2026-06-19
- 状态：设计稿
- 相关代码：`src/components/CharacterManager.vue`、`src/components/CharacterPreview.vue`、`src/components/CharacterList.vue`、`src/components/CharacterSelect.vue`、`src/components/Live2DStage.vue`、`src/character/loader.ts`、`src/character/live2d/manifest.ts`、`src-tauri/src/character.rs`、`src-tauri/src/lib.rs`
- 前置：Live2D 集成（`2026-06-19-live2d-integration-design.md`，已完成 Phase 0–6）

## 1. 背景与问题

Live2D 渲染/AI 控制已集成完成，但**角色管理器（设置→角色）完全不支持 Live2D 角色**，存在以下确认问题：

- **🔴 数据损坏**：`saveAll()` 从零重建 `character.json`，只写立绘字段，**丢弃 `render`/`live2d`**。在管理器里编辑任何 Live2D 角色（哪怕只改 prompt）保存后即变成无立绘的坏 illustration 角色。
- **无法创建 Live2D 角色**：`submitCreateForm()` 写死立绘字段 + `version:1`，无渲染类型选择、无模型导入。
- **编辑器全是立绘专属**：姿势/服装/立绘/情绪 + `CharacterPreview`（仅 `<img>`）；缺模型导入、表情/动作注解、缩放/偏移/idle/tap/鼠标跟随配置、Live2D 预览。
- **后端缺能力**：无导入 Live2D 模型文件（二进制 + 多文件 + 子目录）的命令。

## 2. 目标与非目标

### 目标
- 修复 `saveAll` 数据损坏（保留 `render`/`live2d` 及所有字段）——惠及全部角色。
- 支持在管理器内**创建 Live2D 角色**：选渲染类型 + 选文件夹导入模型（创建即带模型）。
- Live2D 角色编辑器：模型（重新导入）、缩放/偏移/idle/tap/鼠标跟随配置、表情/动作中文注解编辑、Live2D 实时预览。
- 立绘角色管理**零回归**。
- Live2D 模型经现有角色包（`.zip`）导入/导出无需改（`pack.rs` 整目录处理已覆盖 `live2d/`）。

### 非目标
- 不支持把已有角色在立绘↔Live2D 之间**切换渲染类型**（创建时定死）。
- 不在管理器内做表情/动作的可视化预览触发（仅注解文本编辑）；预览只渲染模型 + idle。
- 不做 Live2D 模型的内置编辑（动作裁剪等）。
- 不改 TTS/口型同步（属 Live2D 集成的后续项）。

## 3. 决策记录（用户已确认）
- **模型导入**：Tauri 文件夹选择器 → 新增 Rust 命令递归拷贝整目录进 `characters/<id>/live2d/`。
- **v1 范围**：完整编辑器（创建+导入+全部配置+注解+预览）。
- **编辑器结构**：方案 A——现有编辑器内按 `render` 条件渲染，Live2D 编辑 UI 抽成 `Live2DEditor.vue`。
- **创建**：Live2D 角色创建即导入模型，无半成品状态。
- **saveAll**：改为 `{...data}` 覆盖式，按 render 覆盖对应字段。
- **预览**：抽 `useLive2DScene` 组合式，桌宠（Live2DStage）与编辑器预览（Live2DPreview）共用。
- **注解编辑**：遍历自动发现的表情/动作逐行填中文描述。

## 4. 架构

### 4.1 组件边界

```
CharacterManager.vue（入口：列表 / 创建 / 编辑器外壳 / 保存导出）
  ├ 创建表单：render 单选；live2d → 选模型文件夹（提交即导入）
  ├ 编辑器（view==='editor'，按 charStore.render 分支）：
  │   ├ illustration → 姿势/服装/立绘 + CharacterPreview（不变）
  │   └ live2d       → Live2DEditor.vue + Live2DPreview.vue
  └ saveAll → buildCharacterJson(data, render, edits)（纯函数，保留 render/live2d）

useLive2DScene(scene.ts)  ← 加载核心：CubismSetting+redirectPath + pixi app + sprite + 变换 + 生命周期
  ├ Live2DStage.vue（桌宠）= scene + 控制器注册 + 快照掩码 + 全局鼠标跟随（读 charStore）
  └ Live2DPreview.vue（编辑器）= scene 绑定可编辑配置（实时预览，无桌宠副作用）

Rust: import_live2d_model(id, srcDir) → 递归拷贝 → 返回 model3.json 相对路径
```

### 4.2 文件改动

| 文件 | 改动 |
|---|---|
| `src-tauri/src/character.rs` | 新增 `import_live2d_model`：找 `*.model3.json`、递归二进制拷贝目录到 `live2d/<name>/`、返回相对路径；路径安全 |
| `src-tauri/src/lib.rs` | 注册 `import_live2d_model` |
| `src/character/live2d/scene.ts`（新） | `useLive2DScene(canvasRef, containerRef, source)`：从 Live2DStage 抽出的加载+渲染+变换核心 |
| `src/components/Live2DStage.vue` | 改用 `useLive2DScene`，仅保留桌宠层（控制器/掩码/跟随） |
| `src/components/Live2DPreview.vue`（新） | 编辑器预览：用 `useLive2DScene` 绑定可编辑配置 |
| `src/components/Live2DEditor.vue`（新） | Live2D 编辑区：模型导入、配置表单、idle/tap 下拉、表情/动作注解编辑 |
| `src/components/CharacterManager.vue` | 创建分 render + 模型导入；编辑器按 render 分支；`loadData` 分支（含 `loadLive2DManifest`）；`saveAll` 用 `buildCharacterJson` 修复 |
| `src/character/characterJson.ts`（新） | `buildCharacterJson(data, render, edits)` 纯函数 + 单测 |
| `src/components/CharacterList.vue` / `CharacterSelect.vue` | Live2D 徽标；确认无立绘缩略图假设 |
| `src/i18n/locales/*.ts` | 新增 Live2D 编辑器文案（4 语言） |

## 5. 详细设计

### 5.1 后端 `import_live2d_model`

```rust
#[tauri::command]
fn import_live2d_model(id: String, src_dir: String) -> Result<String, String>
```
1. `sanitize_path_component(&id)`；`src_dir` 为 dialog 返回的绝对路径。
2. 在 `src_dir` 找 `*.model3.json`（顶层；无则递归一层）；找不到 → `Err("未找到 model3.json")`。
3. `name` = `src_dir` 末段；目标 `characters/<id>/live2d/<name>/`（`safe_join` 校验）；已存在先 `remove_dir_all`。
4. 递归拷贝（`copy_dir_all` 辅助：`fs::copy` 二进制安全，建子目录）。
5. 返回 model3.json 相对角色目录路径，如 `live2d/<name>/<file>.model3.json`。

前端：`@tauri-apps/plugin-dialog` `open({ directory: true })` 选夹 → `invoke('import_live2d_model', { id, srcDir })` → 写 `config.model`。

### 5.2 创建流程

创建表单加 `render` 单选。提交：
- illustration：现状 + `version:2` + `render:'illustration'`。
- live2d：要求已选模型文件夹 → 建目录 → `import_live2d_model` → 写 `character.json`（`render:'live2d'`、`live2d:{model, scale:1, mouseFollow:true}`、立绘字段空）→ 进编辑器。

### 5.3 saveAll 修复 + `buildCharacterJson`

```ts
// characterJson.ts（纯函数，可单测）
export function buildCharacterJson(data, render, edits): Record<string, any> {
  const out = { ...data, version: 2 }                 // 保留 render/live2d/未知字段
  out.voice = edits.voice || undefined
  out.voiceModel = edits.voiceModel || undefined
  out.voiceLanguage = edits.voiceLanguage
  out.textLanguage = edits.textLanguage
  if (render === 'live2d') {
    out.live2d = { ...data.live2d, ...edits.live2d }  // 模型/缩放/偏移/idle/tap/mouseFollow/注解
  } else {
    out.poses = edits.poses; out.emotions = edits.emotions
    out.costumes = edits.costumes; out.images = edits.images
  }
  return out
}
```
`saveAll` 调它写盘。立绘角色保存行为不变（仍覆盖立绘字段），但不再丢 voice 外的字段。

### 5.4 编辑器分支 + loadData
- `loadData()`：live2d 时填充 `editableLive2dConfig`（从 `data.live2d`），并 `loadLive2DManifest(id, data)` 取表情/动作存 `manifest` ref（喂下拉 + 注解编辑器）。
- 模板编辑区按 `charStore.render` v-if 切换两套 UI；外壳（prompt/voice/保存栏）共用。

### 5.5 `Live2DEditor.vue`
Props：`id`、`manifest`、可编辑 `config`（`update:config` + `markChanged`）、`import-model` 事件。
区块：模型（路径 + 重新导入）、显示（scale/offsetX/offsetY/mouseFollow）、动作（idle/tap 下拉）、表情注解（遍历 `manifest.expressions` 逐行 id→描述）、动作注解（遍历 `manifest.motions` 逐行 组名/条数→描述）。

### 5.6 预览：`useLive2DScene` + `Live2DPreview.vue`
- `useLive2DScene(canvasRef, containerRef, source)`：`source` 为响应式 `{ id, live2d, manifest }`；负责 CubismSetting+redirectPath 加载、`preserveDrawingBuffer` app、按 `live2d.scale/offset` + 当前屏幕姿态变换、watch 重载、卸载销毁；返回 `{ ready }`。
- `Live2DStage.vue` 改为 `useLive2DScene(读 charStore)` + 桌宠层（`setAgentLive2DController`、`startLive2DMask`、全局鼠标跟随）。
- `Live2DPreview.vue` = `useLive2DScene` 绑定编辑器的可编辑 `config`（实时反映未保存的 scale/offset/idle，不注册控制器/掩码/跟随，不弄脏 store）。

### 5.7 列表 / 选择器
`CharacterList`/`CharacterSelect` 加 "Live2D" 徽标；确认它们不因 live2d 角色无立绘而报错（仅展示名称即可）。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 选的文件夹无 `model3.json` | `import_live2d_model` 报错，创建/导入提示失败 |
| live2d 角色 `model` 缺失/损坏 | 编辑器显示空态 + 导入按钮；预览占位；不崩 |
| 导入大模型耗时 | 导入按钮 busy 态 |
| 保存任意角色 | 保留 `render`/`live2d` 及未知字段（bug 已修） |
| 渲染类型切换 | 不支持；创建时定死，编辑器按类型显示对应 UI |
| 非 Tauri 环境 | 导入/预览降级（与现有 data_dir 逻辑一致） |

## 7. 实施顺序（分阶段，每阶段一提交）

1. **修数据损坏 bug（最高优先，独立可发）**：抽 `buildCharacterJson` + 单测，`saveAll` 改用之。立即止血。
2. **后端**：`import_live2d_model` + lib.rs 注册。
3. **预览重构**：抽 `useLive2DScene`，Live2DStage 改用之（回归验证桌宠）；新增 `Live2DPreview.vue`。
4. **创建流程**：创建表单 render 单选 + live2d 选模型导入。
5. **编辑器**：`Live2DEditor.vue` + CharacterManager 分支 + `loadData` + i18n。
6. **列表徽标 + 端到端联调**。

## 8. 测试策略
- 单元（vitest）：`buildCharacterJson`——live2d 保留 render/live2d、illustration 覆盖立绘字段、version→2、未知字段不丢；创建默认值按 render。
- Rust：`import_live2d_model` 手动/集成（递归拷贝 + 找 model3.json + 路径安全 + 覆盖重导）。
- 手动 E2E：settings 创建 Live2D → 导入 Hiyori → 配置/注解 → 预览实时 → 保存 → 主窗口生效 → 重进编辑不丢失；立绘角色全流程无回归。

## 9. 未解决 / 未来扩展
- 模型导入进度/大小提示；导入时校验 Cubism 版本。
- 预览内触发表情/动作试看（点按播放）。
- 多模型/换装（一个角色多套 Live2D）。
- 与 Live2D 集成遗留项协同：全局鼠标跟随修复（任务 #14）、屏幕姿态缩放构图、口型同步。
