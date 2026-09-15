# Kisaki

Kisaki 是一个 Tauri + Vue 3 桌面桌宠应用：AI 对话、TTS 语音播报、Live2D 角色外观。本仓库是单上下文，本文件是该上下文的词汇表 —— 只定义领域词，不描述实现。

## Language

同一概念全库统一用词；新术语先补进本表再落笔。

### 回合与会话

**回合** (round)：
一条 user 消息，加上其后全部 assistant 与 tool 消息。

**轮次** (turn)：
模型调用循环中的一次迭代，可能含一次工具调用。

**回合计** (round state)：
一次回合的运行时状态机，持有者是 `ConversationRun`。
_Avoid_: 对话运行状态

**检查点** (checkpoint)：
一次用户消息触发的回档单位。

**回合编排器** (`ConversationSession`)：
拥有一次回合全部编排、不依赖框架的模块，对外只有 `send` / `cancel` / `projection` / `subscribe` / `subscribeMessages`。
_Avoid_: Session

**会话实体** (`ConversationSessionSnapshot`)：
一次会话的权威快照 —— 时间线、检查点、外观。与回合编排器名字相近，但不是一回事：它会被持久化，而回合编排器只编排一个回合、不持有任何会话归属。
_Avoid_: Session

**消息事实出口** (message facts outlet)：
`ConversationSession.subscribeMessages` —— 已提交与已修订消息的只读订阅，供展示层维护界面消息列表。界面消息列表本身属于展示层自有状态，不在投影里，但它的 id 必须与会话事实一致，因此需要这条只讲事实的出口。

**文案** (copy)：
回合写进界面与用户消息的字符串，由文案端口 `ConversationTexts` 提供，不在回合内硬编码。

### 投影

**投影** (projection)：
由权威状态派生的只读视图。

**投影形状** (`ConversationProjection`)：
回合派生出的界面状态快照；纯界面开关不在其中。

### 依赖与装配

**端口** (port)：
依赖倒置的接口，实现由基础设施提供。

**端口集合** (`ConversationSessionPorts`)：
构造回合编排器时注入的全部依赖，缺一即构造失败。

**组合根** (composition root)：
集中构造并接线全部协作者、把端口注入回合的唯一装配点。

**装配** (assembly)：
组合根按端口集合构造对象图的过程。缺装配必须显式失败，不静默空转。

### 上游与降级

**服务端** (upstream)：
上游 API，区别于本地进程。

**provider**：
保留英文，指 TTS / AI 服务的具体实现方。

**兜底** (fallback)：
主路径失败后的降级实现。

**归一化** (normalize)：
把多种来源整理成同一形态。

### 角色与工具

**外观** (character look)：
角色的情绪 / 姿势 / 服装 / 屏幕姿态组合。

**批准网关** (approval gateway)：
一次工具批准请求（文件 / 命令 / 截图三类）的待决生命周期持有者。

### Rust 应用状态

**数据目录值对象** (`AppPaths`)：
角色、日志、检查点备份、会话、工作目录授权记录与执行输出的不可变位置集合。

**工作目录授权表** (`WorkspaceGrants`)：
原生目录选择器确认的工作目录与不透明能力 id 之间的授权关系集合；同一路径的不同能力 id 是独立授权。

**执行注册表** (`ExecutionRegistry`)：
待批准执行计划、运行中任务与任务取消标记的共同持有者，代表一次应用运行中的执行状态。
