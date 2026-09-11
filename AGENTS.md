# AGENTS.md

## 语言

**中文是默认语言。回复、注释、文档一律写中文。**

- **回复** — 回答问题、解释代码、总结改动都用中文。提交信息首行保留英文 Conventional Commits 主题（`fix:` / `refactor:` / `chore:`，与本仓库 git 历史一致），正文写中文。
- **注释** — 新增或修改注释时写中文，覆盖 `//`、`/* */`、`/** */`、Vue 模板的 `<!-- -->`、Rust 的 `//!` 与 `///`。
- **文档** — `docs/`、`README.md` 及其他 Markdown 写中文。

### 保持原样的内容

- 代码标识符：变量、函数、类型、文件名、API 字段、Tauri 命令名。
- `src/i18n/locales/` 下每个语言包写各自语言——`en-US.ts` 英文、`ja-JP.ts` 日文、`zh-CN.ts` 简体、`zh-TW.ts` 繁体。这些文件里的注释仍写中文。
- 形式记法与示意图：`src/agent/tools/calculator.ts` 的文法产生式、`src-tauri/src/backup.rs` 的目录树。
- 品牌与产品名：CosyVoice、GPT-SoVITS、Live2D、Tavily、Brave。
- 被注释掉的代码片段；`<reference types="..." />` 这类编译指令。

### 标点与空格

沿用代码库现状：

- 中文正文用全角标点 `，。：；（）「」`。
- 中英文之间留一个空格：`解析 LLM 返回的 tool_calls`。
- 英文技术名词保留原样，不硬译：`provider`、`tool_calls`、`Live2D`、`TTS`。

### 术语表

同一概念全库统一用词；新术语先补进本表再落笔。

| 统一用 | 对应英文 | 含义 |
| --- | --- | --- |
| 兜底 | fallback | 主路径失败后的降级实现 |
| 投影 | projection | 由权威状态派生的只读视图 |
| 归一化 | normalize | 把多种来源整理成同一形态 |
| 检查点 | checkpoint | 一次用户消息触发的回档单位 |
| 回合 | round | 一条 user 消息 + 其后所有 assistant/tool 消息 |
| 轮次 | turn | 模型调用循环中的一次迭代（可能含工具调用） |
| 回合计 | round state | 一次对话回合的运行时状态机（`preparing` / `streaming` / `awaiting-approval` / `executing-tools` / `finalizing` / `completed` / `cancelled` / `failed`），持有者是 `ConversationRun`。`docs/architecture-refactoring-plan.md` 验收结果里写的「对话运行状态」是同一概念，全库统一写作「回合计」 |
| 外观 | character look | 角色的情绪 / 姿势 / 服装 / 屏幕姿态组合 |
| 端口 | port | 依赖倒置的接口，实现由基础设施提供 |
| 组合根 | composition root | 集中构造并接线全部协作者、把端口注入回合的唯一装配点：`src/compositionRoot.ts` |
| 装配 | assembly | 组合根按端口集合构造对象图的过程；缺装配必须显式失败，不静默空转 |
| 服务端 | upstream | 上游 API，区别于本地进程 |
| 批准网关 | approval gateway | 一次工具批准请求（文件 / 命令 / 截图三类）的待决生命周期持有者：`src/application/tools/approvalGateway.ts` |
| provider | provider | 保留英文，指 TTS / AI 服务的具体实现方 |
| 回合编排器 | round orchestrator | 拥有一次对话回合全部编排的无框架依赖模块 |
| `ConversationSession` | conversation session | 回合编排器：`src/application/conversation/conversationSession.ts`，对外只有 `send` / `cancel` / `projection` / `subscribe` / `subscribeMessages` |
| 消息事实出口 | message facts outlet | `ConversationSession.subscribeMessages`：已提交 / 已修订消息的只读订阅，供展示层维护界面消息列表。界面消息列表不在投影里（它属于展示层自有状态），但 id 必须与会话事实一致，因此需要这条只讲事实的出口 |
| `ConversationSessionSnapshot` | conversation session snapshot | 会话实体：一次会话的权威快照（时间线、检查点、外观），定义在 `src/domain/conversation/events.ts` |
| 投影形状 | projection shape | `ConversationProjection`：回合派生的界面状态快照，纯界面开关不在其中 |
| 端口集合 | port set | `ConversationSessionPorts`：构造回合编排器时注入的全部依赖，缺一即构造失败 |
| 文案 | copy | 回合写进界面与用户消息的字符串；由文案端口 `ConversationTexts` 提供，不在回合内硬编码 |

`ConversationSession` 与 `ConversationSessionSnapshot` 名字相近但不是同一个概念：前者只编排一个回合、不持有任何会话归属，由组合根构造；后者是会被持久化的会话聚合。spec #13 沿用 `ConversationSession` 作为编排器名，与既有域类型并存；两边都不要简写成 `Session`。

「回合计」是**定下来的名字**：代码与文档继续用「回合计」，不改为「对话运行状态」；后者只是 `docs/architecture-refactoring-plan.md` 早期验收表里的旧写法，见到时按「回合计」理解。

## Agent skills

### Issue tracker

issue 与 spec 都记在 GitHub Issues（`AoralsFout/Kisaki`），操作走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五个标签，标签名与角色名一致：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文。术语表的唯一定义处是本文件的「术语表」一节，架构决定记在 `docs/adr/`；根目录目前**没有** `CONTEXT.md`（也不必有，见 `docs/agents/domain.md`）。
