//! AI 任务执行代理（v2）
//!
//! 执行分成 prepare（后端规范化）、approve（摘要绑定的一次性批准）和
//! execute（只消费已批准计划）三个阶段。Runner 会流式发送输出、支持取消、
//! 使用干净环境并限制时间和日志大小。
//!
//! 这仍不是 OS 级沙箱。被执行程序仍拥有当前用户权限，公开计划会如实标记
//! `workspace_unconfined`，避免把 `current_dir` 误称为文件系统隔离。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::app_paths::AppPaths;
use crate::path::safe_join_rel;
use crate::workspace_grants::WorkspaceGrants;

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const POLL_INTERVAL_MS: u64 = 40;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_TAIL_BYTES: usize = 64 * 1024;
const READ_CHUNK_SIZE: usize = 8192;
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const APPROVAL_TTL: Duration = Duration::from_secs(60);
const PLAN_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ENV_BYTES: usize = 8 * 1024;
const MAX_SNAPSHOT_FILES: usize = 20_000;
const MAX_CHANGED_FILES: usize = 200;
const MAX_EXECUTION_LOGS: usize = 50;

static OUTPUT_PATHS: OnceLock<Arc<AppPaths>> = OnceLock::new();
static PLANS: LazyLock<Mutex<HashMap<String, StoredPlan>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CANCELLED_JOBS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static ACTIVE_JOBS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct ActiveJobGuard(String);

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = ACTIVE_JOBS.lock() {
            jobs.remove(&self.0);
        }
        if let Ok(mut cancelled) = CANCELLED_JOBS.lock() {
            cancelled.remove(&self.0);
        }
    }
}

/// 撤销工作区时丢弃待批准计划，并取消仍在该能力下运行的任务。
pub(crate) fn revoke_workspace_tasks(workspace_id: &str) {
    if let Ok(mut plans) = PLANS.lock() {
        plans.retain(|_, plan| plan.public.workspace_id != workspace_id);
    }
    let active = ACTIVE_JOBS
        .lock()
        .map(|jobs| {
            jobs.iter()
                .filter(|(_, id)| id.as_str() == workspace_id)
                .map(|(job, _)| job.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Ok(mut cancelled) = CANCELLED_JOBS.lock() {
        cancelled.extend(active);
    }
}

/// 迁移期仅共享组合根已准备的 AppPaths，不再单独构造执行输出位置。
pub(crate) fn init_output_dir(paths: Arc<AppPaths>) -> Result<(), String> {
    OUTPUT_PATHS
        .set(paths)
        .map_err(|_| "命令日志目录已初始化".to_string())
}

fn output_dir() -> PathBuf {
    OUTPUT_PATHS
        .get()
        .expect("AppPaths 未装配")
        .execution_output_dir()
        .to_path_buf()
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PrepareExecutionRequest {
    pub workspace_id: String,
    pub kind: String,
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub script: Option<String>,
    pub cwd: Option<String>,
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub intent: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ExecutionPlan {
    pub id: String,
    pub digest: String,
    pub workspace_id: String,
    pub kind: String,
    pub display_command: String,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub script: Option<String>,
    pub shell: Option<String>,
    pub cwd: String,
    pub cwd_relative: String,
    pub timeout_secs: u64,
    pub env_keys: Vec<String>,
    pub intent: String,
    pub isolation: String,
    pub network: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
enum ExecutionKind {
    Process {
        executable: String,
        args: Vec<String>,
    },
    Shell {
        script: String,
    },
}

#[derive(Clone, Debug)]
struct Approval {
    token: String,
    expires_at: Instant,
}

#[derive(Clone, Debug)]
struct StoredPlan {
    public: ExecutionPlan,
    root: PathBuf,
    cwd: PathBuf,
    kind: ExecutionKind,
    env: BTreeMap<String, String>,
    created_at: Instant,
    approval: Option<Approval>,
}

#[derive(Clone, Debug, Serialize)]
struct ExecutionOutputEvent {
    job_id: String,
    seq: u64,
    stream: String,
    chunk: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ExecutionResult {
    pub job_id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub output_ref: String,
    pub duration_ms: u128,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
    pub changed_files: Vec<String>,
    pub changes_truncated: bool,
    pub isolation: String,
}

fn command_available() -> Result<(), String> {
    if cfg!(any(debug_assertions, feature = "experimental-command")) {
        Ok(())
    } else {
        Err("正式版未启用实验性命令执行功能".to_string())
    }
}

fn validate_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    let mut total = 0usize;
    for (key, value) in env {
        if key.is_empty()
            || !key
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            return Err(format!("环境变量名不合法: {}", key));
        }
        let upper = key.to_ascii_uppercase();
        if [
            "TOKEN",
            "SECRET",
            "PASSWORD",
            "PASSWD",
            "PRIVATE_KEY",
            "API_KEY",
        ]
        .iter()
        .any(|needle| upper.contains(needle))
        {
            return Err(format!("拒绝向命令注入疑似敏感环境变量: {}", key));
        }
        if value.contains('\0') {
            return Err(format!("环境变量值包含 NUL: {}", key));
        }
        total = total.saturating_add(key.len() + value.len());
    }
    if total > MAX_ENV_BYTES {
        return Err(format!("环境变量总大小超过 {} 字节", MAX_ENV_BYTES));
    }
    Ok(())
}

fn resolve_cwd(root: &Path, cwd: Option<&str>) -> Result<(PathBuf, String), String> {
    let rel = cwd.unwrap_or(".").trim();
    let rel = if rel.is_empty() { "." } else { rel };
    let resolved = safe_join_rel(root, rel)?;
    if !resolved.is_dir() {
        return Err("命令工作目录不存在或不是目录".to_string());
    }
    let display = if rel == "." {
        ".".to_string()
    } else {
        rel.replace('\\', "/")
    };
    Ok((resolved, display))
}

fn quote_display_arg(arg: &str) -> String {
    if arg
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-._/:\\".contains(&b))
    {
        arg.to_string()
    } else {
        format!("{:?}", arg)
    }
}

fn resolve_program(root: &Path, program: &str) -> Result<String, String> {
    let trimmed = program.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("程序名不能为空".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("不接受绝对程序路径；请使用 PATH 中的程序名或工作区内相对路径".to_string());
    }
    let basename = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    if ["cmd", "powershell", "pwsh", "sh", "bash", "zsh", "fish"].contains(&basename.as_str()) {
        return Err(
            "run_process 不允许启动 Shell 解释器；需要 Shell 语法时请使用 run_shell".to_string(),
        );
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        let resolved = safe_join_rel(root, trimmed)?;
        if !resolved.is_file() {
            return Err("工作区内程序路径不存在或不是文件".to_string());
        }
        return Ok(resolved.to_string_lossy().into_owned());
    }
    Ok(trimmed.to_string())
}

fn plan_digest(plan: &ExecutionPlan) -> Result<String, String> {
    let mut unsigned = plan.clone();
    unsigned.digest.clear();
    let bytes = serde_json::to_vec(&unsigned).map_err(|e| format!("序列化执行计划失败: {}", e))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn prune_expired_plans(plans: &mut HashMap<String, StoredPlan>) {
    plans.retain(|_, plan| plan.created_at.elapsed() <= PLAN_TTL);
}

#[tauri::command]
pub(crate) fn agent_prepare_execution(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    request: PrepareExecutionRequest,
) -> Result<ExecutionPlan, String> {
    prepare_execution(&grants, request)
}

pub(crate) fn prepare_execution(
    grants: &WorkspaceGrants,
    request: PrepareExecutionRequest,
) -> Result<ExecutionPlan, String> {
    command_available()?;
    validate_env(&request.env)?;
    let root = grants.resolve(&request.workspace_id)?;
    let (cwd, cwd_relative) = resolve_cwd(&root, request.cwd.as_deref())?;
    let timeout_secs = request
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    let id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let intent = request
        .intent
        .unwrap_or_default()
        .trim()
        .chars()
        .take(300)
        .collect();

    let (kind, display_command, program, args, script, shell, mut warnings) =
        match request.kind.as_str() {
            "process" => {
                let requested = request.program.as_deref().unwrap_or_default();
                let executable = resolve_program(&root, requested)?;
                if request.args.iter().any(|arg| arg.contains('\0')) {
                    return Err("程序参数不能包含 NUL".to_string());
                }
                let display = std::iter::once(quote_display_arg(requested))
                    .chain(request.args.iter().map(|arg| quote_display_arg(arg)))
                    .collect::<Vec<_>>()
                    .join(" ");
                (
                    ExecutionKind::Process {
                        executable,
                        args: request.args.clone(),
                    },
                    display,
                    Some(requested.to_string()),
                    request.args,
                    None,
                    None,
                    vec!["程序在工作区模式下运行，仍拥有当前用户权限".to_string()],
                )
            }
            "shell" => {
                let script = request.script.unwrap_or_default();
                if script.trim().is_empty() || script.contains('\0') {
                    return Err("Shell 脚本不能为空且不能包含 NUL".to_string());
                }
                let shell = if cfg!(windows) { "PowerShell" } else { "sh" };
                (
                    ExecutionKind::Shell {
                        script: script.clone(),
                    },
                    script.clone(),
                    None,
                    Vec::new(),
                    Some(script),
                    Some(shell.to_string()),
                    vec![
                        "Shell 可解释管道、重定向和多条命令，风险高于结构化进程".to_string(),
                        "Shell 在工作区模式下运行，仍拥有当前用户权限".to_string(),
                    ],
                )
            }
            _ => return Err("未知执行类型，仅支持 process 或 shell".to_string()),
        };

    if !request.env.is_empty() {
        warnings.push("仅显示环境变量名称；值不会写入确认界面或日志".to_string());
    }
    warnings.push("当前 Runner 尚未提供 OS 级文件或网络隔离".to_string());

    let mut public = ExecutionPlan {
        id: id.clone(),
        digest: String::new(),
        workspace_id: request.workspace_id,
        kind: request.kind,
        display_command,
        program,
        args,
        script,
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
        cwd_relative,
        timeout_secs,
        env_keys: request.env.keys().cloned().collect(),
        intent,
        isolation: "workspace_unconfined".to_string(),
        network: "host_inherited".to_string(),
        warnings,
    };
    public.digest = plan_digest(&public)?;

    let stored = StoredPlan {
        public: public.clone(),
        root,
        cwd,
        kind,
        env: request.env,
        created_at: Instant::now(),
        approval: None,
    };
    let mut plans = PLANS.lock().map_err(|_| "执行计划锁失败".to_string())?;
    prune_expired_plans(&mut plans);
    plans.insert(id, stored);
    Ok(public)
}

#[tauri::command]
pub(crate) fn agent_approve_execution(plan_id: String, digest: String) -> Result<String, String> {
    command_available()?;
    let mut plans = PLANS.lock().map_err(|_| "执行计划锁失败".to_string())?;
    prune_expired_plans(&mut plans);
    let plan = plans
        .get_mut(&plan_id)
        .ok_or_else(|| "执行计划不存在或已过期，请重新确认".to_string())?;
    if plan.public.digest != digest {
        return Err("执行计划摘要不匹配，拒绝批准".to_string());
    }
    let token = format!("approve_{}", uuid::Uuid::new_v4().simple());
    plan.approval = Some(Approval {
        token: token.clone(),
        expires_at: Instant::now() + APPROVAL_TTL,
    });
    Ok(token)
}

fn clean_environment(cmd: &mut StdCommand, requested: &BTreeMap<String, String>) {
    const ALLOWED: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    cmd.env_clear();
    for key in ALLOWED {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd.envs(requested);
    cmd.env("CI", requested.get("CI").map(String::as_str).unwrap_or("1"));
    cmd.env(
        "NO_COLOR",
        requested.get("NO_COLOR").map(String::as_str).unwrap_or("1"),
    );
}

#[cfg(windows)]
fn configure_process_group(cmd: &mut StdCommand) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(unix)]
fn configure_process_group(cmd: &mut StdCommand) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn configure_process_group(_cmd: &mut StdCommand) {}

#[cfg(windows)]
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    let _ = StdCommand::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_process_tree(child: &mut std::process::Child) {
    let pid = child.id();
    let _ = StdCommand::new("kill")
        .args(["-TERM", &format!("-{}", pid)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    std::thread::sleep(Duration::from_millis(150));
    let _ = StdCommand::new("kill")
        .args(["-KILL", &format!("-{}", pid)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

type OutputEmitter = Arc<dyn Fn(ExecutionOutputEvent) + Send + Sync>;

fn drain_pipe(
    mut pipe: impl Read,
    emit: OutputEmitter,
    job_id: String,
    stream: &'static str,
    seq: Arc<AtomicU64>,
) -> (Vec<u8>, bool) {
    let mut saved = Vec::new();
    let mut chunk = [0u8; READ_CHUNK_SIZE];
    let mut truncated = false;
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let event = ExecutionOutputEvent {
                    job_id: job_id.clone(),
                    seq: seq.fetch_add(1, Ordering::Relaxed),
                    stream: stream.to_string(),
                    chunk: String::from_utf8_lossy(&chunk[..n]).into_owned(),
                };
                emit(event);
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(saved.len());
                if remaining > 0 {
                    saved.extend_from_slice(&chunk[..n.min(remaining)]);
                }
                if n > remaining {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (saved, truncated)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileStamp {
    len: u64,
    modified_nanos: u128,
}

fn snapshot_workspace(root: &Path) -> (HashMap<String, FileStamp>, bool) {
    let mut result = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if result.len() >= MAX_SNAPSHOT_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel_text = rel.to_string_lossy().replace('\\', "/");
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if matches!(rel_text.as_str(), ".git" | "node_modules" | "target") {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if kind.is_file() {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let modified_nanos = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0);
                result.insert(
                    rel_text,
                    FileStamp {
                        len: meta.len(),
                        modified_nanos,
                    },
                );
            }
        }
        if truncated {
            break;
        }
    }
    (result, truncated)
}

fn changed_files(
    before: &HashMap<String, FileStamp>,
    after: &HashMap<String, FileStamp>,
) -> (Vec<String>, bool) {
    let mut paths = before
        .keys()
        .chain(after.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    let truncated = paths.len() > MAX_CHANGED_FILES;
    paths.truncate(MAX_CHANGED_FILES);
    (paths, truncated)
}

fn output_tail(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(OUTPUT_TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn prune_output_dir(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            path.is_file().then_some((modified, path))
        })
        .collect::<Vec<_>>();
    if files.len() <= MAX_EXECUTION_LOGS {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    let excess = files.len() - MAX_EXECUTION_LOGS;
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

#[tauri::command]
pub(crate) fn agent_cancel_execution(job_id: String) -> Result<(), String> {
    CANCELLED_JOBS
        .lock()
        .map_err(|_| "取消任务锁失败".to_string())?
        .insert(job_id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn agent_execute_plan(
    app: tauri::AppHandle,
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    plan_id: String,
    approval_token: String,
) -> Result<ExecutionResult, String> {
    let emit: OutputEmitter = Arc::new(move |event| {
        let _ = app.emit("kisaki-execution-output", event);
    });
    let grants = Arc::clone(grants.inner());
    tauri::async_runtime::spawn_blocking(move || {
        execute_plan_blocking(&grants, emit, plan_id, approval_token)
    })
    .await
    .map_err(|e| format!("任务执行线程失败: {}", e))?
}

fn execute_plan_blocking(
    grants: &WorkspaceGrants,
    emit: OutputEmitter,
    plan_id: String,
    approval_token: String,
) -> Result<ExecutionResult, String> {
    command_available()?;
    let plan = {
        let mut plans = PLANS.lock().map_err(|_| "执行计划锁失败".to_string())?;
        prune_expired_plans(&mut plans);
        let stored = plans
            .get(&plan_id)
            .ok_or_else(|| "执行计划不存在或已过期，请重新确认".to_string())?;
        let approval = stored
            .approval
            .as_ref()
            .ok_or_else(|| "执行计划尚未获得批准".to_string())?;
        if approval.token != approval_token || Instant::now() > approval.expires_at {
            return Err("批准令牌无效或已过期".to_string());
        }
        plans.remove(&plan_id).expect("已校验的计划必须存在")
    };

    let current_root = grants.resolve(&plan.public.workspace_id)?;
    if current_root != plan.root {
        return Err("工作目录能力在确认后发生变化".to_string());
    }
    let (before, before_truncated) = snapshot_workspace(&current_root);

    let mut cmd = match &plan.kind {
        ExecutionKind::Process { executable, args } => {
            let mut command = StdCommand::new(executable);
            command.args(args);
            command
        }
        ExecutionKind::Shell { script } => {
            if cfg!(windows) {
                let mut command = StdCommand::new("powershell.exe");
                let utf8_script = format!(
                    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; {}",
                    script
                );
                command.args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &utf8_script,
                ]);
                command
            } else {
                let mut command = StdCommand::new("sh");
                command.args(["-c", script]);
                command
            }
        }
    };
    cmd.current_dir(&plan.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clean_environment(&mut cmd, &plan.env);
    configure_process_group(&mut cmd);

    let start = Instant::now();
    ACTIVE_JOBS
        .lock()
        .map_err(|_| "活动任务锁失败".to_string())?
        .insert(plan_id.clone(), plan.public.workspace_id.clone());
    let _active_guard = ActiveJobGuard(plan_id.clone());
    let mut child = cmd.spawn().map_err(|e| format!("启动任务失败: {}", e))?;
    let seq = Arc::new(AtomicU64::new(1));
    let (tx, rx) = mpsc::channel::<(&'static str, Vec<u8>, bool)>();
    if let Some(stdout) = child.stdout.take() {
        let (tx, emit, job, seq) = (tx.clone(), emit.clone(), plan_id.clone(), seq.clone());
        std::thread::spawn(move || {
            let (bytes, truncated) = drain_pipe(stdout, emit, job, "stdout", seq);
            let _ = tx.send(("stdout", bytes, truncated));
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let (tx, emit, job, seq) = (tx.clone(), emit.clone(), plan_id.clone(), seq.clone());
        std::thread::spawn(move || {
            let (bytes, truncated) = drain_pipe(stderr, emit, job, "stderr", seq);
            let _ = tx.send(("stderr", bytes, truncated));
        });
    }
    drop(tx);

    let mut timed_out = false;
    let mut cancelled = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                cancelled = CANCELLED_JOBS
                    .lock()
                    .map(|jobs| jobs.contains(&plan_id))
                    .unwrap_or(false);
                timed_out = start.elapsed() >= Duration::from_secs(plan.public.timeout_secs);
                if cancelled || timed_out {
                    kill_process_tree(&mut child);
                    break None;
                }
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
            Err(e) => return Err(format!("等待任务完成失败: {}", e)),
        }
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let deadline = Instant::now() + PIPE_DRAIN_TIMEOUT;
    let mut pending = 2;
    while pending > 0 && Instant::now() < deadline {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(("stdout", bytes, was_truncated)) => {
                stdout = bytes;
                truncated |= was_truncated;
                pending -= 1;
            }
            Ok(("stderr", bytes, was_truncated)) => {
                stderr = bytes;
                truncated |= was_truncated;
                pending -= 1;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let (after, after_truncated) = snapshot_workspace(&current_root);
    let (changed_files, mut changes_truncated) = changed_files(&before, &after);
    changes_truncated |= before_truncated || after_truncated;

    let logs = output_dir();
    fs::create_dir_all(&logs).map_err(|e| format!("创建任务日志目录失败: {}", e))?;
    let output_ref = format!("{}.log", plan_id);
    let output_path = logs.join(&output_ref);
    let mut log = Vec::new();
    log.extend_from_slice(
        format!(
            "plan: {}\ndigest: {}\ncommand: {}\n\n",
            plan_id, plan.public.digest, plan.public.display_command
        )
        .as_bytes(),
    );
    log.extend_from_slice(b"--- stdout ---\n");
    log.extend_from_slice(&stdout);
    log.extend_from_slice(b"\n--- stderr ---\n");
    log.extend_from_slice(&stderr);
    log.extend_from_slice(format!("\n--- exit code: {:?} ---\n", exit_code).as_bytes());
    fs::write(&output_path, log).map_err(|e| format!("写入任务日志失败: {}", e))?;
    prune_output_dir(&logs);

    let status = if cancelled {
        "cancelled"
    } else if timed_out {
        "timed_out"
    } else if exit_code == Some(0) {
        "completed"
    } else {
        "failed"
    };
    Ok(ExecutionResult {
        job_id: plan_id,
        status: status.to_string(),
        exit_code,
        stdout_tail: output_tail(&stdout),
        stderr_tail: output_tail(&stderr),
        output_ref,
        duration_ms: start.elapsed().as_millis(),
        timed_out,
        cancelled,
        truncated,
        changed_files,
        changes_truncated,
        isolation: plan.public.isolation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fileio;
    use crate::test_support::{TempAppPaths, TempDir};

    fn temp_workspace() -> (TempAppPaths, TempDir, WorkspaceGrants, String) {
        let fixture = TempAppPaths::new();
        let root = TempDir::new();
        let grants = WorkspaceGrants::new(fixture.shared_paths());
        let grant = grants.grant_from_selection(root.path()).unwrap();
        (fixture, root, grants, grant.id)
    }

    fn process_request(workspace_id: &str) -> PrepareExecutionRequest {
        PrepareExecutionRequest {
            workspace_id: workspace_id.to_string(),
            kind: "process".to_string(),
            program: Some(if cfg!(windows) { "where" } else { "printf" }.to_string()),
            args: if cfg!(windows) {
                vec!["cmd".into()]
            } else {
                vec!["kisaki-ok".into()]
            },
            script: None,
            cwd: None,
            timeout_secs: Some(5),
            env: BTreeMap::new(),
            intent: Some("执行行为测试".to_string()),
        }
    }

    #[test]
    fn prepare_rejects_absolute_program() {
        let (_fixture, root, grants, workspace_id) = temp_workspace();
        let mut request = process_request(&workspace_id);
        request.program = Some(root.path().join("tool.exe").to_string_lossy().into_owned());
        assert!(prepare_execution(&grants, request)
            .unwrap_err()
            .contains("绝对"));
    }

    #[test]
    fn approval_is_bound_to_digest() {
        let (_fixture, _root, grants, workspace_id) = temp_workspace();
        let plan = prepare_execution(&grants, process_request(&workspace_id)).unwrap();
        assert!(agent_approve_execution(plan.id.clone(), "bad".into()).is_err());
        let token = agent_approve_execution(plan.id.clone(), plan.digest.clone()).unwrap();
        assert!(token.starts_with("approve_"));
        fileio::revoke_workspace(&grants, &workspace_id).unwrap();
    }

    #[test]
    fn sensitive_environment_is_rejected() {
        let mut env = BTreeMap::new();
        env.insert("API_TOKEN".to_string(), "secret".to_string());
        assert!(validate_env(&env).unwrap_err().contains("敏感"));
    }

    #[test]
    fn structured_process_cannot_disguise_shell() {
        let root = TempDir::new();
        assert!(resolve_program(root.path(), "powershell.exe")
            .unwrap_err()
            .contains("run_shell"));
        assert!(resolve_program(root.path(), "sh")
            .unwrap_err()
            .contains("run_shell"));
    }

    #[test]
    fn prepare_and_execute_resolve_only_the_injected_authorization_state() {
        let (_fixture, _root, grants, workspace_id) = temp_workspace();
        let other_fixture = TempAppPaths::new();
        let other_grants = WorkspaceGrants::new(other_fixture.shared_paths());
        assert!(
            prepare_execution(&other_grants, process_request(&workspace_id))
                .unwrap_err()
                .contains("授权不存在")
        );
        let plan = prepare_execution(&grants, process_request(&workspace_id)).unwrap();
        let token = agent_approve_execution(plan.id.clone(), plan.digest).unwrap();
        let emit: OutputEmitter = Arc::new(|_| {});
        assert!(execute_plan_blocking(&other_grants, emit, plan.id, token)
            .unwrap_err()
            .contains("授权不存在"));
        fileio::revoke_workspace(&grants, &workspace_id).unwrap();
        assert!(prepare_execution(&grants, process_request(&workspace_id)).is_err());
    }

    #[test]
    fn revocation_discards_only_plans_for_the_requested_capability() {
        let (_fixture, root, grants, workspace_id) = temp_workspace();
        let other_id = grants.grant_from_selection(root.path()).unwrap().id;
        let first = prepare_execution(&grants, process_request(&workspace_id)).unwrap();
        let second = prepare_execution(&grants, process_request(&other_id)).unwrap();
        fileio::revoke_workspace(&grants, &workspace_id).unwrap();
        assert!(agent_approve_execution(first.id, first.digest)
            .unwrap_err()
            .contains("不存在"));
        assert!(agent_approve_execution(second.id, second.digest).is_ok());
        assert_eq!(grants.resolve(&other_id).unwrap(), root.path());
        fileio::revoke_workspace(&grants, &other_id).unwrap();
    }

    #[test]
    fn approved_process_executes_and_revocation_cancels_only_its_own_active_job() {
        // 执行输出仍使用本票不迁移的兼容入口；所有真实执行共用本测试的独立 fixture。
        let (fixture, root, grants, workspace_id) = temp_workspace();
        init_output_dir(fixture.shared_paths()).unwrap();
        let plan = prepare_execution(&grants, process_request(&workspace_id)).unwrap();
        let token = agent_approve_execution(plan.id.clone(), plan.digest.clone()).unwrap();
        let emit: OutputEmitter = Arc::new(|_| {});
        let result = execute_plan_blocking(&grants, emit, plan.id, token).unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.stdout_tail.trim().is_empty());
        assert!(fixture
            .paths()
            .execution_output_dir()
            .join(&result.output_ref)
            .is_file());

        let other_id = grants.grant_from_selection(root.path()).unwrap().id;
        let mut slow_request = process_request(&workspace_id);
        slow_request.kind = "shell".to_string();
        slow_request.program = None;
        slow_request.args.clear();
        slow_request.timeout_secs = Some(30);
        slow_request.script = Some(
            if cfg!(windows) {
                "Write-Output 'kisaki-ready'; Start-Sleep -Seconds 30"
            } else {
                "printf 'kisaki-ready\n'; sleep 30"
            }
            .to_string(),
        );
        let first = prepare_execution(&grants, slow_request.clone()).unwrap();
        slow_request.workspace_id = other_id.clone();
        let second = prepare_execution(&grants, slow_request).unwrap();
        let first_job = first.id.clone();
        let second_job = second.id.clone();
        std::thread::scope(|scope| {
            let (ready_tx, ready_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let emit: OutputEmitter = Arc::new(move |event| {
                if event.stream == "stdout" && !event.chunk.trim().is_empty() {
                    let _ = ready_tx.send(event.job_id);
                }
            });
            for plan in [first, second] {
                let token = agent_approve_execution(plan.id.clone(), plan.digest).unwrap();
                let emit = Arc::clone(&emit);
                let done_tx = done_tx.clone();
                let grants = &grants;
                scope.spawn(move || {
                    let result = execute_plan_blocking(grants, emit, plan.id.clone(), token);
                    done_tx.send((plan.id, result)).unwrap();
                });
            }
            drop(done_tx);
            let mut ready = HashSet::new();
            while ready.len() < 2 {
                ready.insert(ready_rx.recv_timeout(Duration::from_secs(15)).unwrap());
            }
            assert!(ready.contains(&first_job) && ready.contains(&second_job));
            fileio::revoke_workspace(&grants, &workspace_id).unwrap();
            let (job_id, result) = done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(job_id, first_job);
            let result = result.unwrap();
            assert_eq!(result.status, "cancelled");
            assert!(result.cancelled);
            assert!(matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
            assert_eq!(grants.resolve(&other_id).unwrap(), root.path());
            agent_cancel_execution(second_job.clone()).unwrap();
            let (job_id, result) = done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(job_id, second_job);
            assert_eq!(result.unwrap().status, "cancelled");
        });
        fileio::revoke_workspace(&grants, &other_id).unwrap();
    }
}
