# 命令执行工具 v2：执行计划与能力授权

- 日期：2026-08-29
- 状态：已实现
- 适用构建：debug，或显式启用 Rust `experimental-command` feature 的内部构建

## 目标

把旧的“前端确认后直接执行 Shell 字符串”改为后端主导的执行代理：

1. 原生目录选择器签发随机 `workspace_id`，WebView 不能登记任意绝对路径。
2. 模型优先调用 `run_process(program, args[])`，参数不经过 Shell。
3. `run_shell(script)` 仅作为管道、重定向等场景的高风险逃生口。
4. Rust 生成不可变执行计划和 SHA-256 摘要；批准令牌绑定摘要、60 秒过期、只能消费一次。
5. Runner 关闭 stdin，使用环境变量白名单，限制超时和输出，支持取消整棵进程树。
6. stdout/stderr 通过 `kisaki-execution-output` 事件实时展示；完整日志写入应用缓存。
7. 执行前后扫描工作区元数据，结果直接包含变更文件摘要。

## 调用链

```text
LLM run_process / run_shell
  -> agent_prepare_execution(workspace_id, request)
  -> CommandConfirm 展示 Rust 规范化计划
  -> agent_approve_execution(plan_id, digest)
  -> 一次性 approval token
  -> agent_execute_plan(plan_id, token)
  -> 实时输出 / 取消 / 结构化结果 / 变更摘要
```

## 安全边界

`workspace_id` 保护的是“哪些目录曾由用户原生选择”，相对路径工具仍由
`safe_join_rel` 防 traversal、符号链接和 Junction 逃逸。执行计划在启动前再次解析能力，
因此用户撤销工作区后，已准备但未运行的任务不能启动。

当前 Runner 的隔离级别明确标记为 `workspace_unconfined`：`cwd` 被限制在工作区内，
但进程仍使用当前用户权限，能够访问工作区外文件和主机网络。确认界面必须持续展示这一事实。
真正的 OS 沙箱、容器/临时工作树和网络隔离属于后续阶段，不能用当前实现冒充。

## 限额

- 执行计划：5 分钟过期
- 批准令牌：60 秒过期，一次性
- 运行超时：1-300 秒，默认 30 秒
- stdout/stderr：各保留 1 MiB，UI 实时尾部保留 64 KiB
- 工作区扫描：最多 20,000 个文件，最多回报 200 个变更路径
- 完整日志：应用缓存内保留最近 50 份

## 升级行为

旧会话只有 `workspaceRoot` 路径而没有可信 `workspaceId`。升级后不会静默把旧路径重新登记为能力；
用户需要通过“工作区”原生选择器重新选择一次。新能力随后持久化，可跨重启恢复并可主动撤销。
