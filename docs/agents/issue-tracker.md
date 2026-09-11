# Issue 追踪：GitHub

本仓库的 issue 和 spec 都是 GitHub issue。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，同时取 labels。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label`、`--state`。
- **评论**：`gh issue comment <number> --body "..."`
- **加 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在 clone 内运行 `gh` 会自动识别。本仓库远端是 `AoralsFout/Kisaki`。

## PR 是否作为 triage 入口

**PR 作为需求入口：否。**（若本仓库把外部 PR 当需求处理，改成 `yes`；`/triage` 会读这个开关。）

设为 `yes` 时，PR 走和 issue 相同的标签与状态，命令换成 `gh pr` 版本：

- **读 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的（丢掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，裸 `#42` 可能是两者之一：先 `gh pr view 42`，失败再 `gh issue view 42`。

## 技能说「发布到 issue tracker」时

建一个 GitHub issue。

## 技能说「取出相关工单」时

跑 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个 issue，**子工单**是挂在它下面的 issue。

- **Map**：一个打了 `wayfinder:map` 标签的 issue，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub sub-issue 挂到 map 上（sub-issues 端点走 `gh api`）。环境不支持 sub-issue 时，把子工单加进 map 正文的任务列表，并在子工单正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后 assign 给推进的开发者。
- **阻塞**：用 GitHub 原生 issue 依赖，这是 UI 可见的规范表示。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 也不是 `node_id`）。GitHub 用 `issue_dependencies_summary.blocked_by` 报告未关闭的阻塞方（实时闸门）。不支持依赖时，退化为子工单正文顶部的 `Blocked by: #<n>, #<n>` 行。所有阻塞方关闭后，工单即解除阻塞。
- **前沿查询**：列出 map 下未关闭的子工单（`gh issue list --state open`，限定在 map 的 sub-issue / 任务列表内），丢掉有未关闭阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里还有未关闭 issue）或已有 assignee 的；按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写操作。
- **完成**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加到 map 的 Decisions-so-far。
