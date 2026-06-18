//! AI 工作目录命令执行
//!
//! 供前端 agent 工具调用，让 AI 在「用户授权的工作目录」内执行 shell 命令。
//! 沙箱模型与 fileio 一致：
//!   - 工作目录（root）由用户在前端通过目录选择框手动授权，按会话存储在前端。
//!   - 输出写入 <root>/.kisaki_cmd_output/，路径返回给前端，AI 通过 read_file 读取。
//!   - 超时控制：默认 30 秒，最大 300 秒，超时自动 kill 子进程。

use std::fs;
use std::io::Read;
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};

use crate::fileio::check_root;

/// 默认超时秒数
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// 最大超时秒数
const MAX_TIMEOUT_SECS: u64 = 300;
/// 轮询间隔（毫秒）
const POLL_INTERVAL_MS: u64 = 50;

/// 在工作目录内执行 shell 命令，将输出写入临时文件后返回路径。
///
/// Windows 使用 cmd.exe /C，其他平台使用 sh -c。
/// 非交互式运行（stdin 不开放），通过轮询 try_wait + 超时 kill 控制生命周期。
///
/// 返回值：
///   - exit_code:   Option<i32> 退出码（超时则为 null）
///   - output_path: String      输出文件相对工作目录的路径（AI 可用 read_file 读取）
///   - timed_out:   bool        是否因超时被强制终止
#[tauri::command]
pub(crate) fn agent_execute_command(
    root: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    if command.trim().is_empty() {
        return Err("命令不能为空".to_string());
    }

    let base = check_root(&root)?;
    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(MAX_TIMEOUT_SECS);

    // ── 创建输出目录 ──
    let output_dir = base.join(".kisaki_cmd_output");
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("创建输出目录失败: {}", e))?;

    // ── 生成输出文件名 ──
    let filename = format!("cmd-{}.txt", uuid::Uuid::new_v4());
    let output_path = output_dir.join(&filename);

    // ── 检测平台 shell ──
    let (shell, arg) = if cfg!(target_os = "windows") {
        ("cmd.exe", "/C")
    } else {
        ("sh", "-c")
    };

    // ── 启动子进程 ──
    let mut child = StdCommand::new(shell)
        .args([arg, &command])
        .current_dir(&base)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动命令失败: {}", e))?;

    // ── 带超时的等待循环 ──
    let start = Instant::now();
    let timed_out: bool;
    let exit_code: Option<i32>;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                timed_out = false;
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if start.elapsed() >= Duration::from_secs(timeout) {
                    // 超时 → kill 子进程
                    let _ = child.kill();
                    // 等待进程真正结束，避免僵尸进程
                    let _ = child.wait();
                    timed_out = true;
                    exit_code = None;
                    break;
                }
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
            Err(e) => return Err(format!("等待命令完成失败: {}", e)),
        }
    }

    // ── 收集 stdout / stderr（读原始字节，用 lossy UTF-8 解码，
    //    兼容 Windows 代码页输出如 CP936/GBK 等非 UTF-8 编码） ──
    let mut stdout_bytes: Vec<u8> = Vec::new();
    let mut stderr_bytes: Vec<u8> = Vec::new();
    if let Some(ref mut out) = child.stdout {
        let _ = out.read_to_end(&mut stdout_bytes);
    }
    if let Some(ref mut err) = child.stderr {
        let _ = err.read_to_end(&mut stderr_bytes);
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = String::from_utf8_lossy(&stderr_bytes);

    // ── 写入输出文件 ──
    let mut output = String::new();
    output.push_str(&format!("$ {}\n", command));
    output.push('\n');
    if timed_out {
        output.push_str(&format!(
            "⚠ 命令执行超时（{} 秒），已强制终止\n\n",
            timeout
        ));
    }
    if !stdout.is_empty() {
        output.push_str("--- stdout ---\n");
        output.push_str(&stdout);
        output.push('\n');
    }
    if !stderr.is_empty() {
        output.push_str("--- stderr ---\n");
        output.push_str(&stderr);
        output.push('\n');
    }
    let exit_str = match exit_code {
        Some(c) => format!("{}", c),
        None => "（超时）".to_string(),
    };
    output.push_str(&format!("--- exit code: {} ---\n", exit_str));

    fs::write(&output_path, &output)
        .map_err(|e| format!("写入输出文件失败: {}", e))?;

    // ── 计算相对路径（供 AI 用 read_file 读取） ──
    let rel_path = output_path
        .strip_prefix(&base)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| filename);

    Ok(serde_json::json!({
        "exit_code": exit_code,
        "output_path": rel_path,
        "timed_out": timed_out,
    }))
}
