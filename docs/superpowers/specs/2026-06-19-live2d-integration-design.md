# 设计：Live2D 角色支持集成

- 日期：2026-06-19
- 状态：设计稿
- 相关代码：`src/components/Character.vue`、`src/character/loader.ts`、`src/character/controller.ts`、`src/stores/character.ts`、`src/agent/registry.ts`、`src/agent/context.ts`、`src/agent/types.ts`、`src/agent/index.ts`、`src/agent/tools/character.ts`、`src/passthrough/index.ts`、`src/passthrough/alphaMask.ts`、`index.html`、`package.json`
- 参考：`live2d-example/`（easy-live2d + pixi v8 加载验证）、easy-live2d 文档 <https://panzer-jack.github.io/easy-live2d/guide/>

## 1. 背景与问题

Kisaki 现有角色系统是**静态立绘**：每个角色一组 PNG，按 `pose / emotion / costume` 三维标签打标，`Character.vue` 用双图叠加交叉淡入淡出渲染，`CharacterController` 选图，AI 工具（`set_character_emotion` 等）切图。窗口是 Tauri 透明、无边框、置顶的桌宠（400×600），并通过 Rust 轮询光标 + 前端 alpha 掩码命中测试实现**逐像素鼠标穿透**。

目标是新增 **Live2D 动态模型**支持：模型渲染到 pixi 画布、带 idle 动作、鼠标跟随、点击反应，并能被 AI 控制（表情/动作/屏幕位置）。Live2D 角色与静态立绘角色**共存**，按角色类型二选一。

`package.json` 现有 `pixi-live2d-display@0.4` + `pixi.js@6`，但 `src/` 实际未引用（已废弃，相关旧模型资源正在删除）。新方案改用 `easy-live2d@0.4.4` + `pixi.js@8`（`live2d-example` 已验证可加载）。

## 2. 目标与非目标

### 目标

- Live2D 模型在桌宠窗口渲染：idle 动作组、鼠标跟随、点击反应动作。
- AI 通过**独立的 Live2D 工具集**控制：`set_expression`（切表情）、`play_motion`（播动作）；屏幕位置/缩放复用共享工具。
- 表情/动作清单**从 `.model3.json` 自动发现**，`character.json` 可选注解补中文描述。
- 与静态立绘**共存**：角色按 `render` 字段决定渲染方式；立绘角色行为零改动。
- 鼠标穿透在 Live2D 画布上仍然像素级生效（复用现有掩码命中管道）。
- Live2D 模型文件随现有角色包打包/导入机制流转，无需新增后端命令。

### 非目标

- **不做 TTS 口型同步**（v1 范围外；列入未来扩展）。
- 不为 Live2D 角色支持 `pose / costume` 维度（模型一般无此概念，工具在 Live2D 角色上隐藏）。
- 不在角色管理器里做 Live2D 模型的可视化编辑/预览（v1 用静态缩略图占位或留空）。
- 不修改 Rust 端光标轮询 / data_dir / 角色包导入逻辑。
- 不解决正式分发角色的模型授权问题（项目级待办，见 §8）。
- 不支持单窗口多个 Live2D 模型同屏。

## 3. 决策记录（用户已确认）

- **v1 范围**：核心交互（渲染 + AI 控制表情/动作/屏幕位置），不含口型同步。
- **AI 接入方式**：独立 Live2D 工具集（`set_expression` / `play_motion`），按角色类型动态注册；立绘角色用原有工具。
- **鼠标穿透**：定期（约 8–10fps）对画布降采样快照 → alpha 掩码，复用现有命中管道。
- **表情/动作描述**：加载时从 `.model3.json` 自动发现，`character.json` 的 `live2d` 块可选注解补中文描述，无注解则用原始 ID。
- **渲染架构**：方案 A——平行渲染器 + 平行控制器（`Character.vue` 切换器 + `IllustrationStage` / `Live2DStage` + 两个控制器）。
- **示例模型**：开发用 Live2D 官方免费模型（如 Hiyori，`live2d-example` 已带），**gitignore，不进 repo / 不进发布角色包**。

## 4. 架构

### 4.1 组件边界

```
charStore.data.render ──┬─ "illustration" → IllustrationStage.vue（现有立绘逻辑搬迁）
                        │                      └ useCharacterController（现有）
                        └─ "live2d"       → Live2DStage.vue（新）
                                               ├ pixi Application + Live2DSprite（easy-live2d）
                                               ├ useLive2DController（新）
                                               └ 定期快照 → live2dMask（新）

AI tool_calls
  ├ 立绘角色：set_character_emotion/stance/costume/look（appliesTo:'illustration'）
  ├ Live2D 角色：set_expression / play_motion（appliesTo:'live2d'）
  └ 共享：set_screen_pose / get_character_state / switch_character（appliesTo:'both'，按 render 派发）

registry.getDefinitions(charData)
  ├ 按 appliesTo vs charData.render 过滤工具
  └ 注入枚举：立绘用 emotions/poses/costumes；Live2D 用 manifest 的 expressions/motions

鼠标穿透（passthrough/index.ts，仅主窗口）
  Rust 轮询光标 → cursor-pos 事件 → hitTest
    ├ UI 命中：elementFromPoint → [data-pet-solid]
    └ 角色命中 hitCharacter：
        ├ 立绘：img.img-base 矩形 + alphaMask（现有）
        └ Live2D：canvas 矩形 + live2dMask（新，定期快照）
```

### 4.2 各文件改动

| 文件 | 改动 |
|---|---|
| `src/character/loader.ts` | `CharacterData` 加 `render` + `live2d` 块；`migrateCharacterData` 加 v1→v2（补 `render:"illustration"`）；`CURRENT_VERSION=2`；新增 `live2dModelUrl(id, relPath)` |
| `src/character/live2d/manifest.ts`（新） | `Live2DManifest` 类型 + `loadLive2DManifest(id, data)`：fetch `.model3.json`、解析表情/动作、合并注解 |
| `src/character/live2d/controller.ts`（新） | `useLive2DController()`：包装 `Live2DSprite`，`setExpression/playMotion/setScreenPose/getState/init/dispose` |
| `src/components/Character.vue` | 瘦身为切换器：按 `charStore.data.render` 挂载 `IllustrationStage` 或 `Live2DStage`；保留 `@click` 与就绪态语义 |
| `src/components/IllustrationStage.vue`（新，从 Character.vue 搬迁） | 现有双图淡入淡出 + 姿态样式 + `registerCharacterController/setAgentController/buildMask`，行为零改动 |
| `src/components/Live2DStage.vue`（新） | pixi `Application`（透明）+ `Live2DSprite` 初始化、`Config` 配置、`ready/hit` 事件、注册 `useLive2DController`、挂载快照掩码、卸载销毁 |
| `src/passthrough/live2dMask.ts`（新） | 定期对画布快照降采样 → alpha 掩码（复用 `alphaMask` 提取逻辑，键 `'live2d:current'`） |
| `src/passthrough/index.ts` | `hitCharacter()` 加 Live2D 分支：canvas 矩形 + `live2dMask` 查表 |
| `src/stores/character.ts` | 暴露 `render` computed（默认 `illustration`）；视觉状态结构不变 |
| `src/agent/types.ts` | `Tool` 加 `appliesTo?: 'illustration'|'live2d'|'both'`（默认 `both`） |
| `src/agent/context.ts` | `AgentContext` 加 `live2d: Live2DController|null` + `live2dManifest`；配套 set/get |
| `src/agent/registry.ts` | `getDefinitions` 按 `appliesTo` 过滤 + 注入 manifest 的 expression/motion 枚举 |
| `src/agent/tools/live2d.ts`（新） | `setExpressionTool` / `playMotionTool`（`appliesTo:'live2d'`），经 context 调 Live2D 控制器 |
| `src/agent/tools/character.ts` | 现有立绘工具标 `appliesTo:'illustration'`；`set_screen_pose/get_character_state/switch_character` 标 `both` 并按 render 派发 |
| `src/agent/index.ts` | 注册新增 Live2D 工具 |
| `src/agent/toolMeta.ts` | 加 `set_expression` / `play_motion` 图标 |
| `index.html` | 加 `<script src="/core/live2dcubismcore.js"></script>` |
| `public/core/live2dcubismcore.js`（新） | Cubism Core 运行时（提供 `window.Live2DCubismCore`） |
| `package.json` | 加 `easy-live2d`、升 `pixi.js` 6→8、移除 `pixi-live2d-display` |
| `.gitignore` | 忽略开发用示例 Live2D 模型路径 |
| `README.md` | Live2D 使用说明 + Cubism Core / 模型授权说明 |

## 5. 详细设计

### 5.1 数据模型与迁移

`character.json` 新增字段（向后兼容）：

```jsonc
{
  "version": 2,
  "render": "illustration" | "live2d",   // 缺省/旧角色 → "illustration"
  "live2d": {                             // 仅 render==="live2d" 需要
    "model": "live2d/<dir>/<name>.model3.json", // 相对角色目录
    "scale": 1.0,                         // 可选，相对模型自然尺寸
    "offsetX": 0, "offsetY": 0,           // 可选，sprite 偏移（CSS 像素）
    "idleMotionGroup": "Idle",            // 可选，缺省取 model3 首个动作组
    "tapMotionGroup": "Tap",              // 可选，点击反应动作组
    "mouseFollow": true,                  // 可选，默认 true
    "expressions": { "<id>": "<中文描述>" },   // 可选注解
    "motions":     { "<group>": "<中文描述>" } // 可选注解
  }
}
```

**迁移**：`migrateCharacterData` 增 v1→v2 规则——若无 `render` 则补 `"illustration"`；`CURRENT_VERSION` 升到 2。立绘角色（chryso/kanade/…）自动迁移，行为不变。

### 5.2 加载与自动发现

- `live2dModelUrl(id, relPath)` = `convertFileSrc(${charactersPath}/${id}/${relPath})`（asset 协议，与立绘同源策略一致）。
- `loadLive2DManifest(id, data)`：`fetch(modelUrl)` 解析 `.model3.json` 的 `FileReferences.Expressions[].Name`（表情 ID）与 `FileReferences.Motions`（组名→条目数），与 `live2d.expressions/motions` 注解合并：

```ts
interface Live2DManifest {
  modelUrl: string
  expressions: { id: string; desc: string }[]   // 自动发现，注解补 desc
  motions:     { group: string; count: number; desc: string }[]
  idleGroup: string                              // live2d.idleMotionGroup ?? 首个组
  tapGroup?: string                              // live2d.tapMotionGroup
}
```

发现的列表是合法值唯一来源；注解只补人类可读描述，无注解则 `desc = id/group`。`fetch` asset:// 已被 `alphaMask.ts` 验证可用（CSP `connect-src http:` 放行）。

### 5.3 渲染层（方案 A）

**`Character.vue`（切换器）**：读 `charStore.data.render`，`<component :is>` 或 `v-if` 挂载 `IllustrationStage` / `Live2DStage`；继续向上 emit `click`，维持窗口就绪态语义。

**`IllustrationStage.vue`**：现有 `Character.vue` 的模板/逻辑原样搬迁（双图叠加、`imageStyle`、`registerCharacterController`、`setAgentController`、`buildMask`、预加载），**零行为改动**。

**`Live2DStage.vue`**（参考 `live2d-example/src/App.vue`）：
- `onMounted` 创建 pixi `Application`：`backgroundAlpha: 0`（保持窗口透明）、`resizeTo` 容器、`autoDensity`、`resolution` 取设备像素比。
- `new Live2DSprite()` + `init({ modelPath: manifest.modelUrl, ticker: Ticker.shared, draggable: false })`；按 `live2d.scale/offsetX/offsetY` 设 `sprite.width/height/x/y`；`app.stage.addChild(sprite)`。
- `Config`：`MotionGroupIdle = manifest.idleGroup`、`MouseFollow = live2d.mouseFollow ?? true`、`CubismLoggingLevel = LogLevel_Off`。
- `onLive2D('ready')`：注册 `useLive2DController`（注入 sprite + manifest）到 agent context；按会话持久化的视觉状态恢复表情；启动 idle；启动快照掩码定时器。
- `onLive2D('hit')`：播放 `manifest.tapGroup`（若有）作为点击反应，并向上 emit `click`。
- `onUnmounted` / 切到立绘：`sprite.destroy()` + `app.destroy()` + 清快照定时器；防 HMR/重挂载下重复 init（就绪守卫）。
- **层级与指针**：canvas `position:absolute; inset:0; pointer-events:auto`，**不**带 `data-pet-solid`（与 `<img>` 同策略，交由 alpha 命中决定实/空）；UI（气泡/输入）带 `data-pet-solid` 居上。

### 5.4 Live2D 控制器

```ts
interface Live2DController {
  ready: Ref<boolean>
  currentExpression: Ref<string>
  manifest: Ref<Live2DManifest | null>
  charStore
  init(sprite: Live2DSprite, manifest: Live2DManifest): void
  dispose(): void
  setExpression(id: string): boolean       // 校验 manifest → sprite.setExpression({expressionId})
  playMotion(group: string, no?: number): boolean // 校验 manifest → sprite.startMotion({group, no, priority})
  setScreenPose(key: PoseKey): void         // 预设 → sprite x/y/scale（见下）
  getState(): { character; expression; motionGroups; screen }
}
```

`setScreenPose`：复用 `poses.ts` 的 `PoseKey` 预设，但 Live2D 解释为 sprite 变换——`scale` 乘到 sprite 缩放，`left/translateX/bottom` 折算为 sprite x/y 偏移（相对画布尺寸）。预设的 1/2/4 档缩放对 Live2D 重新标定一组系数（模型自然尺寸基准）。这样 `set_screen_pose` 共享工具对两种渲染都成立，且 `currentScreenPose` 会话持久化复用。

### 5.5 Agent 工具 + registry 过滤 + 枚举注入

- `types.ts`：`Tool` 加 `appliesTo?: 'illustration'|'live2d'|'both'`（不进发给模型的 `definition`，仅注册侧元数据；默认 `both`）。
- `registry.getDefinitions(charData)`：
  1. **过滤**：`appliesTo==='both'` 或 `appliesTo===(charData.render ?? 'illustration')` 才纳入。
  2. **枚举注入**（延续现有 emotion/pose/costume 注入）：对 Live2D 工具，从 context 的 `live2dManifest` 注入 `expression.enum`（表情 ID）+ 描述、`motion.enum`（动作组）+ 描述。
- `tools/live2d.ts`：
  - `set_expression(expression)` → `ctx.live2d.setExpression(id)`；非法值回提示可选清单。
  - `play_motion(motion, [index])` → `ctx.live2d.playMotion(group, no)`。
- `tools/character.ts`：现有四个立绘工具标 `appliesTo:'illustration'`；`get_character_state` / `set_screen_pose` / `switch_character` 标 `both`，内部按 `charData.render` 派发到对应控制器（context 同时持有两个槽）。
- `switch_character` 去耦：把切换逻辑（`loadCharacter` + 存会话 + 刷人格）抽为渲染无关的共享路径；两个 Stage 各自 `watch(charStore.data)` 重挂载，不再依赖立绘 controller 的 `switchCharacter`。

### 5.6 鼠标穿透（快照 → alpha 掩码）

- `live2dMask.ts`：定时器（约 100–125ms）对模型快照——`app.renderer.extract.canvas(sprite)`（或 `extract.pixels`）→ 降采样到 `MASK_MAX_WIDTH` → 提取 alpha（复用 `alphaMask.ts` 的提取代码形态）→ 存键 `'live2d:current'`。仅在主窗口且穿透开启时运行。
- `passthrough/index.ts` `hitCharacter(cx,cy)` 加 Live2D 分支：取 canvas `getBoundingClientRect`，先矩形粗筛，再按 (u,v) 查 `live2dMask`；掩码未就绪退回矩形命中。立绘的 `img.img-base` 分支不变。
- Rust 端、`cursor-pos` 事件、`setIgnoreCursorEvents` 流程全不变。
- 风险点见 §6 spike 2（透明 WebGL 画布的 alpha 提取）；不可行则退回"包围盒矩形命中"。

### 5.7 视觉状态 / 会话持久化复用

`CharacterVisualState`（`emotion/stance/costume/screenPose`）结构不变：Live2D 用 `emotion` 字段存当前 expression id，`stance/costume` 不用，`screenPose` 照常持久化。motion 是瞬时动作，不进持久状态。会话保存/恢复（`session` store）零改动。

### 5.8 构建 / 依赖 / 资源

- **依赖**：加 `easy-live2d@^0.4.4`；升 `pixi.js@^6 → ^8`；移除未用的 `pixi-live2d-display`。`src/` 现无 pixi 引用，6→8 对存量代码无风险。
- **Cubism Core**：`live2dcubismcore.js` 放 `public/core/`，`index.html` 在模块脚本前加 `<script src="/core/live2dcubismcore.js"></script>`（挂 `window.Live2DCubismCore`，easy-live2d 必需）。
- **Vite**：无需 alias；验证 pixi v8 + easy-live2d 在 Vite 6 下打包，关注 `vue-tsc --noEmit` 对 pixi v8 类型的告警。
- **打包/导入**：`scripts/pack-characters.mjs` 已 `addLocalFolder(charDir, id)` 递归，`characters/<id>/live2d/**` 自动纳入；后端 `import_character_pack` 重建 `<id>/...` 不变。**无需改打包脚本。**（注意模型体积，moc3+贴图可达 MB 级，确认 zip 体积可接受。）

### 5.9 错误处理

| 场景 | 行为 |
|---|---|
| `render:"live2d"` 但 `live2d.model` 缺失/路径错 | Live2DStage 记录错误、显示空白桌宠（不崩窗）；日志引导 |
| `.model3.json` fetch/解析失败 | manifest 加载失败 → Live2D 工具枚举为空、控制器不就绪；记录错误 |
| `set_expression`/`play_motion` 传非法值 | 工具回"不支持，可选：…"清单（同立绘工具风格） |
| asset:// 相对路径解析失败（依赖文件加载不到） | 由 spike 1 提前暴露；回退方案见 §6 |
| 透明画布 alpha 提取异常 | 退回包围盒矩形命中 |
| Cubism Core 脚本未加载（`window.Live2DCubismCore` 缺失） | Live2DStage 启动前检测，缺失则报清晰错误 |
| 非 Tauri 环境（无 data_dir） | 与现有逻辑一致：`live2dModelUrl` 返回空，Live2DStage 不渲染 |

## 6. 实施顺序（spike 先行）

1. **Spike 1 — asset:// 加载验证（最高优先，最大未知数）**：把 Hiyori 拷入 `characters/<测试角色>/live2d/`，用 `convertFileSrc` 得 URL，最小化挂一个 `Live2DSprite` 验证模型 + 贴图 + 动作能否经 asset 协议加载（easy-live2d 是否按 model3.json 的 URL 正确解析相对依赖）。失败则定预案（Rust 返回基目录 / 重写引用 / 自定义 loader）。
2. **Spike 2 — 透明画布 alpha 提取**：验证 `renderer.extract` 在 `backgroundAlpha:0` 下能取到正确 alpha；否则锁定包围盒矩形命中方案。
3. 依赖升级（pixi 8 / easy-live2d / 移除 pixi-live2d-display）+ Cubism Core 接入 + 构建跑通。
4. schema/迁移 + loader + manifest（含单测）。
5. 渲染层：拆 `IllustrationStage`（验证立绘零回归）→ 加 `Live2DStage` + 切换器。
6. 控制器 + Live2D 工具 + registry 过滤/注入（含单测）。
7. 穿透快照掩码接入。
8. 端到端联调（穿透、AI 控制、切换、会话恢复）。

## 7. 测试策略

- **单元（vitest + happy-dom，纯逻辑，无需 WebGL）**：
  - `migrateCharacterData` v1→v2（补 `render`）。
  - `loadLive2DManifest`：发现 + 注解合并 + 缺注解回退原始 ID。
  - `registry.getDefinitions`：按 `appliesTo` 过滤；manifest 枚举注入。
  - Live2D 控制器：mock `Live2DSprite`，断言 `setExpression/playMotion` 校验 manifest 并正确调用。
- **手动/集成**（`tauri dev`）：Live2D 渲染、穿透点击透传、AI `set_expression`/`play_motion`、立绘↔Live2D 角色切换、会话恢复表情/屏幕位置。

## 8. 安全 / 授权问题

- **模型授权**（项目级，必须重视）：Live2D 官方免费模型走 Free Material License，个人/小规模使用通常允许，但**再分发**（打进对外发布的角色包）多受限。预案：
  - 开发/测试：用官方免费模型，gitignore，不进 repo / 不进发布包。
  - 正式分发 Live2D 角色：需带商用 + 再分发授权的模型（定制或购买）。
- **Cubism Core 授权**：Live2D 专有运行时，随应用捆绑受其 SDK 许可约束，README 注明。
- 沙箱/穿透模型不变：Live2D 不引入新的文件/命令权限面；模型文件读取走既有 asset 协议 + data_dir 约定。

## 9. 未解决的问题 / 未来扩展

- **TTS 口型同步**（v1 非目标）：用 `speak.ts` 的音频幅度驱动 `ParamMouthOpenY`，作为快速跟进项。
- 角色管理器的 Live2D 预览/参数编辑（缩放/偏移/注解可视化编辑）。
- 多模型同屏 / 模型热切换动画。
- 自动发现的表情/动作中文描述可考虑 i18n。
- 若 asset:// 相对路径方案受限，评估是否需要一个轻量本地静态服务或自定义 Cubism loader。（→ 已由 §10.1 的 `redirectPath` 方案解决，无需本地服务。）

## 10. Phase 0 Spike 结论（2026-06-19，已在真实 Tauri 窗口用 Hiyori 验证）

两个最大风险均已验证通过，并据此修订上文实现细节。

### 10.1 asset:// 加载 —— ✅ 可行（必须用 redirectPath）

- 直接 `Live2DSprite.init({ modelPath: convertFileSrc(...model3.json) })` **失败**：`convertFileSrc` 把整条 Windows 绝对路径编码成单段（分隔符变 `%5C`/`%2F`），Cubism 靠"URL base + 相对路径"拼接 → `.moc3`/贴图/动作全部 404，模型空渲染（仍会误触发 `ready`）。
- **修订（替代 §5.2/§5.3 的加载方式）**：用 `CubismSetting` + `redirectPath` 逐文件显式重定向：

  ```ts
  import { CubismSetting } from 'easy-live2d'
  const modelDir = `${charactersPath}/${id}/${relDir}`           // live2d 模型所在目录（绝对）
  const json = await (await fetch(convertFileSrc(`${modelDir}/${modelFile}`))).json()
  const setting = new CubismSetting({ modelJSON: json })
  setting.redirectPath(({ file }) => convertFileSrc(`${modelDir}/${file}`))
  sprite.init({ modelSetting: setting, ticker: Ticker.shared, draggable: false })
  ```

  验证：5/5 文件（model3/moc3/2 贴图/motion）均 200，模型正常渲染（原始 2976×4175）。
- **据此修订 §5.2**：`loadLive2DManifest` 顺带返回解析后的 `modelJSON` 与 `modelDir`，供 Live2DStage 构造 `CubismSetting`。无需本地静态服务或自定义 loader。

### 10.2 透明画布 alpha 提取 —— ✅ 可行（取主画布，非 sprite）

- `app.renderer.extract.pixels(sprite)` **失败**：easy-live2d 的 Cubism 渲染直接画到主帧缓冲，sprite 自身 RT 为空 → alpha 全 0（尺寸却正常）。
- **修订（替代 §5.6 的快照源）**：掩码取**主 `<canvas>` 元素**快照——`app.init` 传 `preserveDrawingBuffer: true`，定时 `createImageBitmap(canvas)` → 降采样 2D `drawImage` → `getImageData` 读 alpha（复用 `alphaMask.ts` 形态）。验证：200×144 降采样，alpha>16 占 9.0%，alpha 正确保留。
- 代价：`preserveDrawingBuffer:true` 有轻微性能开销，桌宠场景可接受。

### 10.3 其它确认

- 依赖：`easy-live2d@0.4.4` + `pixi.js@8.19` 安装并运行正常；`pixi-live2d-display` 已移除。
- Cubism Core 实际路径为 `public/Live2dCore/live2dcubismcore.js`（用户已放置）；`index.html` 引用 `/Live2dCore/live2dcubismcore.js`（替代 §4.2/§5.8 中的 `public/core/`）。
- easy-live2d 0.4.4 API 已核对：`init({ modelSetting | modelPath })`、`onLive2D('ready'|'hit'|'dragStart'|'dragMove'|'dragEnd')`、`startMotion({group,no,priority})`/`startRandomMotion`、`setExpression({expressionId|index})`、`getMotions(): MotionInfo[]` / `getExpressions(): ExpressionInfo[]`（可作 manifest 发现的补充来源）、`setParameterValueById`（口型同步备用）、`getModelCanvasSize()`、`Config.MotionGroupIdle/MouseFollow`。
