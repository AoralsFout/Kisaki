# AGENTS.md

## 语言

**中文是默认语言。回复、注释、文档一律写中文。**

- **回复** — 回答问题、解释代码、总结改动都用中文。
- **注释** — 新增或修改注释时写中文。
- **文档** — `docs/`、`README.md` 及其他 Markdown 写中文。
- **提交信息** — 提交信息首行保留英文 Conventional Commits 主题（`fix:` / `refactor:` / `chore:`），正文写中文。

**专有名词，如品牌、产品名、技术名词等，保留原样，不硬译。**

### 术语表

领域词的唯一定义处是根目录 **`CONTEXT.md`**。

## Agent skills

### Issue tracker

issue 与 spec 都记在 GitHub Issues（`AoralsFout/Kisaki`），操作走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五个标签，标签名与角色名一致：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文。领域词记在根目录 `CONTEXT.md`，架构决定记在 `docs/adr/`。见 `docs/agents/domain.md`。
