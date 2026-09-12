//! Rust 应用状态的唯一组合根：准备完整状态后再交给 Tauri 与迁移期兼容入口。

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use tauri::Manager;

use crate::app_paths::{AppPaths, AppPathsError};
use crate::command::ExecutionRegistry;
use crate::tts;
use crate::workspace_grants::WorkspaceGrants;

// ─── 迁移期目录兼容入口 ───────────────────────────────
// 尚未迁移的业务只引用组合根的同一份 AppPaths，不再保存独立目录配置。
static APP_PATHS: OnceLock<Arc<AppPaths>> = OnceLock::new();

fn install_legacy_paths(paths: Arc<AppPaths>) -> Result<(), &'static str> {
    APP_PATHS
        .set(paths)
        .map_err(|_| "AppPaths 兼容入口已装配")?;
    Ok(())
}

#[allow(dead_code)] // 独立业务链迁移期间暂存，#36 删除整个兼容入口。
fn app_paths() -> &'static AppPaths {
    APP_PATHS.get().expect("AppPaths 未装配")
}

#[allow(dead_code)] // 独立业务链迁移期间暂存，#36 删除整个兼容入口。
pub(crate) fn log_dir() -> PathBuf {
    let dir = app_paths().logs_dir().to_path_buf();
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 日志系统初始化前返回 None，供 panic hook 和测试期的尽力而为日志使用。
#[allow(dead_code)] // 独立业务链迁移期间暂存，#36 删除整个兼容入口。
pub(crate) fn initialized_log_dir() -> Option<PathBuf> {
    let dir = APP_PATHS.get()?.logs_dir().to_path_buf();
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

/// dev 使用项目目录存放角色、日志和会话；生产使用 app data，不复制预置角色。
/// 检查点备份与执行输出始终使用 app cache，授权表始终使用 app data。
pub(crate) fn assemble_paths(
    app_data: &Path,
    app_cache: &Path,
    dev_project_root: Option<&Path>,
) -> Result<AppPaths, AppPathsError> {
    let (characters, logs, sessions) = match dev_project_root {
        Some(project) => (
            project.join("characters"),
            project.join("logs"),
            project.join("logs"),
        ),
        None => (
            app_data.join("characters"),
            app_data.join("logs"),
            app_data.to_path_buf(),
        ),
    };
    AppPaths::new(
        characters,
        logs,
        app_cache.join("backups"),
        sessions,
        app_data.join("workspace-grants.json"),
        app_cache.join("execution-output"),
    )
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<Arc<AppPaths>, Box<dyn Error>> {
    let app_data = app.path().app_data_dir()?;
    let app_cache = app.path().app_cache_dir()?;
    // 生产构建不使用编译机的 CARGO_MANIFEST_DIR 来决定运行时目录。
    let dev_project_root = if cfg!(debug_assertions) {
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
    } else {
        None
    };
    let paths = Arc::new(assemble_paths(&app_data, &app_cache, dev_project_root)?);

    // 兼容入口只共享这一份已准备好的不可变配置，不再各自解析或创建目录状态。
    let grants = Arc::new(WorkspaceGrants::new(Arc::clone(&paths)));
    install_legacy_paths(Arc::clone(&paths))?;
    let registry = Arc::new(ExecutionRegistry::new(Arc::clone(&paths), Instant::now));
    if !app.manage(Arc::clone(&paths)) {
        return Err("AppPaths 已装配，拒绝重复托管".into());
    }
    if !app.manage(grants) {
        return Err("WorkspaceGrants 已装配，拒绝重复托管".into());
    }
    if !app.manage(registry) {
        return Err("ExecutionRegistry 已装配，拒绝重复托管".into());
    }
    if !app.manage(tts::TtsConnectionPool::new()) {
        return Err("TTS 连接池已装配，拒绝重复托管".into());
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn development_preserves_project_data_and_system_cache_layout() {
        let root = TempDir::new();
        let project = root.path().join("project");
        let data = root.path().join("app-data");
        let cache = root.path().join("app-cache");
        let paths = assemble_paths(&data, &cache, Some(&project)).unwrap();

        assert_eq!(paths.characters_dir(), project.join("characters"));
        assert_eq!(paths.logs_dir(), project.join("logs"));
        assert_eq!(paths.sessions_dir(), project.join("logs"));
        assert_eq!(paths.backups_dir(), cache.join("backups"));
        assert_eq!(paths.execution_output_dir(), cache.join("execution-output"));
        assert_eq!(
            paths.workspace_grants_file(),
            data.join("workspace-grants.json")
        );
        assert!(data.is_dir(), "dev 模式也应准备授权表的父目录");
    }

    #[test]
    fn production_preserves_app_data_and_cache_layout() {
        let root = TempDir::new();
        let data = root.path().join("app-data");
        let cache = root.path().join("app-cache");
        let paths = assemble_paths(&data, &cache, None).unwrap();

        assert_eq!(paths.characters_dir(), data.join("characters"));
        assert_eq!(paths.logs_dir(), data.join("logs"));
        assert_eq!(paths.sessions_dir(), data);
        assert_eq!(paths.backups_dir(), cache.join("backups"));
        assert_eq!(paths.execution_output_dir(), cache.join("execution-output"));
        assert_eq!(
            paths.workspace_grants_file(),
            data.join("workspace-grants.json")
        );
        assert!(std::fs::read_dir(paths.characters_dir())
            .unwrap()
            .next()
            .is_none());
    }

    #[test]
    fn assembly_propagates_unavailable_execution_output_directory() {
        let root = TempDir::new();
        let data = root.path().join("app-data");
        let cache = root.path().join("app-cache");
        std::fs::create_dir(&cache).unwrap();
        let blocked = cache.join("execution-output");
        std::fs::write(&blocked, "不可覆盖").unwrap();

        let error = assemble_paths(&data, &cache, None).unwrap_err();
        assert!(error.to_string().contains(&blocked.display().to_string()));
        assert!(error.source().is_some());
        assert_eq!(std::fs::read_to_string(blocked).unwrap(), "不可覆盖");
    }
}
