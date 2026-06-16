use std::fs;
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::path::log_dir;

/// 日志条目结构（与前端约定）
#[derive(Deserialize)]
pub(crate) struct LogEntryPayload {
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: Option<String>,
}

/// 日志条目（含行号，返回给前端显示）
#[derive(Serialize, Clone)]
pub(crate) struct LogEntry {
    line: usize,
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: String,
}

/// 追加日志条目到日志文件（JSONL 格式）
#[tauri::command]
pub(crate) fn append_log_entries(filename: String, entries: Vec<LogEntryPayload>) -> Result<(), String> {
    // 验证文件名安全（只允许字母、数字、连字符、点）
    if !filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("无效的文件名".to_string());
    }

    let path = log_dir().join(&filename);
    // 追加模式写入
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;

    for entry in &entries {
        let line = serde_json::json!({
            "timestamp": entry.timestamp,
            "level": entry.level,
            "namespace": entry.namespace,
            "message": entry.message,
            "source": entry.source,
        });
        writeln!(file, "{}", line).map_err(|e| format!("写入日志失败: {}", e))?;
    }

    Ok(())
}

/// 读取日志文件内容
#[tauri::command]
pub(crate) fn read_log_file(filename: String) -> Result<Vec<LogEntry>, String> {
    if !filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("无效的文件名".to_string());
    }

    let path = log_dir().join(&filename);
    if !path.exists() {
        return Ok(vec![]);
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("读取日志文件失败: {}", e))?;

    let mut entries = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(val) => {
                entries.push(LogEntry {
                    line: i + 1,
                    timestamp: val["timestamp"].as_str().unwrap_or("").to_string(),
                    level: val["level"].as_str().unwrap_or("").to_string(),
                    namespace: val["namespace"].as_str().unwrap_or("").to_string(),
                    message: val["message"].as_str().unwrap_or("").to_string(),
                    source: val["source"].as_str().unwrap_or("主窗口").to_string(),
                });
            }
            Err(_) => {
                // 跳过解析失败的行
                entries.push(LogEntry {
                    line: i + 1,
                    timestamp: String::new(),
                    level: "warn".to_string(),
                    namespace: "System".to_string(),
                    message: format!("[日志解析失败] {}", line),
                    source: String::new(),
                });
            }
        }
    }

    Ok(entries)
}

/// 导出日志文件到指定路径（由前端 dialog 选择目标路径）
#[tauri::command]
pub(crate) fn export_log_file(source_filename: String, dest_path: String) -> Result<(), String> {
    if !source_filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("无效的文件名".to_string());
    }

    let src = log_dir().join(&source_filename);
    if !src.exists() {
        return Err("日志文件不存在".to_string());
    }

    // 防御性校验：拒绝含 path traversal 的目标路径（正常由前端 dialog 传入，不应出现）
    let dest = std::path::PathBuf::from(&dest_path);
    if dest.to_string_lossy().contains("..") {
        return Err("无效的导出路径".to_string());
    }

    // 确保目标目录存在
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    fs::copy(&src, &dest).map_err(|e| format!("导出日志文件失败: {}", e))?;
    Ok(())
}

/// 列出 logs 目录下所有日志文件名
#[tauri::command]
pub(crate) fn list_log_files() -> Result<Vec<String>, String> {
    let dir = log_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("读取日志目录失败: {}", e))?
        .filter_map(|entry| {
            let e = entry.ok()?;
            if e.file_type().ok()?.is_file() {
                e.file_name().to_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();
    files.sort();
    files.reverse(); // 最新的在前
    Ok(files)
}
