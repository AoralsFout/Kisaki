//! v2 会话领域文档持久化及其薄命令适配器。
//!
//! 写入采用「临时文件 + 原子替换」，避免崩溃时留下半截 JSON。
//! 前端在非 Tauri 环境（浏览器调试）自动回退到 localStorage。

use std::fs;
use std::path::Path;
use std::sync::Arc;

use crate::app_paths::AppPaths;

/// 原子写入：先写临时文件再替换目标，防止进程中断导致 JSON 损坏。
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("写入会话临时文件失败: {}", e))?;
    // fs::rename 在 Unix 上原子；Windows 上 Rust 用 MoveFileEx(REPLACE_EXISTING)，
    // 可直接覆盖已存在目标。因此不要先 remove 目标——那会留下「旧文件已删、
    // 新文件未落」的丢数据窗口（进程中断即丢失全部会话）。
    fs::rename(&tmp, path).map_err(|e| format!("写入会话文件失败: {}", e))
}

#[tauri::command]
pub(crate) fn sessions_v2_load(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<Option<String>, String> {
    load(&paths)
}

#[tauri::command]
pub(crate) fn sessions_v2_save(
    paths: tauri::State<'_, Arc<AppPaths>>,
    data: String,
) -> Result<(), String> {
    save(&paths, &data)
}

#[tauri::command]
pub(crate) fn sessions_v2_clear(paths: tauri::State<'_, Arc<AppPaths>>) -> Result<(), String> {
    clear(&paths)
}

/// 读取 v2 会话领域模型文件；不尝试解析或迁移旧 sessions.json。
pub(crate) fn load(paths: &AppPaths) -> Result<Option<String>, String> {
    let p = paths.sessions_v2_file();
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p)
        .map(Some)
        .map_err(|e| format!("读取 v2 会话文件失败: {}", e))
}

/// 原子保存 v2 会话领域模型文件。schema 校验由领域适配器负责。
pub(crate) fn save(paths: &AppPaths, data: &str) -> Result<(), String> {
    let p = paths.sessions_v2_file();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建会话目录失败: {}", e))?;
    }
    atomic_write(&p, data)
}

pub(crate) fn clear(paths: &AppPaths) -> Result<(), String> {
    let p = paths.sessions_v2_file();
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("删除 v2 会话文件失败: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempAppPaths;

    const FIRST: &str = r#"{"schemaVersion":2,"currentSessionId":"a","sessions":[]}"#;
    const SECOND: &str = r#"{"schemaVersion":2,"currentSessionId":"b","sessions":[]}"#;

    #[test]
    fn first_load_is_empty_without_global_initialization() {
        let fixture = TempAppPaths::new();
        assert_eq!(load(fixture.paths()).unwrap(), None);
    }

    #[test]
    fn file_roundtrip_atomic_and_clear() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        save(paths, FIRST).unwrap();
        assert_eq!(load(paths).unwrap().as_deref(), Some(FIRST));
        save(paths, SECOND).unwrap();
        assert_eq!(load(paths).unwrap().as_deref(), Some(SECOND));
        assert!(
            !paths.sessions_v2_file().with_extension("json.tmp").exists(),
            "临时文件应被清理"
        );
        clear(paths).unwrap();
        assert_eq!(load(paths).unwrap(), None);
    }

    #[test]
    fn independent_app_paths_do_not_share_session_writes_or_clears() {
        let first = TempAppPaths::new();
        let second = TempAppPaths::new();
        assert_ne!(first.root(), second.root());

        std::thread::scope(|scope| {
            scope.spawn(|| save(first.paths(), FIRST).unwrap());
            scope.spawn(|| save(second.paths(), SECOND).unwrap());
        });
        assert_eq!(load(first.paths()).unwrap().as_deref(), Some(FIRST));
        assert_eq!(load(second.paths()).unwrap().as_deref(), Some(SECOND));
        assert_eq!(
            fs::read_to_string(first.root().join("sessions/sessions-v2.json")).unwrap(),
            FIRST
        );
        assert_eq!(
            fs::read_to_string(second.root().join("sessions/sessions-v2.json")).unwrap(),
            SECOND
        );

        clear(first.paths()).unwrap();
        assert_eq!(load(first.paths()).unwrap(), None);
        assert_eq!(load(second.paths()).unwrap().as_deref(), Some(SECOND));
    }

    #[test]
    fn load_and_idempotent_clear_leave_legacy_sessions_untouched() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::write(paths.legacy_sessions_file(), "旧版会话").unwrap();
        assert_eq!(load(paths).unwrap(), None);
        clear(paths).unwrap();
        save(paths, FIRST).unwrap();
        clear(paths).unwrap();
        clear(paths).unwrap();
        assert_eq!(load(paths).unwrap(), None);
        assert_eq!(
            fs::read_to_string(paths.legacy_sessions_file()).unwrap(),
            "旧版会话"
        );
    }

    #[test]
    fn failed_temporary_write_preserves_the_last_saved_document() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        save(paths, FIRST).unwrap();
        fs::create_dir(paths.sessions_v2_file().with_extension("json.tmp")).unwrap();

        let error = save(paths, SECOND).unwrap_err();
        assert!(error.contains("写入会话临时文件失败"), "{error}");
        assert_eq!(load(paths).unwrap().as_deref(), Some(FIRST));
    }

    #[test]
    fn failed_replacement_reports_an_error_without_removing_the_target() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::create_dir(paths.sessions_v2_file()).unwrap();

        let error = save(paths, FIRST).unwrap_err();
        assert!(error.contains("写入会话文件失败"), "{error}");
        assert!(paths.sessions_v2_file().is_dir());
    }

    #[test]
    fn invalid_utf8_is_reported_instead_of_returned_as_missing_data() {
        let fixture = TempAppPaths::new();
        fs::write(fixture.paths().sessions_v2_file(), [0xff]).unwrap();

        let error = load(fixture.paths()).unwrap_err();
        assert!(error.contains("读取 v2 会话文件失败"), "{error}");
    }

    #[test]
    fn failed_clear_reports_an_error_without_removing_a_directory() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::create_dir(paths.sessions_v2_file()).unwrap();

        let error = clear(paths).unwrap_err();
        assert!(error.contains("删除 v2 会话文件失败"), "{error}");
        assert!(paths.sessions_v2_file().is_dir());
    }

    #[test]
    fn save_recreates_the_session_directory_and_preserves_payload_bytes() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::remove_dir(paths.sessions_dir()).unwrap();
        let payload = " {\n  \"schemaVersion\": 2, \"title\": \"会话\"\n}\n";

        save(paths, payload).unwrap();
        assert_eq!(load(paths).unwrap().as_deref(), Some(payload));
        assert_eq!(
            fs::read(paths.sessions_v2_file()).unwrap(),
            payload.as_bytes()
        );
    }
}
