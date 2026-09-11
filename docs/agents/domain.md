# 领域文档

本仓库的工程技能在探查代码库前，应按此规则消费领域文档。

## 探查之前先读这些

- 仓库根目录的 **`CONTEXT.md`**，或
- 仓库根目录的 **`CONTEXT-MAP.md`**（若存在）：它指向每个上下文各一份 `CONTEXT.md`，读与当前话题相关的那些。
- **`docs/adr/`**：读与即将改动区域相关的 ADR。多上下文仓库还要看 `src/<context>/docs/adr/` 里的上下文级决策。

这些文件若不存在，**静默继续**。不要指出它们缺失，也不要主动建议先创建。`/domain-modeling` 技能（经 `/grill-with-docs` 和 `/improve-codebase-architecture` 到达）会在术语或决策真正定下来时按需创建。

## 文件结构

单上下文仓库（本仓库即此类）：

```
/
├── CONTEXT.md                        ← 本仓库暂无此文件；既有术语在 AGENTS.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

本仓库目前只有 `docs/adr/` 这一半：术语表落在 `AGENTS.md`，并没有 `CONTEXT.md`。上面这条「文件不存在就静默继续」的规则照旧 —— 只是别为了放术语表而新建一个 `CONTEXT.md`，术语归 `AGENTS.md`。

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 全系统决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文专属决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 用术语表里的词

本仓库**没有 `CONTEXT.md`**：术语表的唯一定义处在根目录 **`AGENTS.md`** 的「术语表」一节（`docs/adr/README.md` 也把 ADR 用词指向那里）。要查某个领域词怎么用，读 `AGENTS.md`，不要去找 `CONTEXT.md`。

输出一旦点名某个领域概念（issue 标题、重构提案、假设、测试名），就用 `AGENTS.md` 术语表里的定义写法，不要漂移到术语表明确回避的同义词。

需要的概念还不在术语表里，是个信号：要么你在发明项目不用的说法（重新考虑），要么真有缺口 —— 真有缺口时先补进 `AGENTS.md` 的术语表再落笔（表头就写着「新术语先补进本表再落笔」）。

## 与 ADR 冲突要挑明

输出若与现有 ADR 矛盾，明确摆出来，不要悄悄覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重开，因为……_
