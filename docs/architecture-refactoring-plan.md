# 架构重构实施方案

制定日期：2026-09-10

## 目标原则

- 一个业务概念只有一个可变状态 Owner。
- Pinia Store 只做 UI 投影，不承担业务编排和持久化。
- `fetch`、`invoke`、`listen`、`localStorage` 只出现在基础设施适配器。
- 业务流程使用显式状态机，不通过布尔组合和组件生命周期表达阶段。
- TTS 是回复提交后的独立副作用，不属于对话请求完成条件。
- 新格式直接落地，不读取或迁移旧会话与旧配置格式；旧文件只保留为不可解析备份。

## 目标结构

```text
AppCompositionRoot
├── SettingsRepository
├── SessionRepository
├── CharacterRuntime
├── ToolExecutionCoordinator
│   ├── ApprovalGateway
│   └── CheckpointService
├── TtsOrchestrator
└── ConversationCoordinator
    ├── ModelClient
    ├── ToolExecutionCoordinator
    └── SessionAggregate
```

依赖方向为 `presentation → application → domain`，基础设施通过端口注入 application。Domain 不依赖 Vue、Pinia 或 Tauri。

## 阶段 0：冻结行为契约

工作内容：

1. 覆盖纯文本、原生工具、文本工具兜底、工具失败/拒绝/超时。
2. 覆盖流式、等待批准、工具执行和翻译阶段的取消。
3. 覆盖会话切换期间后台语音不得写回旧会话。
4. 覆盖角色首帧、renderer 切换和 renderer 未 ready 时的命令。
5. 建立 provider × source × sink 的 TTS 契约矩阵。
6. 引入可注入 Clock/Deadline，测试不得靠真实 sleep。

完成标准：关键流程有黑盒行为契约；后续重构可以替换内部实现而不改变外部语义。

## 阶段 1：建立 Session Aggregate

新格式只持久化一份规范化 timeline：

```ts
interface SessionDocument {
  schemaVersion: 2
  currentSessionId: string
  sessions: ConversationSession[]
}

interface ConversationSession {
  id: string
  title: string
  characterId: string | null
  characterLocked: boolean
  workspaceGrantId: string | null
  timeline: ConversationEvent[]
  checkpoints: Checkpoint[]
  contextState: ContextState
  createdAt: number
  updatedAt: number
}
```

UI Transcript 与 Model Context 分别由纯投影器生成，不再同时持久化 messages/context。

实施步骤：

1. 创建无框架依赖的 SessionAggregate、事件类型与投影器。
2. 创建 SessionRepository 端口和新的 `sessions-v2.json` 适配器。
3. 将 Store 改为 aggregate 的 UI 投影与命令代理。
4. 切换、删除、回档改由 SessionApplicationService 执行。
5. 删除 ChatStore 与 SessionStore 的双向调用和旧格式兼容分支。

## 阶段 2：统一 CharacterRuntime

1. CharacterRuntime 成为角色身份、视觉状态和能力清单的唯一 Owner。
2. Illustration/Live2D 实现 CharacterRenderer 端口，只订阅状态。
3. Renderer 未 ready 时仍接受命令，ready 后应用最新快照。
4. manifest 由 runtime 加载，不再依赖 Stage 生命周期注入。
5. 删除 commandBus、agent controller registry 和双向 watch。

## 阶段 3：统一工具策略、批准和检查点

ToolDescriptor 声明 capabilities、approval、checkpoint、execution 和 appliesTo。

ToolExecutionCoordinator 固定执行顺序：前置条件 → 批准 → 检查点 → handler → 结构化结果。三套 pending confirmation 合并为一个 ApprovalRequest，timeout/abort/resolver 由 ApprovalGateway 统一管理。

## 阶段 4：ConversationRun 状态机

状态包括：`idle`、`preparing`、`streaming`、`awaiting-approval`、`executing-tools`、`finalizing`、`completed`、`cancelled`、`failed`。

1. ConversationCoordinator 取代 ChatStore.sendMessage。
2. 原生与文本工具调用统一适配为 ToolCall。
3. think/say 流式解析移入 ModelStreamDecoder。
4. 回复提交原子写入 Session aggregate 并发布 AssistantCommitted。
5. TTS 订阅 AssistantCommitted，不阻塞 Run 完成。
6. 取消通过状态机事件处理，不比较 AbortController 身份。

## 阶段 5：TTS Provider/Sink 管道

Provider：CosyVoiceProvider、GptSoVitsProvider。

Sink：MediaSourceSink、PcmAudioSink、HtmlAudioSink、Live2DLipSyncSink。

TtsOrchestrator 负责选择 Provider/Sink 和管理 PlaybackSession；批处理作为单块 AudioSource，不再维护平行播放主流程。使用请求级 Tauri Channel 或流句柄替代全局事件。

## 阶段 6：统一设置与网络

1. SettingsRepository 通过 schema 注册 AI/TTS/Search 设置。
2. SecretBackedSetting 统一 Keychain、缓存和失效。
3. 配置同步统一为一个 change stream。
4. RequestExecutor 统一 timeout、retry、cancel、错误分类和脱敏遥测。
5. JsonTransport、StreamingTransport、TauriProxyTransport 处理协议差异。
6. 删除未使用 ApiClient 和业务层直接 fetch/invoke/listen。

## 阶段 7：清理 Composition Root

1. 所有服务、适配器和监听器由 `compositionRoot.ts` 显式创建。
2. 删除模块加载时 `initTools()` 等副作用。
3. App.vue 只负责组件组合和 UI 事件。
4. 删除旧格式、旧 Store API、feature flag 与双实现。
5. 添加依赖方向自动检查。

## 推荐合并顺序

1. 行为契约测试和架构约束。
2. 新 Session Aggregate 与新格式。
3. CharacterRuntime。
4. ToolExecutionCoordinator 与 ApprovalGateway。
5. ConversationRun 状态机。
6. TTS Provider/Sink 管道。
7. SettingsRepository 与 RequestExecutor。
8. 删除旧实现和临时适配器。

## 最终验收指标

| 指标 | 当前 | 目标 |
|---|---:|---:|
| 对话事实表示 | 约 4 份 | 1 个 timeline + 纯投影 |
| 对话运行状态 Owner | 多模块 | 1 个 ConversationRun |
| 工具确认机制 | 3 套 | 1 个 ApprovalGateway |
| 工具执行循环 | 2 套 | 1 套 |
| 角色视觉状态源 | 多份 | 1 个 CharacterRuntime |
| 角色全局注册入口 | 2 套 | 0 |
| TTS 流消费实现 | 至少 2 套 | 1 套 |
| 解密缓存 | 3 个 | 1 个 |
| Store 循环依赖 | Chat ↔ Session | 0 |
| 业务层直接 I/O | 多处 | 0 |

## 当前推进状态

- [x] 架构复杂度热点审查。
- [x] 重构目标与阶段规划。
- [ ] 阶段 0：行为契约和架构约束。
  - [x] 新 Domain 层框架隔离约束。
  - [x] 文件确认等待期取消契约。
  - [ ] 完成批准、角色和 TTS 契约矩阵。
- [x] 阶段 1：Session Aggregate。
  - [x] 新格式事件模型、单会话 Aggregate 与纯投影。
  - [x] SessionCollection 与 Repository 端口。
  - [x] 独立 `sessions-v2.json` 的 Tauri 存储适配器。
  - [x] SessionApplicationService 命令入口。
  - [x] 对话事实事件命令、后台回复修订事件与串行持久化。
  - [x] 回档提升为 Aggregate 命令，统一裁剪 timeline、检查点与压缩上下文，并输出外部文件/角色恢复计划。
  - [x] ChatStore → SessionStore 直接依赖解除，并以架构测试防回归。
  - [x] SessionStore 切换为 v2 投影门面，删除旧 `messages/context` 快照保存、localStorage 迁移和旧 Rust 命令。
- [x] 阶段 2：CharacterRuntime。
  - [x] 无框架依赖的 canonical state、能力校验和 Renderer 端口。
  - [x] renderer 未 ready 时接收命令并在 attach 后应用最新快照。
  - [x] CharacterStore 改为 Runtime 响应式投影。
  - [x] IllustrationController 接入 Renderer 端口并删除重复视觉状态与双向 watch。
  - [x] Live2D 表情/屏幕位置接入 Runtime，并在 manifest ready 后收敛能力。
  - [x] 删除 commandBus 与 agent/context 两套全局控制器注册表；UI/Agent 统一经 Runtime facade 控制角色。
- [x] 阶段 3：ToolExecutionCoordinator。
  - [x] Tool.policy 就地声明 workspace、批准与检查点要求，删除按工具名维护的平行分类表。
  - [x] ApprovalGateway 统一文件、命令、截图三类 pending/resolver/timeout/abort 生命周期。
  - [x] ToolExecutionCoordinator 固定执行前置条件 → 批准 → 检查点 → handler → 结构化结果。
  - [x] 原生与文本工具调用复用同一 Coordinator 路径。
- [x] 阶段 4：ConversationRun。
  - [x] 建立无框架依赖的显式状态机与合法转换约束。
  - [x] 发送、工具执行、统一批准、取消、清空和会话切换接入同一 Run 状态源。
  - [x] `isProcessing` / `isUsingTools` 改为状态机投影，删除分散写入和 `AbortController` 身份判断。
  - [x] think 标签与流式 say 参数解析移入 `ModelStreamDecoder`。
  - [x] 模型回合迭代、上限、取消和异常分类移入 ConversationCoordinator。
  - [x] 原生/文本工具调用统一适配为 ToolCallBatch，并复用同一顺序执行与结果模型。
  - [x] 单轮模型返回解释移入 `ModelTurnInterpreter`，Store 不再判断 provider 返回通道。
  - [x] 建立 `AssistantMessageCoordinator` 提交边界；TTS 仅订阅已提交/修订事件。
  - [x] 将工具调用/结果的会话事实写入与模型上下文投影顺序移入 ConversationCoordinator；旧请求在异步持久化后不得污染新请求上下文。
  - [x] SessionStore 切换到 v2 后，将提交端口接到 Session aggregate 的原子 `AssistantCommitted`。
- [x] 阶段 5：TTS 管道。
  - [x] 建立无框架依赖的 `TtsPlaybackOrchestrator` 与显式 PlaybackSession 状态流。
  - [x] 将聊天与角色试听的播放入口，以及去重、取消、替换和遥测生命周期收敛到 Orchestrator。
  - [x] 将 CosyVoice / GPT-SoVITS 的配置预检与批量合成拆为统一 `TtsProvider`，输出 `AudioSource`。
  - [x] 将两套流式合成接入 Provider/`AudioSource` 契约：Provider 产出 `StreamedAudioSource`。
  - [x] 建立 `AudioSink` 端口与按能力选择机制；HTMLAudio 与 Live2D 口型已拆为独立 Sink，Engine 不再直接持有缓冲播放实现。
  - [x] 将 MediaSource / PCM 两条流式播放通道拆为 `MediaSourceStreamSink` 与 `PcmStreamSink`。
  - [x] 用请求级 Tauri Channel 替换全局 `tts-audio-chunk` 事件，删除 stream_id 手工过滤。
- [ ] 阶段 6：设置与网络。
- [ ] 阶段 7：清理。
