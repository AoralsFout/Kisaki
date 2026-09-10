//! v2 会话领域文档持久化命令。
//!
//! 写入采用「临时文件 + 原子替换」，避免崩溃时留下半截 JSON。
//! 前端在非 Tauri 环境（浏览器调试）自动回退到 localStorage。

use std::fs;
use std::path::Path;

use crate::path::sessions_v2_file;

/// 原子写入：先写临时文件再替换目标，防止进程中断导致 JSON 损坏。
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("写入会话临时文件失败: {}", e))?;
    // fs::rename 在 Unix 上原子；Windows 上 Rust 用 MoveFileEx(REPLACE_EXISTING)，
    // 可直接覆盖已存在目标。因此不要先 remove 目标——那会留下「旧文件已删、
    // 新文件未落」的丢数据窗口（进程中断即丢失全部会话）。
    fs::rename(&tmp, path).map_err(|e| format!("写入会话文件失败: {}", e))
}

/// 读取 v2 会话领域模型文件；不尝试解析或迁移旧 sessions.json。
#[tauri::command]
pub(crate) fn sessions_v2_load() -> Result<Option<String>, String> {
    let p = sessions_v2_file();
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p)
        .map(Some)
        .map_err(|e| format!("读取 v2 会话文件失败: {}", e))
}

/// 原子保存 v2 会话领域模型文件。schema 校验由领域适配器负责。
#[tauri::command]
pub(crate) fn sessions_v2_save(data: String) -> Result<(), String> {
    let p = sessions_v2_file();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建会话目录失败: {}", e))?;
    }
    atomic_write(&p, &data)
}

#[tauri::command]
pub(crate) fn sessions_v2_clear() -> Result<(), String> {
    let p = sessions_v2_file();
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("删除 v2 会话文件失败: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn init_temp_dirs(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kisaki-sessions-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 初始化 path 模块的数据目录（OnceLock 每进程只能设置一次）
        let _ = crate::path::init_dirs(
            root.join("characters"),
            root.join("logs"),
            root.join("backups"),
            root.clone(),
            root.join("workspace-grants.json"),
        );
        root
    }

    #[test]
    fn file_roundtrip_atomic_and_clear() {
        let root = init_temp_dirs("roundtrip");

        // v2 首次写入、覆盖和清空都只操作 sessions-v2.json。
        let v2 = r#"{"schemaVersion":2,"currentSessionId":"a","sessions":[]}"#;
        sessions_v2_save(v2.to_string()).unwrap();
        assert_eq!(sessions_v2_load().unwrap(), Some(v2.to_string()));
        sessions_v2_save(v2.replace("a", "b")).unwrap();
        assert!(sessions_v2_load().unwrap().unwrap().contains(r#""b""#));
        assert!(!sessions_v2_file().with_extension("json.tmp").exists(), "临时文件应被清理");
        sessions_v2_clear().unwrap();
        assert_eq!(sessions_v2_load().unwrap(), None);

        let _ = fs::remove_dir_all(&root);
    }
}
