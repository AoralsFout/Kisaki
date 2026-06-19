# 实现计划：Live2D 角色支持集成

- 日期：2026-06-19
- 状态：计划稿
- 对应设计：`docs/superpowers/specs/2026-06-19-live2d-integration-design.md`
- 说明：按依赖排序，spike 先行。每步标注【文件】【做什么】【验收】。带 ✅TEST 的步骤需补单测。

---

## Phase 0 — Spike 去风险（一次性验证，可丢弃）✅ 已完成（2026-06-19）

> 目的：在写正式代码前，验证两个最大未知数。用 Hiyori 做素材。
>
> **结论：两项均通过**（详见设计文档 §10）。关键修订，后续 Phase 必须照此实现：
> - **0.1 asset:// 加载** → 必须用 `CubismSetting + redirectPath` 逐文件 `convertFileSrc` 重定向；直接传 `modelPath` 在 Windows 下 404。`loadLive2DManifest` 需返回 `modelJSON`+`modelDir`（→ 影响 Phase 2.2、3.3）。
> - **0.2 alpha 提取** → 掩码取**主 canvas** 快照（`createImageBitmap`），且 `app.init` 必须传 `preserveDrawingBuffer:true`；`extract.pixels(sprite)` 取不到（→ 影响 Phase 3.3、5.1）。

### 0.1 Spike：asset:// 模型加载 ★最高优先
- 【做什么】把 Hiyori 拷到 `characters/<测试角色>/live2d/Hiyori/`；临时写一个最小页面/组件，用 `convertFileSrc` 得到 `model3.json` 的 asset URL，喂给 `Live2DSprite.init({modelPath})`，确认模型、贴图、动作经 asset 协议全部加载。
- 【验收】Hiyori 在 Tauri 窗口里正常显示并能播 idle。若依赖文件（.moc3/贴图/motions）加载 404 → 记录失败模式，定预案（Rust 返回基目录 / 重写引用 / 自定义 loader）。**此步结论决定后续是否需调整 §5.2。**

### 0.2 Spike：透明画布 alpha 提取
- 【做什么】在 0.1 基础上，`app` 用 `backgroundAlpha:0`，调 `renderer.extract.canvas(sprite)`（或 `extract.pixels`）取一帧，检查 alpha 通道是否正确（模型实体处 alpha>0，空白处=0）。
- 【验收】能取到正确 alpha → 采用快照掩码方案（§5.6）；否则锁定"包围盒矩形命中"回退方案。

---

## Phase 1 — 地基：依赖 + Cubism Core + 构建绿灯

### 1.1 依赖调整
- 【文件】`package.json`
- 【做什么】加 `easy-live2d@^0.4.4`；`pixi.js` `^6.5.10`→`^8`；移除 `pixi-live2d-display`。`npm i`。
- 【验收】安装无 peer 冲突；`src/` 无 pixi 引用，无编译破坏。

### 1.2 接入 Cubism Core
- 【文件】`public/core/live2dcubismcore.js`（新）、`index.html`
- 【做什么】拷 Cubism Core 运行时到 `public/core/`；`index.html` 在 `/src/main.ts` 模块脚本前加 `<script src="/core/live2dcubismcore.js"></script>`。
- 【验收】`window.Live2DCubismCore` 在运行时存在。

### 1.3 构建/启动验证
- 【做什么】`npm run build`（`vue-tsc --noEmit && vite build`）+ `npm run tauri dev`。
- 【验收】构建通过；关注并消解 pixi v8 类型告警；现有立绘桌宠功能无回归。

---

## Phase 2 — 数据模型与加载（纯逻辑，优先单测）

### 2.1 Schema + 迁移 ✅TEST
- 【文件】`src/character/loader.ts`
- 【做什么】`CharacterData` 加 `render` + `live2d` 块（按 §5.1）；`migrateCharacterData` 加 v1→v2（无 `render` 补 `"illustration"`）；`CURRENT_VERSION=2`。
- 【验收】单测：旧 JSON（无 render）迁移后 `render==="illustration"`；live2d JSON 字段完整保留。现有角色加载不变。

### 2.2 模型 URL + manifest 自动发现 ✅TEST
- 【文件】`src/character/live2d/manifest.ts`（新）、`loader.ts`
- 【做什么】`live2dModelUrl(id, relPath)`；`loadLive2DManifest(id, data)`：fetch model3.json、解析 Expressions/Motions、合并注解（§5.2）。
- 【验收】单测（mock fetch）：发现表情/动作；注解补描述；缺注解回退原始 ID；idleGroup 缺省取首组。

### 2.3 store render getter
- 【文件】`src/stores/character.ts`
- 【做什么】暴露 `render` computed（默认 `illustration`）。视觉状态结构不动。
- 【验收】立绘角色 `render==="illustration"`。

---

## Phase 3 — 渲染层（方案 A）

### 3.1 抽离 IllustrationStage（保立绘零回归）
- 【文件】`src/components/IllustrationStage.vue`（新，从 `Character.vue` 搬迁）
- 【做什么】把现有双图淡入淡出 + 姿态样式 + `registerCharacterController/setAgentController/buildMask/预加载` 原样移入。
- 【验收】`tauri dev` 下立绘角色表现、淡入淡出、穿透与改造前一致。

### 3.2 Character.vue 切换器
- 【文件】`src/components/Character.vue`
- 【做什么】按 `charStore.data.render` 挂载 `IllustrationStage` / `Live2DStage`；保留 `@click` 与就绪态语义。
- 【验收】立绘角色走 IllustrationStage，无回归（此时 Live2DStage 可为占位）。

### 3.3 Live2DStage
- 【文件】`src/components/Live2DStage.vue`（新）
- 【做什么】pixi `Application`（`backgroundAlpha:0` 等）+ `Live2DSprite.init` + scale/offset + `Config`（idle/MouseFollow/Logging）+ `ready`（注册控制器、恢复表情、启 idle、启快照定时器）+ `hit`（播 tap、emit click）+ 卸载销毁 + Core 缺失检测（§5.3/5.9）。
- 【验收】Live2D 测试角色渲染、idle 播放、鼠标跟随、点击有反应；切到立绘角色后 pixi 资源正确释放。

---

## Phase 4 — 控制器 + AI 工具

### 4.1 useLive2DController
- 【文件】`src/character/live2d/controller.ts`（新）
- 【做什么】`init/dispose/setExpression/playMotion/setScreenPose/getState`（§5.4）；`setScreenPose` 把 PoseKey 预设折算为 sprite x/y/scale（重标定缩放系数）。
- 【验收】单测：mock `Live2DSprite`，`setExpression/playMotion` 校验 manifest 并调用；非法值返回 false。

### 4.2 agent 类型 + context 槽位
- 【文件】`src/agent/types.ts`、`src/agent/context.ts`
- 【做什么】`Tool` 加 `appliesTo`（默认 `both`）；`AgentContext` 加 `live2d` + `live2dManifest` 槽 + set/get。
- 【验收】类型通过；现有工具默认 `both` 不受影响。

### 4.3 registry 过滤 + 枚举注入 ✅TEST
- 【文件】`src/agent/registry.ts`
- 【做什么】`getDefinitions` 按 `appliesTo` vs `charData.render` 过滤；对 Live2D 工具从 manifest 注入 expression/motion 枚举 + 描述。
- 【验收】单测：立绘角色不含 live2d 工具、含立绘工具；live2d 角色反之；枚举值=manifest 实际值。

### 4.4 Live2D 工具
- 【文件】`src/agent/tools/live2d.ts`（新）、`src/agent/index.ts`、`src/agent/toolMeta.ts`
- 【做什么】`set_expression` / `play_motion`（`appliesTo:'live2d'`，经 context 调控制器）；注册；加图标。
- 【验收】live2d 角色下 AI 调 `set_expression`/`play_motion` 生效；非法值回可选清单。

### 4.5 现有工具分型 + switch_character 去耦
- 【文件】`src/agent/tools/character.ts`
- 【做什么】四个立绘工具标 `illustration`；`get_character_state/set_screen_pose/switch_character` 标 `both` 并按 `charData.render` 派发到对应控制器；切换逻辑抽为渲染无关共享路径。
- 【验收】立绘↔Live2D 角色切换、`set_screen_pose`、`get_character_state` 在两种渲染下都正确。

---

## Phase 5 — 鼠标穿透

### 5.1 快照掩码
- 【文件】`src/passthrough/live2dMask.ts`（新）
- 【做什么】约 100–125ms 定时对模型快照降采样 → alpha 掩码，键 `'live2d:current'`（复用 `alphaMask` 提取形态）；仅主窗口 + 穿透开启时运行。
- 【验收】掩码随模型动作更新；定时器在卸载/切立绘时停止。

### 5.2 命中分支
- 【文件】`src/passthrough/index.ts`
- 【做什么】`hitCharacter` 加 Live2D 分支：canvas 矩形 + `live2dMask` 查表，未就绪退回矩形。立绘分支不动。
- 【验收】Live2D 实体处可交互、透明处点击透传到下方窗口。

---

## Phase 6 — 端到端联调 + 文档

### 6.1 E2E 手动验证
- 【做什么】`tauri dev`：Live2D 渲染 / 穿透透传 / AI `set_expression`+`play_motion` / 立绘↔Live2D 切换 / 会话恢复（表情+屏幕位置）。
- 【验收】五项全过；立绘角色无任何回归。

### 6.2 文档与忽略
- 【文件】`README.md`、`.gitignore`
- 【做什么】README 写 Live2D 用法 + Cubism Core/模型授权说明；`.gitignore` 忽略开发用示例模型路径（不进 repo/发布包）。
- 【验收】文档清晰；`git status` 不含示例模型文件。

---

## 关键依赖关系

```
Phase 0 (spike) ──► Phase 1 (地基) ──► Phase 2 (数据) ──► Phase 3 (渲染)
                                              │                 │
                                              └──► Phase 4 (控制器/工具)
                                                          │
                                   Phase 3.3 + 4 ──► Phase 5 (穿透) ──► Phase 6 (E2E)
```

- Phase 2 纯逻辑，可与 Phase 1 并行收尾。
- Phase 5 依赖 Live2DStage（3.3）就绪。
- 每个 ✅TEST 步骤的单测先行/同步写，符合现有 vitest + happy-dom 约定。
