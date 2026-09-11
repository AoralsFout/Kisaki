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

- 中文正文用全角标点 `，。：；（）「」`。现状 1299 处全角、2 处半角。
- 中英文之间留一个空格：`解析 LLM 返回的 tool_calls`。现状 1889 处留空格、8 处不留。
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
| 外观 | character look | 角色的情绪 / 姿势 / 服装 / 屏幕姿态组合 |
| 端口 | port | 依赖倒置的接口，实现由基础设施提供 |
| 服务端 | upstream | 上游 API，区别于本地进程 |
| provider | provider | 保留英文，指 TTS / AI 服务的具体实现方 |
