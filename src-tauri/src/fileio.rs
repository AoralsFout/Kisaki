//! AI 工作目录文件读写命令
//!
//! 供前端 agent 工具调用，让 AI 在「用户授权的工作目录」内读写文件。
//! 沙箱模型：
//!   - 工作目录（root）由用户在前端通过目录选择框手动授权，按会话存储在前端。
//!   - 本模块的命令均无全局状态：每次调用把 root 作参数传入，LLM 只能提供
//!     相对路径（rel_path），永远碰不到 root 之外的文件。
//!   - 所有相对路径经 `safe_join_rel` 校验，防 path traversal / 符号链接逃逸。

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use crate::path::safe_join_rel;

/// 单次读取上限：2 MiB。防止把超大文件灌进 LLM 上下文。
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// 校验 root 是有效目录并规范化返回。
fn check_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err("工作目录无效或已不存在".to_string());
    }
    p.canonicalize().map_err(|e| format!("无法解析工作目录: {}", e))
}

/// 读取工作目录内某文本文件的内容（UTF-8）。
#[tauri::command]
pub(crate) fn agent_read_file(root: String, rel_path: String) -> Result<String, String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
    let meta = fs::metadata(&path).map_err(|e| format!("读取失败: {}", e))?;
    if !meta.is_file() {
        return Err("目标不是文件".to_string());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大（{} 字节，上限 {} 字节）",
            meta.len(),
            MAX_READ_BYTES
        ));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取失败（需为 UTF-8 文本）: {}", e))
}

/// 写入/覆盖工作目录内的文件，自动创建所需的父目录。
#[tauri::command]
pub(crate) fn agent_write_file(
    root: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

/// 在文件末尾追加内容（文件不存在则创建）。
#[tauri::command]
pub(crate) fn agent_append_file(
    root: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开文件失败: {}", e))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("追加失败: {}", e))
}

/// 列出工作目录（或其子目录）下的条目。rel_path 为空表示根。
#[tauri::command]
pub(crate) fn agent_list_dir(
    root: String,
    rel_path: String,
) -> Result<serde_json::Value, String> {
    let rel = if rel_path.is_empty() { "." } else { &rel_path };
    let dir = safe_join_rel(&check_root(&root)?, rel)?;
    if !dir.is_dir() {
        return Err("目标不是目录".to_string());
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("读取目录失败: {}", e))?
        .flatten()
    {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        items.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "is_dir": ft.is_dir(),
            "size": entry.metadata().map(|m| m.len()).unwrap_or(0),
        }));
    }
    Ok(serde_json::Value::Array(items))
}

/// 删除工作目录内的文件。仅允许删除文件，拒绝删除目录（防误删整目录）。
#[tauri::command]
pub(crate) fn agent_delete_file(root: String, rel_path: String) -> Result<(), String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    if path.is_dir() {
        return Err("拒绝删除目录，仅允许删除文件".to_string());
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))
}
