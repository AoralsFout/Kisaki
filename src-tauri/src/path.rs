use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// ─── 数据目录 ─────────────────────────────────────────
// 双路径策略：
//   dev  模式 → characters: <项目>/characters/（git 可追踪）, logs: 项目根/logs/
//   生产模式 → characters: app_data_dir/characters/,         logs: app_data_dir/logs/
// 不内置预置角色：生产模式首次启动 characters 为空，由用户通过「导入角色包」填充。
// run() 阶段通过 init_dirs 初始化两个 OnceLock。

static CHARACTERS_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();
static BACKUPS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 初始化数据目录（在 tauri setup 阶段调用）
pub(crate) fn init_dirs(chars: PathBuf, logs: PathBuf, backups: PathBuf) -> Result<(), &'static str> {
    fs::create_dir_all(&chars).map_err(|_| "创建 characters 目录失败")?;
    fs::create_dir_all(&logs).map_err(|_| "创建 logs 目录失败")?;
    fs::create_dir_all(&backups).map_err(|_| "创建 backups 目录失败")?;
    CHARACTERS_DIR
        .set(chars)
        .map_err(|_| "CHARACTERS_DIR already set")?;
    LOGS_DIR
        .set(logs)
        .map_err(|_| "LOGS_DIR already set")?;
    BACKUPS_DIR
        .set(backups)
        .map_err(|_| "BACKUPS_DIR already set")?;
    Ok(())
}

pub(crate) fn characters_dir() -> PathBuf {
    CHARACTERS_DIR
        .get()
        .expect("CHARACTERS_DIR 未初始化")
        .clone()
}

pub(crate) fn log_dir() -> PathBuf {
    let dir = LOGS_DIR
        .get()
        .expect("LOGS_DIR 未初始化")
        .clone();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// AI 文件改动备份根目录（app_cache_dir/backups）。
pub(crate) fn backups_dir() -> PathBuf {
    let dir = BACKUPS_DIR
        .get()
        .expect("BACKUPS_DIR 未初始化")
        .clone();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 路径安全校验 — 防止 path traversal 攻击
///
/// 验证路径组件不包含 `..`、路径分隔符等危险字符。
pub(crate) fn sanitize_path_component(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("路径组件不能为空".to_string());
    }
    if name.contains("..") {
        return Err("路径组件不能包含 '..'".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("路径组件不能包含分隔符".to_string());
    }
    Ok(())
}

/// 安全的路径拼接 — 确保最终路径在基目录下
///
/// 1. 校验每个路径组件不含 path traversal
/// 2. 规范化基目录
/// 3. 验证最终路径前缀在基目录内
pub(crate) fn safe_join(base: &Path, filename: &str) -> Result<PathBuf, String> {
    sanitize_path_component(filename)?;

    // 规范化基目录（消解 .. 和符号链接）
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("无法解析基路径 '{}': {}", base.display(), e))?;

    // 拼接目标路径
    let target = canonical_base.join(filename);

    // 验证目标路径仍在基目录下（防止符号链接绕过）
    if !target.starts_with(&canonical_base) {
        return Err("路径越权访问被拒绝".to_string());
    }

    Ok(target)
}

/// 安全拼接相对子路径 — 用于 AI 工作目录读写，支持多层子目录
///
/// 与 `safe_join` 不同，本函数允许 `a/b/c.txt` 形式的相对路径，
/// 但仍严格防护 path traversal：
/// 1. 拒绝绝对路径与含 `..` 的组件
/// 2. canonicalize 基目录
/// 3. 对已存在的目标做 canonicalize 后校验前缀（防符号链接绕过）；
///    目标不存在时（如写入新文件），直接用拼接路径校验前缀。
pub(crate) fn safe_join_rel(base: &Path, rel: &str) -> Result<PathBuf, String> {
    use std::path::Component;

    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("不允许绝对路径".to_string());
    }
    for comp in rel_path.components() {
        match comp {
            Component::ParentDir => return Err("路径不能包含 '..'".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("不允许绝对路径".to_string())
            }
            _ => {}
        }
    }

    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("无法解析工作目录 '{}': {}", base.display(), e))?;

    let target = canonical_base.join(rel_path);

    // 已存在则按真实路径校验（消解符号链接）；不存在则按拼接路径校验。
    let check = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("无法解析目标路径: {}", e))?
    } else {
        target.clone()
    };
    if !check.starts_with(&canonical_base) {
        return Err("路径越权访问被拒绝".to_string());
    }

    Ok(target)
}
