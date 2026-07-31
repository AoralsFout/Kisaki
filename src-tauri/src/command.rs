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
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::fileio::check_root;

/// 默认超时秒数
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// 最大超时秒数
const MAX_TIMEOUT_SECS: u64 = 300;
/// 轮询间隔（毫秒）
const POLL_INTERVAL_MS: u64 = 50;
/// 单条命令捕获输出的存储上限（超出部分继续排空但丢弃，避免子进程写满管道被阻塞）
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// 管道读取块大小
const READ_CHUNK_SIZE: usize = 8192;
/// 等待管道收尾的最长时间（防止子进程无法被杀死时前端永久挂起）
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// 命令输出目录最多保留的文件数（超出删除最旧的）
const MAX_CMD_OUTPUT_FILES: usize = 20;

/// 把管道读到 EOF（并行排空用）。返回（已保存的字节, 是否超出存储上限被截断）。
fn drain_pipe(mut pipe: impl Read) -> (Vec<u8>, bool) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; READ_CHUNK_SIZE];
    let mut truncated = false;
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n <= MAX_OUTPUT_BYTES {
                    buf.extend_from_slice(&chunk[..n]);
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

/// 清理命令输出目录，只保留最近的 MAX_CMD_OUTPUT_FILES 个文件（按修改时间）。
fn prune_output_dir(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, p))
        })
        .collect();
    if files.len() <= MAX_CMD_OUTPUT_FILES {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - MAX_CMD_OUTPUT_FILES;
    for (_, p) in files.into_iter().take(excess) {
        let _ = fs::remove_file(&p);
    }
}

/// 终止子进程及其进程树。
/// - Windows：taskkill /T /F（cmd.exe 的子进程也一并终止）
/// - Unix：子进程以独立进程组启动（process_group(0)），对整组发 SIGTERM
#[cfg(windows)]
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    let _ = StdCommand::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    // 负 pid 表示向该进程组广播信号
    let _ = StdCommand::new("kill").arg(format!("-{}", pid)).output();
    let _ = child.kill();
    let _ = child.wait();
}


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
    let mut cmd = StdCommand::new(shell);
    cmd.args([arg, &command])
        .current_dir(&base)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Unix：放入独立进程组，超时时可整组终止（含孙进程）
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动命令失败: {}", e))?;

    // ── 并行排空 stdout / stderr 管道 ──
    // 旧实现先等进程退出再读管道：一旦输出超过管道缓冲（Windows 常见 4-64KB），
    // 子进程写满管道被阻塞、永不退出，最终被误判为超时。这里边等边排空。
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let (tx, rx) = mpsc::channel::<(&'static str, Vec<u8>, bool)>();
    if let Some(p) = stdout_pipe {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let (bytes, truncated) = drain_pipe(p);
            let _ = tx.send(("stdout", bytes, truncated));
        });
    }
    if let Some(p) = stderr_pipe {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let (bytes, truncated) = drain_pipe(p);
            let _ = tx.send(("stderr", bytes, truncated));
        });
    }
    drop(tx);

    // ── 带超时的等待循环 ──
    let start = Instant::now();
    let (timed_out, exit_code) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break (false, status.code());
            }
            Ok(None) => {
                if start.elapsed() >= Duration::from_secs(timeout) {
                    // 超时 → 终止整棵进程树（避免 cmd.exe 已死、孙进程仍在运行）
                    kill_process_tree(&mut child);
                    break (true, None);
                }
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
            Err(e) => return Err(format!("等待命令完成失败: {}", e)),
        }
    };

    // ── 取回并行排空的输出（进程已结束，管道应很快 EOF；仍加 5s 兜底，
    //    防止子进程无法被杀、管道迟迟不关时前端永久挂起） ──
    let mut stdout_bytes: Vec<u8> = Vec::new();
    let mut stderr_bytes: Vec<u8> = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut pending = 2;
    let drain_deadline = Instant::now() + PIPE_DRAIN_TIMEOUT;
    while pending > 0 {
        let now = Instant::now();
        if now >= drain_deadline {
            break;
        }
        match rx.recv_timeout(drain_deadline - now) {
            Ok(("stdout", bytes, truncated)) => {
                stdout_bytes = bytes;
                stdout_truncated = truncated;
                pending -= 1;
            }
            Ok(("stderr", bytes, truncated)) => {
                stderr_bytes = bytes;
                stderr_truncated = truncated;
                pending -= 1;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    // 读原始字节，用 lossy UTF-8 解码（兼容 Windows 代码页输出如 CP936/GBK 等非 UTF-8 编码）
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
    if stdout_truncated || stderr_truncated {
        output.push_str(&format!(
            "⚠ 输出超过 1 MiB 存储上限，超出部分已丢弃（不影响命令执行）\n\n"
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
    // 限制 .kisaki_cmd_output 目录大小，避免命令输出文件无限堆积
    prune_output_dir(&output_dir);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_pipe_respects_cap() {
        let big = vec![b'x'; MAX_OUTPUT_BYTES + 1000];
        let (buf, truncated) = drain_pipe(&big[..]);
        assert_eq!(buf.len(), MAX_OUTPUT_BYTES);
        assert!(truncated, "超出上限应标记截断");
    }

    #[test]
    fn drain_pipe_small_untouched() {
        let data = b"hello world";
        let (buf, truncated) = drain_pipe(&data[..]);
        assert_eq!(buf, data);
        assert!(!truncated);
    }

    #[test]
    fn prune_output_dir_keeps_only_latest() {
        let dir = std::env::temp_dir().join(format!(
            "kisaki-prune-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        for i in 0..25 {
            fs::write(dir.join(format!("cmd-{}.txt", i)), b"x").unwrap();
        }
        prune_output_dir(&dir);

        let remaining = fs::read_dir(&dir).unwrap().count();
        assert_eq!(remaining, MAX_CMD_OUTPUT_FILES);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 回归测试：输出远超管道缓冲（约 80KB > 默认 4-64KB）时，
    /// 旧实现会因管道写满而假超时；新实现应正常完成并完整保存输出。
    #[test]
    fn chatty_command_does_not_hang() {
        let base = std::env::temp_dir().join(format!(
            "kisaki-cmd-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let command = chatty_command();
        let result =
            agent_execute_command(base.to_string_lossy().into_owned(), command, Some(15));
        let json = result.expect("命令执行应成功");

        assert_eq!(
            json["timed_out"], false,
            "输出量大不应假超时: {}",
            json
        );
        assert_eq!(json["exit_code"], 0);

        let rel = json["output_path"].as_str().unwrap();
        let content = fs::read_to_string(base.join(rel)).unwrap();
        assert!(content.contains("end-of-output"), "输出应完整保存");

        let _ = fs::remove_dir_all(&base);
    }

    fn chatty_command() -> String {
        #[cfg(windows)]
        {
            // 输出 ~85KB（2000 行 × ~42 字符），远超 cmd 管道缓冲。
            // 注意 %i 后必须跟空格：cmd 变量名贪婪展开，紧跟 - 会被当成变量名一部分。
            "for /L %i in (1,1,2000) do @echo 0123456789012345678901234567890123456789-%i & echo end-of-output"
                .to_string()
        }
        #[cfg(not(windows))]
        {
            "i=0; while [ $i -lt 2000 ]; do echo line-$i-abcdefghijklmnopqrstuvwxyz0123456789; i=$((i+1)); done; echo end-of-output"
                .to_string()
        }
    }
}
