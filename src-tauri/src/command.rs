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
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
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

/// 一次应用运行的执行状态；目录与单调时钟必须在装配时显式提供。
pub(crate) struct ExecutionRegistry {
    paths: Arc<AppPaths>,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
    state: Mutex<ExecutionState>,
}

#[derive(Default)]
struct ExecutionState {
    plans: HashMap<String, StoredPlan>,
    active_jobs: HashMap<String, ActiveJob>,
}

struct ActiveJob {
    workspace_id: String,
    // 取消标记跟随任务存活，不能在任务结束后成为游离的 id。
    cancelled: bool,
}

struct ActiveJobGuard {
    registry: Arc<ExecutionRegistry>,
    job_id: String,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        let mut state = self
            .registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active_jobs.remove(&self.job_id);
    }
}

impl ExecutionRegistry {
    pub(crate) fn new(
        paths: Arc<AppPaths>,
        clock: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> Self {
        Self {
            paths,
            clock: Box::new(clock),
            state: Mutex::new(ExecutionState::default()),
        }
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, ExecutionState>, String> {
        self.state
            .lock()
            .map_err(|_| "执行注册表锁失败".to_string())
    }

    /// 返回任务是否仍可取消；未知或已结束的 id 不留下取消标记。
    /// 待执行计划上的取消会随一次性消费转交给运行中任务。
    pub(crate) fn cancel_execution(&self, job_id: &str) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        prune_expired_plans(&mut state.plans, (self.clock)());
        if let Some(plan) = state.plans.get_mut(job_id) {
            plan.cancelled = true;
            return Ok(true);
        }
        if let Some(job) = state.active_jobs.get_mut(job_id) {
            job.cancelled = true;
            return Ok(true);
        }
        Ok(false)
    }

    /// 与准备、消费和运行登记共用同一把锁，撤销不能漏掉阶段转换中的任务。
    pub(crate) fn revoke_workspace(
        &self,
        grants: &WorkspaceGrants,
        workspace_id: &str,
    ) -> Result<(), String> {
        let mut state = self.lock_state()?;
        state
            .plans
            .retain(|_, plan| plan.public.workspace_id != workspace_id);
        for job in state.active_jobs.values_mut() {
            if job.workspace_id == workspace_id {
                job.cancelled = true;
            }
        }
        // 沿用既有顺序：先撤销执行权限，再提交授权表；写盘失败也不恢复旧计划。
        grants.revoke(workspace_id)
    }
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
    cancelled: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ExecutionOutputEvent {
    pub job_id: String,
    pub seq: u64,
    pub stream: String,
    pub chunk: String,
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

fn prune_expired_plans(plans: &mut HashMap<String, StoredPlan>, now: Instant) {
    plans.retain(|_, plan| now.saturating_duration_since(plan.created_at) <= PLAN_TTL);
}

#[tauri::command]
pub(crate) fn agent_prepare_execution(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    registry: tauri::State<'_, Arc<ExecutionRegistry>>,
    request: PrepareExecutionRequest,
) -> Result<ExecutionPlan, String> {
    registry.prepare_execution(&grants, request)
}

#[tauri::command]
pub(crate) fn agent_approve_execution(
    registry: tauri::State<'_, Arc<ExecutionRegistry>>,
    plan_id: String,
    digest: String,
) -> Result<String, String> {
    registry.approve_execution(&plan_id, &digest)
}

impl ExecutionRegistry {
    pub(crate) fn prepare_execution(
        &self,
        grants: &WorkspaceGrants,
        request: PrepareExecutionRequest,
    ) -> Result<ExecutionPlan, String> {
        command_available()?;
        validate_env(&request.env)?;
        let mut state = self.lock_state()?;
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

        let now = (self.clock)();
        let stored = StoredPlan {
            public: public.clone(),
            root,
            cwd,
            kind,
            env: request.env,
            created_at: now,
            approval: None,
            cancelled: false,
        };
        prune_expired_plans(&mut state.plans, now);
        state.plans.insert(id, stored);
        Ok(public)
    }

    pub(crate) fn approve_execution(&self, plan_id: &str, digest: &str) -> Result<String, String> {
        command_available()?;
        let mut state = self.lock_state()?;
        let now = (self.clock)();
        prune_expired_plans(&mut state.plans, now);
        let plan = state
            .plans
            .get_mut(plan_id)
            .ok_or_else(|| "执行计划不存在或已过期，请重新确认".to_string())?;
        if plan.public.digest != digest {
            return Err("执行计划摘要不匹配，拒绝批准".to_string());
        }
        let token = format!("approve_{}", uuid::Uuid::new_v4().simple());
        plan.approval = Some(Approval {
            token: token.clone(),
            expires_at: now + APPROVAL_TTL,
        });
        Ok(token)
    }
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

pub(crate) type OutputEmitter = Arc<dyn Fn(ExecutionOutputEvent) + Send + Sync>;

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
pub(crate) fn agent_cancel_execution(
    registry: tauri::State<'_, Arc<ExecutionRegistry>>,
    job_id: String,
) -> Result<(), String> {
    registry.cancel_execution(&job_id).map(|_| ())
}

#[tauri::command]
pub(crate) async fn agent_execute_plan(
    app: tauri::AppHandle,
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    registry: tauri::State<'_, Arc<ExecutionRegistry>>,
    plan_id: String,
    approval_token: String,
) -> Result<ExecutionResult, String> {
    let emit: OutputEmitter = Arc::new(move |event| {
        let _ = app.emit("kisaki-execution-output", event);
    });
    let grants = Arc::clone(grants.inner());
    let registry = Arc::clone(registry.inner());
    tauri::async_runtime::spawn_blocking(move || {
        registry.execute_plan(&grants, emit, &plan_id, &approval_token)
    })
    .await
    .map_err(|e| format!("任务执行线程失败: {}", e))?
}

impl ExecutionRegistry {
    pub(crate) fn execute_plan(
        self: &Arc<Self>,
        grants: &WorkspaceGrants,
        emit: OutputEmitter,
        plan_id: &str,
        approval_token: &str,
    ) -> Result<ExecutionResult, String> {
        command_available()?;
        let (plan, current_root, _active_guard) = {
            let mut state = self.lock_state()?;
            let now = (self.clock)();
            prune_expired_plans(&mut state.plans, now);
            let stored = state
                .plans
                .get(plan_id)
                .ok_or_else(|| "执行计划不存在或已过期，请重新确认".to_string())?;
            let approval = stored
                .approval
                .as_ref()
                .ok_or_else(|| "执行计划尚未获得批准".to_string())?;
            if approval.token != approval_token || now > approval.expires_at {
                return Err("批准令牌无效或已过期".to_string());
            }
            let plan = state.plans.remove(plan_id).expect("已校验的计划必须存在");
            let current_root = grants.resolve(&plan.public.workspace_id)?;
            if current_root != plan.root {
                return Err("工作目录能力在确认后发生变化".to_string());
            }
            let (current_cwd, _) = resolve_cwd(&current_root, Some(&plan.public.cwd_relative))?;
            if current_cwd != plan.cwd {
                return Err("命令工作目录在确认后发生变化".to_string());
            }
            state.active_jobs.insert(
                plan_id.to_string(),
                ActiveJob {
                    workspace_id: plan.public.workspace_id.clone(),
                    cancelled: plan.cancelled,
                },
            );
            let guard = ActiveJobGuard {
                registry: Arc::clone(self),
                job_id: plan_id.to_string(),
            };
            (plan, current_root, guard)
        };
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
        let mut child = cmd.spawn().map_err(|e| format!("启动任务失败: {}", e))?;
        // 输出线程也持有同一注册表；守卫收尾后不再向已结束任务发送迟到输出。
        // 调用外部回调前释放状态锁，回调可以安全地取消或撤销自己的任务。
        let registry = Arc::clone(self);
        let emit: OutputEmitter = Arc::new(move |event| {
            let active = registry
                .state
                .lock()
                .map(|state| state.active_jobs.contains_key(&event.job_id))
                .unwrap_or(false);
            if active {
                emit(event);
            }
        });
        let seq = Arc::new(AtomicU64::new(1));
        let (tx, rx) = mpsc::channel::<(&'static str, Vec<u8>, bool)>();
        if let Some(stdout) = child.stdout.take() {
            let (tx, emit, job, seq) = (tx.clone(), emit.clone(), plan_id.to_string(), seq.clone());
            std::thread::spawn(move || {
                let (bytes, truncated) = drain_pipe(stdout, emit, job, "stdout", seq);
                let _ = tx.send(("stdout", bytes, truncated));
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let (tx, emit, job, seq) = (tx.clone(), emit.clone(), plan_id.to_string(), seq.clone());
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
                    cancelled = self
                        .state
                        .lock()
                        .map(|state| {
                            state
                                .active_jobs
                                .get(plan_id)
                                .is_some_and(|job| job.cancelled)
                        })
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

        let logs = self.paths.execution_output_dir();
        fs::create_dir_all(logs).map_err(|e| format!("创建任务日志目录失败: {}", e))?;
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
        prune_output_dir(logs);

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
            job_id: plan_id.to_string(),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fileio;
    use crate::test_support::{TempAppPaths, TempDir};

    struct Fixture {
        paths: TempAppPaths,
        root: TempDir,
        grants: Arc<WorkspaceGrants>,
        registry: Arc<ExecutionRegistry>,
        workspace_id: String,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_clock(Instant::now)
        }

        fn with_clock(clock: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
            let paths = TempAppPaths::new();
            let root = TempDir::new();
            let grants = Arc::new(WorkspaceGrants::new(paths.shared_paths()));
            let registry = Arc::new(ExecutionRegistry::new(paths.shared_paths(), clock));
            let workspace_id = grants.grant_from_selection(root.path()).unwrap().id;
            Self {
                paths,
                root,
                grants,
                registry,
                workspace_id,
            }
        }

        fn prepare(&self, request: PrepareExecutionRequest) -> ExecutionPlan {
            self.registry
                .prepare_execution(&self.grants, request)
                .unwrap()
        }

        fn approve(&self, plan: &ExecutionPlan) -> String {
            self.registry
                .approve_execution(&plan.id, &plan.digest)
                .unwrap()
        }

        fn execute(&self, plan: &ExecutionPlan, token: &str) -> Result<ExecutionResult, String> {
            self.registry
                .execute_plan(&self.grants, Arc::new(|_| {}), &plan.id, token)
        }

        fn assert_finished(&self, plan: &ExecutionPlan, token: &str) {
            assert!(
                !self.registry.cancel_execution(&plan.id).unwrap(),
                "终态不能残留任务或取消标记"
            );
            assert!(self
                .registry
                .approve_execution(&plan.id, &plan.digest)
                .unwrap_err()
                .contains("不存在"));
            assert!(self.execute(plan, token).unwrap_err().contains("不存在"));
        }
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

    fn controlled_fixture() -> (Fixture, Arc<AtomicU64>) {
        let seconds = Arc::new(AtomicU64::new(0));
        let clock_seconds = Arc::clone(&seconds);
        let origin = Instant::now();
        let fixture = Fixture::with_clock(move || {
            origin + Duration::from_secs(clock_seconds.load(Ordering::Relaxed))
        });
        (fixture, seconds)
    }

    fn shell_request(workspace_id: &str, script: String) -> PrepareExecutionRequest {
        let mut request = process_request(workspace_id);
        request.kind = "shell".to_string();
        request.program = None;
        request.args.clear();
        request.script = Some(script);
        request.timeout_secs = Some(30);
        request
    }

    fn waiting_request(workspace_id: &str, release_file: &str) -> PrepareExecutionRequest {
        // 显式刷新控制台，不能依赖 PowerShell 格式化管道何时刷新重定向输出。
        let script = if cfg!(windows) {
            format!("[Console]::Out.WriteLine('kisaki-ready'); [Console]::Out.Flush(); while (-not (Test-Path -LiteralPath '{release_file}')) {{ Start-Sleep -Milliseconds 20 }}")
        } else {
            format!(
                "printf 'kisaki-ready\\n'; while [ ! -f '{release_file}' ]; do sleep 0.02; done"
            )
        };
        shell_request(workspace_id, script)
    }

    struct RunningJob {
        registry: Arc<ExecutionRegistry>,
        plan: ExecutionPlan,
        token: String,
        output: mpsc::Receiver<ExecutionOutputEvent>,
        done: mpsc::Receiver<Result<ExecutionResult, String>>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl RunningJob {
        fn spawn(fixture: &Fixture, plan: ExecutionPlan) -> Self {
            let token = fixture.approve(&plan);
            let (output_tx, output) = mpsc::channel();
            let (done_tx, done) = mpsc::channel();
            let emit: OutputEmitter = Arc::new(move |event| {
                let _ = output_tx.send(event);
            });
            let registry = Arc::clone(&fixture.registry);
            let grants = Arc::clone(&fixture.grants);
            let id = plan.id.clone();
            let approval = token.clone();
            let worker = std::thread::spawn(move || {
                let result = registry.execute_plan(&grants, emit, &id, &approval);
                // 主断言失败后，通道关闭不应产生掩盖原始失败的第二次 panic。
                let _ = done_tx.send(result);
            });
            Self {
                registry: Arc::clone(&fixture.registry),
                plan,
                token,
                output,
                done,
                worker: Some(worker),
            }
        }

        fn wait_ready(&self) {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stdout = String::new();
            let mut stderr = String::new();
            loop {
                if let Ok(event) = self.output.recv_timeout(Duration::from_millis(50)) {
                    assert_eq!(event.job_id, self.plan.id);
                    assert!(event.seq > 0);
                    match event.stream.as_str() {
                        "stdout" => stdout.push_str(&event.chunk),
                        "stderr" => stderr.push_str(&event.chunk),
                        stream => panic!("未知输出流: {stream}"),
                    }
                    // 就绪文本可以跨多个真实管道块，不把块边界当作消息边界。
                    if stdout.contains("kisaki-ready") {
                        return;
                    }
                }
                if let Ok(result) = self.done.try_recv() {
                    panic!("任务在就绪前终止: {result:?}; stdout={stdout:?}; stderr={stderr:?}");
                }
                assert!(
                    Instant::now() < deadline,
                    "等待就绪超时; stdout={stdout:?}; stderr={stderr:?}"
                );
            }
        }

        fn finish(&mut self) -> Result<ExecutionResult, String> {
            let result = self
                .done
                .recv_timeout(Duration::from_secs(10))
                .expect("任务未按预期结束");
            self.worker
                .take()
                .unwrap()
                .join()
                .expect("执行线程意外 panic");
            result
        }
    }

    impl Drop for RunningJob {
        fn drop(&mut self) {
            // 即使断言失败也终止本测试启动的任务，再释放它引用的真实目录。
            let _ = self.registry.cancel_execution(&self.plan.id);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[test]
    fn independent_execution_registries_keep_plans_and_output_separate() {
        let first = Fixture::new();
        let second = Fixture::new();
        let first_plan = first.prepare(process_request(&first.workspace_id));
        let second_plan = second.prepare(process_request(&second.workspace_id));
        assert!(second
            .registry
            .approve_execution(&first_plan.id, &first_plan.digest)
            .unwrap_err()
            .contains("不存在"));
        assert!(!second.registry.cancel_execution(&first_plan.id).unwrap());
        for (own, other, plan) in [
            (&first, &second, first_plan),
            (&second, &first, second_plan),
        ] {
            assert_eq!(
                own.grants.resolve(&own.workspace_id).unwrap(),
                own.root.path()
            );
            let token = own.approve(&plan);
            assert!(other
                .registry
                .execute_plan(&own.grants, Arc::new(|_| {}), &plan.id, &token)
                .unwrap_err()
                .contains("不存在"));
            let result = own.execute(&plan, &token).unwrap();
            assert_eq!(result.status, "completed");
            assert!(!result.stdout_tail.trim().is_empty());
            assert!(own
                .paths
                .paths()
                .execution_output_dir()
                .join(&result.output_ref)
                .is_file());
            assert!(!other
                .paths
                .paths()
                .execution_output_dir()
                .join(&result.output_ref)
                .exists());
            own.assert_finished(&plan, &token);
        }
    }

    #[test]
    fn prepare_rejects_absolute_program() {
        let fixture = Fixture::new();
        let mut request = process_request(&fixture.workspace_id);
        request.program = Some(
            fixture
                .root
                .path()
                .join("tool.exe")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(fixture
            .registry
            .prepare_execution(&fixture.grants, request)
            .unwrap_err()
            .contains("绝对"));
    }

    #[test]
    fn approval_is_bound_to_digest() {
        let fixture = Fixture::new();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        assert!(fixture
            .registry
            .approve_execution(&plan.id, "bad")
            .unwrap_err()
            .contains("摘要不匹配"));
        assert!(fixture.approve(&plan).starts_with("approve_"));
        fileio::revoke_workspace(&fixture.grants, &fixture.registry, &fixture.workspace_id)
            .unwrap();
    }

    #[test]
    fn sensitive_environment_is_rejected() {
        let fixture = Fixture::new();
        let mut request = process_request(&fixture.workspace_id);
        request
            .env
            .insert("API_TOKEN".to_string(), "secret".to_string());
        assert!(fixture
            .registry
            .prepare_execution(&fixture.grants, request)
            .unwrap_err()
            .contains("敏感"));
    }

    #[test]
    fn structured_process_cannot_disguise_shell() {
        let fixture = Fixture::new();
        for program in [
            "powershell.exe",
            "sh",
            "CMD.exe",
            "pwsh",
            "bash",
            "zsh",
            "fish",
        ] {
            let mut request = process_request(&fixture.workspace_id);
            request.program = Some(program.to_string());
            assert!(fixture
                .registry
                .prepare_execution(&fixture.grants, request)
                .unwrap_err()
                .contains("run_shell"));
        }
    }

    #[test]
    fn prepare_and_execute_resolve_only_the_injected_authorization_state() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        assert!(fixture
            .registry
            .prepare_execution(&other.grants, process_request(&fixture.workspace_id))
            .unwrap_err()
            .contains("授权不存在"));
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        let token = fixture.approve(&plan);
        assert!(fixture
            .registry
            .execute_plan(&other.grants, Arc::new(|_| {}), &plan.id, &token)
            .unwrap_err()
            .contains("授权不存在"));
        fixture.assert_finished(&plan, &token);
        fileio::revoke_workspace(&fixture.grants, &fixture.registry, &fixture.workspace_id)
            .unwrap();
        assert!(fixture
            .registry
            .prepare_execution(&fixture.grants, process_request(&fixture.workspace_id))
            .is_err());
    }

    #[test]
    fn revocation_discards_only_plans_for_the_requested_capability() {
        let fixture = Fixture::new();
        let other_id = fixture
            .grants
            .grant_from_selection(fixture.root.path())
            .unwrap()
            .id;
        let first = fixture.prepare(process_request(&fixture.workspace_id));
        let second = fixture.prepare(process_request(&other_id));
        assert!(fixture.registry.cancel_execution(&first.id).unwrap());
        fileio::revoke_workspace(&fixture.grants, &fixture.registry, &fixture.workspace_id)
            .unwrap();
        assert!(fixture
            .registry
            .approve_execution(&first.id, &first.digest)
            .unwrap_err()
            .contains("不存在"));
        assert!(!fixture.registry.cancel_execution(&first.id).unwrap());
        assert!(fixture
            .registry
            .approve_execution(&second.id, &second.digest)
            .is_ok());
        assert_eq!(
            fixture.grants.resolve(&other_id).unwrap(),
            fixture.root.path()
        );
    }

    #[test]
    fn approval_rejects_missing_wrong_and_consumed_tokens_without_losing_a_valid_plan() {
        let fixture = Fixture::new();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        assert!(fixture
            .execute(&plan, "")
            .unwrap_err()
            .contains("尚未获得批准"));
        let old_token = fixture.approve(&plan);
        let token = fixture.approve(&plan);
        assert_ne!(old_token, token);
        for invalid in ["not-an-approval", old_token.as_str()] {
            assert!(fixture
                .execute(&plan, invalid)
                .unwrap_err()
                .contains("令牌无效"));
        }
        assert_eq!(fixture.execute(&plan, &token).unwrap().status, "completed");
        fixture.assert_finished(&plan, &token);
    }

    #[test]
    fn approval_expires_after_sixty_seconds_and_can_be_renewed() {
        let (fixture, seconds) = controlled_fixture();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        let expired = fixture.approve(&plan);
        seconds.store(61, Ordering::Relaxed);
        assert!(fixture
            .execute(&plan, &expired)
            .unwrap_err()
            .contains("令牌无效或已过期"));
        let renewed = fixture.approve(&plan);
        assert_ne!(expired, renewed);
        seconds.store(120, Ordering::Relaxed);
        assert_eq!(
            fixture.execute(&plan, &renewed).unwrap().status,
            "completed"
        );
        fixture.assert_finished(&plan, &renewed);
    }

    #[test]
    fn approval_and_plan_keep_the_existing_inclusive_ttl_boundaries() {
        for seconds_at_execution in [60, 300] {
            let (fixture, seconds) = controlled_fixture();
            let plan = fixture.prepare(process_request(&fixture.workspace_id));
            let token = if seconds_at_execution == 60 {
                let token = fixture.approve(&plan);
                seconds.store(60, Ordering::Relaxed);
                token
            } else {
                seconds.store(300, Ordering::Relaxed);
                fixture.approve(&plan)
            };
            assert_eq!(fixture.execute(&plan, &token).unwrap().status, "completed");
            fixture.assert_finished(&plan, &token);
        }
    }

    #[test]
    fn expired_plans_are_rejected_and_do_not_leave_cancellation_state() {
        let (fixture, seconds) = controlled_fixture();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        let token = fixture.approve(&plan);
        seconds.store(301, Ordering::Relaxed);
        assert!(fixture
            .execute(&plan, &token)
            .unwrap_err()
            .contains("计划不存在或已过期"));
        fixture.assert_finished(&plan, &token);
        assert!(!fixture.registry.cancel_execution("never-issued").unwrap());
    }

    #[test]
    fn cancellation_before_execution_is_consumed_with_the_plan() {
        let fixture = Fixture::new();
        let plan = fixture.prepare(waiting_request(&fixture.workspace_id, "never-release"));
        assert!(fixture.registry.cancel_execution(&plan.id).unwrap());
        let token = fixture.approve(&plan);
        let result = fixture.execute(&plan, &token).unwrap();
        assert_eq!(result.status, "cancelled");
        assert!(result.cancelled);
        fixture.assert_finished(&plan, &token);
        assert!(fixture.grants.resolve(&fixture.workspace_id).is_ok());
    }

    #[test]
    fn active_cancellation_keeps_authorization_and_cleans_the_finished_job() {
        let fixture = Fixture::new();
        let plan = fixture.prepare(waiting_request(&fixture.workspace_id, "never-release"));
        let mut job = RunningJob::spawn(&fixture, plan);
        job.wait_ready();
        assert!(fixture.registry.cancel_execution(&job.plan.id).unwrap());
        let result = job.finish().unwrap();
        assert_eq!(result.status, "cancelled");
        assert!(result.cancelled);
        assert!(fixture.grants.resolve(&fixture.workspace_id).is_ok());
        fixture.assert_finished(&job.plan, &job.token);
    }

    #[test]
    fn revocation_cancels_only_its_own_running_capability_even_for_the_same_directory() {
        for same_directory in [true, false] {
            let fixture = Fixture::new();
            let other_root = TempDir::new();
            let root = if same_directory {
                fixture.root.path()
            } else {
                other_root.path()
            };
            let other_id = fixture.grants.grant_from_selection(root).unwrap().id;
            let first = fixture.prepare(waiting_request(&fixture.workspace_id, "release-first"));
            let second = fixture.prepare(waiting_request(&other_id, "release-second"));
            let mut first_job = RunningJob::spawn(&fixture, first);
            let mut second_job = RunningJob::spawn(&fixture, second);
            first_job.wait_ready();
            second_job.wait_ready();

            fileio::revoke_workspace(&fixture.grants, &fixture.registry, &fixture.workspace_id)
                .unwrap();

            let result = first_job.finish().unwrap();
            assert_eq!(result.status, "cancelled");
            assert!(result.cancelled);
            assert!(fixture.grants.resolve(&fixture.workspace_id).is_err());
            assert_eq!(fixture.grants.resolve(&other_id).unwrap(), root);
            assert!(matches!(
                second_job.done.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            fs::write(root.join("release-second"), "允许另一能力正常完成").unwrap();
            assert_eq!(second_job.finish().unwrap().status, "completed");
            fixture.assert_finished(&first_job.plan, &first_job.token);
            fixture.assert_finished(&second_job.plan, &second_job.token);
        }
    }

    #[test]
    fn output_callback_can_cancel_without_holding_the_registry_lock() {
        let fixture = Fixture::new();
        let plan = fixture.prepare(waiting_request(&fixture.workspace_id, "never-release"));
        let token = fixture.approve(&plan);
        let registry = Arc::clone(&fixture.registry);
        let emit: OutputEmitter = Arc::new(move |event| {
            if event.stream == "stdout" && !event.chunk.is_empty() {
                registry.cancel_execution(&event.job_id).unwrap();
            }
        });
        let result = fixture
            .registry
            .execute_plan(&fixture.grants, emit, &plan.id, &token)
            .unwrap();
        assert_eq!(result.status, "cancelled");
        fixture.assert_finished(&plan, &token);
    }

    #[test]
    fn timeout_and_nonzero_exit_cleanup_have_distinct_terminal_results() {
        let fixture = Fixture::new();
        let failed = fixture.prepare(shell_request(&fixture.workspace_id, "exit 7".to_string()));
        let token = fixture.approve(&failed);
        let result = fixture.execute(&failed, &token).unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.exit_code, Some(7));
        assert!(!result.cancelled && !result.timed_out);
        fixture.assert_finished(&failed, &token);

        let mut request = waiting_request(&fixture.workspace_id, "never-release");
        request.timeout_secs = Some(1);
        let timed_out = fixture.prepare(request);
        let token = fixture.approve(&timed_out);
        let result = fixture.execute(&timed_out, &token).unwrap();
        assert_eq!(result.status, "timed_out");
        assert!(result.timed_out);
        assert!(!result.cancelled);
        fixture.assert_finished(&timed_out, &token);
    }

    #[test]
    fn spawn_and_output_storage_failures_cleanup_consumed_jobs() {
        let fixture = Fixture::new();
        let mut request = process_request(&fixture.workspace_id);
        request.program = Some(format!("kisaki-missing-{}", uuid::Uuid::new_v4().simple()));
        let missing = fixture.prepare(request);
        let token = fixture.approve(&missing);
        assert!(fixture
            .execute(&missing, &token)
            .unwrap_err()
            .contains("启动任务失败"));
        fixture.assert_finished(&missing, &token);

        fs::remove_dir(fixture.paths.paths().execution_output_dir()).unwrap();
        fs::write(fixture.paths.paths().execution_output_dir(), "阻断输出目录").unwrap();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        let token = fixture.approve(&plan);
        assert!(fixture
            .execute(&plan, &token)
            .unwrap_err()
            .contains("创建任务日志目录失败"));
        fixture.assert_finished(&plan, &token);
    }

    #[test]
    fn execution_revalidates_the_confirmed_working_directory() {
        let fixture = Fixture::new();
        let cwd = fixture.root.path().join("nested");
        fs::create_dir(&cwd).unwrap();
        let mut request = process_request(&fixture.workspace_id);
        request.cwd = Some("nested".to_string());
        let plan = fixture.prepare(request);
        let token = fixture.approve(&plan);
        fs::remove_dir(&cwd).unwrap();
        assert!(fixture
            .execute(&plan, &token)
            .unwrap_err()
            .contains("工作目录不存在"));
        fixture.assert_finished(&plan, &token);
    }

    #[test]
    fn real_output_keeps_events_limits_tails_and_the_injected_log_location() {
        let fixture = Fixture::new();
        let bytes = MAX_OUTPUT_BYTES + 256;
        let script = if cfg!(windows) {
            format!("[Console]::Out.Write(('x' * {bytes})); [Console]::Out.Flush(); [Console]::Error.WriteLine('stderr-marker'); [Console]::Error.Flush()")
        } else {
            format!("head -c {bytes} /dev/zero | tr '\\000' x; printf 'stderr-marker\\n' >&2")
        };
        let plan = fixture.prepare(shell_request(&fixture.workspace_id, script));
        let token = fixture.approve(&plan);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        let emit: OutputEmitter = Arc::new(move |event| captured.lock().unwrap().push(event));
        let result = fixture
            .registry
            .execute_plan(&fixture.grants, emit, &plan.id, &token)
            .unwrap();
        assert_eq!(result.status, "completed");
        assert!(result.truncated);
        assert_eq!(result.stdout_tail, "x".repeat(OUTPUT_TAIL_BYTES));
        assert!(result.stderr_tail.contains("stderr-marker"));
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .all(|event| event.job_id == plan.id && event.seq > 0));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.stream == "stdout")
                .map(|event| event.chunk.len())
                .sum::<usize>(),
            bytes
        );
        let sequences: HashSet<_> = events.iter().map(|event| event.seq).collect();
        assert_eq!(sequences.len(), events.len());
        assert!(events.iter().any(|event| event.stream == "stderr"));
        let log = fs::read(
            fixture
                .paths
                .paths()
                .execution_output_dir()
                .join(&result.output_ref),
        )
        .unwrap();
        assert!(log.starts_with(format!("plan: {}\ndigest: {}", plan.id, plan.digest).as_bytes()));
        assert!(String::from_utf8_lossy(&log).contains("stderr-marker"));
        assert!(log.len() < MAX_OUTPUT_BYTES + 4096);
        fixture.assert_finished(&plan, &token);
    }

    #[test]
    fn execution_log_retention_only_prunes_its_injected_output_directory() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        for index in 0..MAX_EXECUTION_LOGS + 3 {
            let file = fs::File::create(
                fixture
                    .paths
                    .paths()
                    .execution_output_dir()
                    .join(format!("old-{index}.log")),
            )
            .unwrap();
            file.set_times(
                fs::FileTimes::new()
                    .set_modified(UNIX_EPOCH + Duration::from_secs(index as u64 + 1)),
            )
            .unwrap();
        }
        fs::write(
            other.paths.paths().execution_output_dir().join("keep.log"),
            "不得清理其他状态",
        )
        .unwrap();
        let plan = fixture.prepare(process_request(&fixture.workspace_id));
        let token = fixture.approve(&plan);
        let result = fixture.execute(&plan, &token).unwrap();
        assert_eq!(
            fs::read_dir(fixture.paths.paths().execution_output_dir())
                .unwrap()
                .count(),
            MAX_EXECUTION_LOGS
        );
        assert!(fixture
            .paths
            .paths()
            .execution_output_dir()
            .join(result.output_ref)
            .is_file());
        assert_eq!(
            fs::read_to_string(other.paths.paths().execution_output_dir().join("keep.log"))
                .unwrap(),
            "不得清理其他状态"
        );
        fixture.assert_finished(&plan, &token);
    }
}
