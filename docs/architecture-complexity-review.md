# 架构复杂度热点审查

审查日期：2026-09-10

## 范围与方法

本次为只读架构审查。盘点范围包含 `src` 与 `src-tauri/src` 的 194 个核心代码文件（约 3.48 万行），并重点追踪启动、对话、会话、Agent 工具、角色运行时、TTS、设置与跨窗口通信链路。

审查关注历史演进造成的逻辑碎片化，不讨论代码风格和普通字面重复。收益数字为基于静态依赖和状态数量的保守估计。

## 1. 对话执行被实现成 ChatStore 内的隐式状态机

- 问题：`sendMessage()` 同时负责请求守卫、UI 气泡、上下文、流式解析、工具循环、权限确认、文件备份、翻译、TTS、持久化和遥测。`src/stores/chat.ts` 共 1,955 行、约 132 个分支，是最高频修改的核心热点。
- 当前 Owner：`ChatStore` 是事实总协调器；`ai/client`、`AgentService`、`toolPolicy`、`SessionStore`、`TtsEngine` 和多个确认组件分别承担局部步骤。
- 理想 Owner：应用层 `ConversationRunCoordinator`，通过显式状态管理一次请求；ChatStore 只保存 UI 投影。
- 复杂度根源：
  - Essential：LLM 流式输出、多轮工具调用、用户批准、取消、TTS。
  - Accidental：以布尔量、AbortController、resolver、闭包和最终清理分支模拟状态机；原生 function call 与文本工具兜底各有一套执行循环。
- 证据：
  - `src/stores/chat.ts:449`：运行态集中声明。
  - `src/stores/chat.ts:488`、`:531`、`:587`：三套同构确认等待机制。
  - `src/stores/chat.ts:980`：权限、批准、备份和执行混在请求闭包中。
  - `src/stores/chat.ts:1158`、`:1231`：文本工具与原生工具两条执行路径。
  - `src/stores/chat.ts:1407`：通过 AbortController 身份判断请求所有权。
- 建议架构：建立 Conversation Run aggregate，统一承载 requestId、phase、cancel token、工具批次和终态；所有模型输出先适配为统一事件；工具确认通过统一 ApprovalGateway 完成。
- 收益：约 18 个关联运行态字段/句柄收敛为一个 Run 状态；三套确认机制变为一套；两套工具批处理循环变为一套；ChatStore 的直接业务依赖可降至 2–3 个端口。
- 风险：高。必须锁定取消、工具协议配对、流式显示和后台语音行为后逐步替换。

## 2. 会话聚合被 ChatStore 与 SessionStore 双重持有

- 问题：当前对话同时存在 `ChatStore.messages`、`ChatContext`、`Session.messages`、`Session.context` 四种表示。两个 Store 互相 import、互相调用，保存与恢复依赖手工复制。
- 当前 Owner：ChatStore 持有活动消息与协议上下文；SessionStore 又持有消息、协议快照、角色、工作区和检查点。ChatStore 有 13 处即时访问 SessionStore，SessionStore 有 5 处反向访问 ChatStore。
- 理想 Owner：`ConversationSession` 作为唯一聚合根；`SessionRepository` 只负责持久化；UI 和模型上下文都由聚合事件投影生成。
- 复杂度根源：
  - Essential：多会话、持久化、历史恢复、文件回档。
  - Accidental：活动态与持久态互相复制；保存动作散落在添加消息、后台语音、清空、模型刷新和请求结束等生命周期。
- 证据：
  - `src/stores/session.ts:30`：Session 同时容纳消息、上下文、角色状态、授权和检查点。
  - `src/stores/session.ts:168`：初始化直接要求 ChatStore 先初始化。
  - `src/stores/session.ts:404`：保存时从 ChatStore 复制两份表示。
  - `src/stores/session.ts:377`：切换时反向调用 `loadMessages`。
  - `src/stores/session.ts:655`：回档同时协调生成、Rust 文件、角色和聊天上下文。
- 建议架构：使用规范化的 Session timeline 记录用户消息、模型步骤、工具调用/结果和最终回复，UI Transcript 与 Model Context 由纯投影器生成。
- 收益：消除 Store 循环依赖和约 18 个跨 Store 访问点；去除至少两份长期可变副本；保存触发点收敛至聚合命令提交边界。
- 风险：高。涉及持久化和回档语义；本项目决定不兼容旧格式，可显著降低迁移复杂度。

## 3. 角色运行时状态有多个 Owner，并依赖组件挂载时序

- 问题：情绪、姿势、服装和屏幕位置在 CharacterStore 与 illustration controller 中各存一份；Live2D 另有 expression；Session 和 Checkpoint 再保存快照。同步依赖 watch，Agent 控制能力取决于 Stage 是否已挂载并注册。
- 当前 Owner：CharacterStore、CharacterController、Live2DController、SessionStore、agent/context、commandBus、两个 Stage 和 App.vue。
- 理想 Owner：与 Vue 生命周期无关的 `CharacterRuntime`；illustration/Live2D 仅作为 Renderer Adapter。
- 复杂度根源：
  - Essential：两种渲染引擎、角色切换、会话恢复。
  - Accidental：四个视觉字段双份响应式存储；同一 controller 同时注册到 commandBus 和 agent/context；工具执行依赖 onMounted/onReady。
- 证据：
  - `src/stores/character.ts:35`：Store 的四字段状态。
  - `src/character/controller.ts:25`：Controller 再声明一套。
  - `src/character/controller.ts:225`：反向 watch 与“跳过自身同步”。
  - `src/components/IllustrationStage.vue:66`：同一控制器注册两次。
  - `src/components/Live2DStage.vue:34`：Live2D ready 后才注入控制器和 manifest。
  - `src/agent/context.ts:16`：Agent 容器保存四份角色运行时引用。
- 建议架构：CharacterRuntime 持有 canonical state 和能力清单；Renderer 订阅状态；Agent、DevPanel 与 UI 统一发送 runtime command。
- 收益：删除 Controller 中重复的四个视觉状态源、两个双向 watch 和两套全局注册入口；减少工具层的 renderer/controller 就绪分支。
- 风险：中高。主要风险是首帧、图片兜底、Live2D attach/detach 和口型播放器注册。

## 4. TTS 的提供者、模式与播放器矩阵集中膨胀

- 问题：TtsEngine 同时处理 CosyVoice/GPT-SoVITS、批处理/流式、HTMLAudio/WebAudio/MediaSource/Live2D 口型。前端 706 行、约 68 个分支；Rust 端另有 604 行、约 29 个分支。
- 当前 Owner：ChatStore.triggerTts、TtsEngine、gptsovits.ts、Rust tts.rs 和 Live2DController 共同承担一次播放生命周期。
- 理想 Owner：`TtsOrchestrator` 管理播放会话；`TtsProvider` 产生统一 AudioSource；`AudioSink` 负责具体播放。
- 复杂度根源：
  - Essential：提供者协议、编码和播放能力不同。
  - Accidental：中央类按 provider、stream、lip-sync 层层分支；共享 `tts-audio-chunk` 靠 stream_id 手工过滤；ChatStore 还额外持有去重和后台取消状态。
- 证据：
  - `src/tts/speak.ts:117`：主分派矩阵。
  - `src/tts/speak.ts:247`、`:491`：两套流式消费实现。
  - `src/tts/speak.ts:208`：Live2D 强制回退批处理。
  - `src/stores/chat.ts:889`、`:1484`：ChatStore 持有后台准备、播放和去重状态。
  - `src-tauri/src/tts.rs:378`、`:546`：Rust 两套流命令发送同一全局事件。
- 建议架构：统一 AudioSource/PlaybackSession 协议，拆出 Provider 与 Sink；使用请求级 Tauri Channel 或流句柄替代全局事件。
- 收益：两套流监听循环收敛为一套；业务层只观察一个播放状态；中央分派分支预计减少一半以上。
- 风险：高。需要真实设备和多音频格式回归。

## 5. 外部服务配置、密钥与请求策略存在多套平行机制

- 问题：AI、CosyVoice、Search 各自复制 localStorage、解密缓存、Keychain 迁移和 storage 监听；跨窗口同步又混用 storage 与 Tauri event。项目存在未被使用的通用 ApiClient，但实际请求仍分别实现超时、重试和错误映射。
- 当前 Owner：ai/client.ts、tts/config.ts、searchConfig.ts、secretStore.ts、设置组件、App、Onboarding、apiClient.ts 与 searchHttp.ts。
- 理想 Owner：schema 驱动的 `SettingsRepository` 与统一的 `RequestExecutor`。
- 复杂度根源：
  - Essential：Provider 默认值、验证规则和协议不同。
  - Accidental：三个独立明文缓存、三套迁移代码、三套 storage listener，以及多套网络策略。
- 证据：
  - `src/ai/client.ts:38`、`src/tts/config.ts:45`、`src/agent/tools/searchConfig.ts:47`：三份同构密钥生命周期。
  - `src/App.vue:339`：App 预热缓存并监听额外 Tauri 事件。
  - `src/ai/apiClient.ts:50`：完整但无人使用的通用客户端。
  - `src/ai/client.ts:178`、`src/agent/tools/searchHttp.ts:44`：实际代码又各自实现请求策略。
- 建议架构：SecretBackedSetting 统一 load/save/invalidate；配置变更使用单一 change stream；RequestExecutor 统一 timeout、retry、cancel、错误分类与敏感日志。
- 收益：三个解密缓存和三个 storage listener 归一；预计移除约 200 行同构密钥代码；四类请求策略收敛为一套。
- 风险：中高。新格式无需读取旧配置，但仍应保留旧文件/键作为不可解析备份，避免不可恢复删除。

## 总体优先级

1. Conversation Run 与 Session Aggregate 边界。
2. CharacterRuntime 单一状态源。
3. 工具批准与执行协调器。
4. TTS Provider/Sink 管道。
5. SettingsRepository 与 RequestExecutor。

最优先的动作不是继续拆小 ChatStore，而是先建立 Conversation Run 与 Session Aggregate。否则其它局部重构仍会被 ChatStore 的总协调职责重新吸收。
