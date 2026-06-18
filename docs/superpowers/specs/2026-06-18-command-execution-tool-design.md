# 设计：工作目录命令执行工具

- 日期：2026-06-18
- 状态：设计稿
- 相关代码：`src-tauri/src/command.rs`、`src/agent/tools/command.ts`、`src/components/CommandConfirm.vue`、`src/agent/toolPolicy.ts`、`src/stores/chat.ts`、`src/agent/toolMeta.ts`、`src/agent/index.ts`

## 1. 背景与问题

AI 角色需要能在用户授权的工作目录内执行 shell 命令，以完成构建、测试、Git 操作、文本处理等任务。现有工具系统中已有完善的**文件读写工具**（工作目录沙箱 + 用户确认），但缺少命令执行能力。

## 2. 目标与非目标

### 目标

- 让 AI 能在**用户授权的工作目录**内执行 shell 命令
- 命令执行的结果写入**临时文件**，AI 通过已有的 `read_file` 工具查看
- 遵循现有安全模型：**每次执行都必须用户确认**，不设「自动允许」
- 支持可配置超时（默认 30 秒，最大 300 秒），超时自动 kill 子进程
- 跨平台兼容（Windows 用 cmd.exe /C，Unix 用 sh -c）
- 非交互式运行（stdin 不开放）

### 非目标

- 不在工作目录外执行命令
- 不内置命令黑名单（用户确认是唯一的门控）
- 不支持交互式命令（如 `npm init`、`vim`）
- 不修改已有的 `ToolConfirm.vue` 确认逻辑（独立 `CommandConfirm.vue`）
- 不修改 `toolPolicy` 的 `isMutatingTool`/`shouldConfirm` 路径（新增 `isDangerousTool` 独立分支）

## 3. 决策记录（用户已确认）

- **Shell 选择**：跨平台自动检测（Windows → `cmd.exe /C`，其他 → `sh -c`）
- **确认策略**：每次必须确认，无「自动允许」选项（方案 B：独立确认对话框）
- **输出方式**：写入工作目录内临时文件，返回路径给 AI 用 `read_file` 读取
- **超时**：AI 通过参数传入 `timeout_secs`，默认 30 秒
- **命令黑名单**：不设，全凭用户确认把关
- **交互命令**：不支持

## 4. 架构

### 4.1 组件边界

```
用户请求 → AI 回复 (tool_calls)
         → execute_command(name="execute_command", args={command, timeout_secs, description})
         → chat.ts 检测 isDangerousTool → waitCommandConfirm() 
         → CommandConfirm.vue 弹确认框（无 auto-allow）
         → 用户确认 → 调用 Rust 命令 agent_execute_command
         → Rust: 在 root 目录内执行命令，输出写入 <root>/.kisaki_cmd_output/<ts>-<random>.txt
         → 返回 { exit_code, output_path, timed_out }
         → AI 收到结果 → 调用 read_file 读取 output_path 获取实际输出
```

### 4.2 各文件改动

| 文件 | 改动 |
|---|---|
| `src-tauri/src/command.rs`（新） | `agent_execute_command` 命令实现：校验 root、创建输出目录、跨平台 spawn 子进程、超时控制、写入输出文件 |
| `src-tauri/src/lib.rs` | 注册 `agent_execute_command` 到 `invoke_handler` |
| `src/agent/tools/command.ts`（新） | `executeCommandTool` 定义：schema 含 command/description/timeout_secs，handler 调用 Rust 命令 |
| `src/agent/index.ts` | import 并 `registerAll` 注册 `executeCommandTool` |
| `src/agent/toolPolicy.ts` | 新增 `isDangerousTool()` 函数，列出 `execute_command` |
| `src/stores/chat.ts` | 新增 `pendingCommandConfirm`/`commandConfirmResolver`/`waitCommandConfirm()`，在 `executeWithPolicy` 中为 `isDangerousTool` 走独立分支（无 auto-allow） |
| `src/components/CommandConfirm.vue`（新） | 独立确认对话框：展示完整命令、description、工作目录、超时；按钮仅「拒绝」和「允许执行」 |
| `src/App.vue` | 在 `ToolConfirm` 旁嵌入 `CommandConfirm` 组件 |
| `src/agent/toolMeta.ts` | 添加 `execute_command: 'fa-terminal'` |
| `src/i18n/*/app.ts` | 添加命令工具相关 i18n 文案 |

## 5. 详细设计

### 5.1 Rust 命令：`agent_execute_command`

```rust
输入:
  root: String           — 工作目录（由前端 requireRoot 传入）
  command: String        — 要执行的 shell 命令
  timeout_secs: u64      — 超时秒数（默认 30，前端兜底）

流程:
  1. check_root(root) — 验证 root 是有效目录（复用车 fileio.rs 的逻辑，或提取为公共函数）
  2. 创建输出目录 <root>/.kisaki_cmd_output/（幂等）
  3. 生成随机后缀文件名 <timestamp>-<6chars>.txt
  4. 检测平台：target_os = "windows" → shell = "cmd.exe", arg = "/C"
                          其他       → shell = "sh",    arg = "-c"
  5. spawn: Command::new(shell).args([arg, &command]).current_dir(root).stdout(piped).stderr(piped)
  6. 轮询 try_wait()，每次间隔 50ms
     - 超时（≥ timeout_secs）→ child.kill()，标记 timed_out = true
     - 退出 → 收集 stdout + stderr
  7. 将 stdout + stderr 合并写入输出文件
  8. 返回 { exit_code: i32|null, output_path: String, timed_out: bool }

输出文件路径（相对工作目录）: .kisaki_cmd_output/<ts>-<random>.txt
```

### 5.2 前端工具定义

**工具名**：`execute_command`

**参数**：
| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| command | string | 是 | — | 要执行的 shell 命令 |
| description | string | 否 | "" | 执行目的描述（展示在确认框） |
| timeout_secs | integer | 否 | 30 | 超时秒数，最大 300 |

**返回**（handler 组装文本）：
```
命令已执行完毕。
退出码: 0
输出文件: .kisaki_cmd_output/20260618-abc123.txt
请使用 read_file 读取输出文件内容。
```

### 5.3 确认策略

现有 `toolPolicy.ts` 的架构：
- `isMutatingTool` — 改文件工具（判断是否要备份 + 弹确认）
- `shouldConfirm` — 是否弹确认（根据 auto-allow 开关）

新增 `isDangerousTool` 独立分类：
- `execute_command` 归入此类
- `chat.ts` 中对 `isDangerousTool` 直接走确认流程，跳过 `shouldConfirm` 判断
- `CommandConfirm.vue` 只含「拒绝」和「允许执行」两个按钮（无 auto-allow）
- 确认通过后直接执行（不备份文件）

### 5.4 `CommandConfirm.vue` 确认框

与 ToolConfirm 完全独立的组件，通过 `chat.pendingCommandConfirm` 控制显示。

```
布局（宽 460px，深色半透明背景）：
┌─────────────────────────────────────────────────────┐
│ ⚠ 命令执行确认                                       │
│                                                     │
│ 查看 Git 状态               ← description（摘要）     │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ $ git status                                    │ │
│ │                                                 │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ 工作目录: /Users/xxx/projects/my-app                 │
│ 超时设置: 30 秒                                      │
│                                                     │
│              [拒绝]              [允许执行]            │
└─────────────────────────────────────────────────────┘
```

### 5.5 Chat Store 改动

在 `executeWithPolicy` 函数中：

```typescript
// 现有分支：isMutatingTool 走 shouldConfirm → waitUserConfirm（含 auto-allow）
// 新增分支：isDangerousTool 直接走 waitCommandConfirm（无 auto-allow）
if (isDangerousTool(tc.name)) {
  const decision = await waitCommandConfirm(tc, myAbort.signal)
  if (decision === 'reject') {
    return { role: 'tool', tool_call_id: tc.id, content: '用户已拒绝执行该命令。' }
  }
}
```

注：`waitCommandConfirm` 与 `waitUserConfirm` 实现类似，但：
- 使用 `pendingCommandConfirm` 而非 `pendingConfirm`
- 不设置 auto-allow 选项

### 5.6 输出文件位置

- 目录：`<workspaceRoot>/.kisaki_cmd_output/`
- 文件名：`<YYYYMMDD>-<6位随机小写字母数字>.txt`
- 内容：stdout + stderr 合并
- 清理策略：当前不自动清理（由工作目录管理器决定；用户可手动删除 `.kisaki_cmd_output/`）

### 5.7 错误处理

| 场景 | 行为 |
|---|---|
| 工作目录未授权 | handler 抛出引导性错误（复用车文件工具模式） |
| 命令不存在 | Rust 端 spawn 失败，返回友好错误 |
| 命令执行失败（非零退出码） | 正常写入输出文件，返回退出码供 AI 判断 |
| 超时 | kill 子进程，返回 `timed_out: true` + 部分输出 |
| 输出文件写入失败 | 返回错误给 AI |

## 6. 安全问题

- 工作目录沙箱：与文件工具共用 `check_root` + `safe_join_rel` 校验，命令永远在 workspaceRoot 内执行
- 确认门控：`isDangerousTool` 确保每次执行前弹确认框，用户点「允许」才执行
- 无黑名单：设计上不维护命令黑名单（防绕过成本高），全凭用户确认把关
- 临时文件写入 `.kisaki_cmd_output/` 前缀目录，清晰可见，用户可随时清理
- 输出文件路径相对安全（路径组件消毒 + safe_join_rel 校验）

## 7. 未解决的问题 / 未来扩展

- 目前只支持单条命令。未来可扩展为支持多步命令序列或 shell 脚本文件。
- 输出目录 `.kisaki_cmd_output/` 暂不自动清理。未来可加自动清理策略（如保留最近 N 条）。
- 暂不开放自定义 shell 选择（如 PowerShell、bash）。未来可加 `shell` 参数。
