//! 会话数据文件持久化命令
//!
//! 聊天历史 / 会话列表从 localStorage 迁到 Rust 管理的 JSON 文件：
//!   - dev 模式：<项目>/logs/sessions.json（logs 目录已 gitignore）
//!   - 生产模式：<app_data_dir>/sessions.json
//!
//! 写入采用「临时文件 + 原子替换」，避免崩溃时留下半截 JSON。
//! 前端在非 Tauri 环境（浏览器调试）自动回退到 localStorage。

use std::fs;
use std::path::Path;

use crate::path::sessions_file;

/// 原子写入：先写临时文件再替换目标，防止进程中断导致 JSON 损坏。
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("写入会话临时文件失败: {}", e))?;
    // fs::rename 在 Unix 上原子；Windows 上 Rust 用 MoveFileEx(REPLACE_EXISTING)，
    // 可直接覆盖已存在目标。因此不要先 remove 目标——那会留下「旧文件已删、
    // 新文件未落」的丢数据窗口（进程中断即丢失全部会话）。
    fs::rename(&tmp, path).map_err(|e| format!("写入会话文件失败: {}", e))
}

/// 读取会话文件；文件不存在返回 null
#[tauri::command]
pub(crate) fn sessions_load() -> Result<Option<String>, String> {
    let p = sessions_file();
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p)
        .map(Some)
        .map_err(|e| format!("读取会话文件失败: {}", e))
}

/// 全量保存会话数据（JSON 字符串，由前端序列化）
#[tauri::command]
pub(crate) fn sessions_save(data: String) -> Result<(), String> {
    let p = sessions_file();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建会话目录失败: {}", e))?;
    }
    atomic_write(&p, &data)
}

/// 删除会话文件（清空全部会话时调用）
#[tauri::command]
pub(crate) fn sessions_clear() -> Result<(), String> {
    let p = sessions_file();
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("删除会话文件失败: {}", e))?;
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

        // 首次写入
        let data = r#"{"sessions":[],"currentId":"x"}"#;
        sessions_save(data.to_string()).unwrap();
        assert_eq!(sessions_load().unwrap(), Some(data.to_string()));

        // 覆盖写入（原子替换），并确认无临时文件残留
        sessions_save(r#"{"v":2,"sessions":[{"id":"a"}]}"#.to_string()).unwrap();
        let loaded = sessions_load().unwrap().unwrap();
        assert!(loaded.contains(r#""v":2"#));
        assert!(!sessions_file().with_extension("json.tmp").exists(), "临时文件应被清理");

        // 清空
        sessions_clear().unwrap();
        assert_eq!(sessions_load().unwrap(), None);

        let _ = fs::remove_dir_all(&root);
    }
}
