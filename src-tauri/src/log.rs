use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Mutex, OnceLock, TryLockError};

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::path::{initialized_log_dir, log_dir};

/// 单个日志文件大小上限（超过则轮转）
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// 保留的轮转日志数量（.1 ~ .N，外加当前文件）
const MAX_LOG_ROTATIONS: u32 = 3;

fn log_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 轮转日志文件：当前文件超过大小上限时，
/// 依次后移（.1 → .2 → …），最旧的删除，当前文件改为 .1 后重新创建。
fn rotate_log_if_needed(path: &std::path::Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    // 删除最旧的轮转文件
    let last = format!("{}.{}", path.display(), MAX_LOG_ROTATIONS);
    let _ = fs::remove_file(&last);
    // 依次后移
    for i in (1..MAX_LOG_ROTATIONS).rev() {
        let from = format!("{}.{}", path.display(), i);
        let to = format!("{}.{}", path.display(), i + 1);
        let _ = fs::rename(&from, &to);
    }
    let _ = fs::rename(path, format!("{}.1", path.display()));
}

/// 日志条目结构（与前端约定）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LogEntryPayload {
    schema_version: u8,
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: String,
    event: String,
    #[serde(default)]
    error: Option<serde_json::Value>,
    #[serde(default)]
    context: Option<serde_json::Value>,
}

impl LogEntryPayload {
    fn is_valid(&self) -> bool {
        self.schema_version == 2
            && matches!(
                self.level.as_str(),
                "trace" | "debug" | "info" | "warn" | "error"
            )
            && !self.timestamp.trim().is_empty()
            && !self.namespace.trim().is_empty()
            && !self.message.trim().is_empty()
            && !self.source.trim().is_empty()
            && is_valid_event_name(&self.event)
    }
}

fn is_valid_event_name(event: &str) -> bool {
    let mut segments = event.split('.');
    let valid_segment = |segment: &str| {
        let mut chars = segment.chars();
        chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    };
    let Some(first) = segments.next() else {
        return false;
    };
    valid_segment(first) && segments.clone().next().is_some() && segments.all(valid_segment)
}

/// 日志条目（含行号，返回给前端显示）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogEntry {
    line: usize,
    schema_version: u8,
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: String,
    event: String,
    error: Option<serde_json::Value>,
    context: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub(crate) struct LogPage {
    entries: Vec<LogEntry>,
    /// 下一页应读取的字节位置；前端把它原样作为 before 传回。
    next_before: Option<u64>,
    has_more: bool,
}

fn is_safe_filename(filename: &str) -> bool {
    filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn is_log_filename(filename: &str) -> bool {
    let Some((stem, rotation)) = filename.split_once(".jsonl") else {
        return false;
    };
    let date = match stem.strip_prefix("app-v2-") {
        Some(date) if date.len() == 10 => date.as_bytes(),
        _ => return false,
    };
    let valid_date = date.iter().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            *b == b'-'
        } else {
            b.is_ascii_digit()
        }
    });
    valid_date
        && (rotation.is_empty()
            || rotation
                .strip_prefix('.')
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
}

fn log_sort_parts(filename: &str) -> (&str, u32) {
    let (stem, rotation) = filename.split_once(".jsonl").unwrap_or((filename, ""));
    let rotation = rotation
        .strip_prefix('.')
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    (stem, rotation)
}

fn log_file_date(filename: &str) -> Option<NaiveDate> {
    let (stem, _) = filename.split_once(".jsonl")?;
    NaiveDate::parse_from_str(stem.strip_prefix("app-v2-")?, "%Y-%m-%d").ok()
}

fn retention_cutoff(today: NaiveDate, retention_days: u32) -> NaiveDate {
    let retention_days = retention_days.clamp(1, 365);
    today - Duration::days(i64::from(retention_days.saturating_sub(1)))
}

/// 删除超过保留期的应用日志；仅处理经过严格文件名校验的 app-v2 日志。
#[tauri::command]
pub(crate) fn prune_log_files(retention_days: u32) -> Result<u32, String> {
    // “保留 N 天”包含今天，因此 14 天表示今天 + 之前 13 个自然日。
    let cutoff = retention_cutoff(Local::now().date_naive(), retention_days);
    let dir = log_dir();
    if !dir.exists() {
        return Ok(0);
    }

    let _guard = log_write_lock()
        .lock()
        .map_err(|_| "日志写入锁已损坏".to_string())?;
    let mut removed = 0;
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取日志目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取日志条目失败: {}", e))?;
        if !entry
            .file_type()
            .map_err(|e| format!("读取日志类型失败: {}", e))?
            .is_file()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_log_filename(&name) || log_file_date(&name).is_none_or(|date| date >= cutoff) {
            continue;
        }
        fs::remove_file(entry.path()).map_err(|e| format!("删除过期日志失败: {}", e))?;
        removed += 1;
    }
    Ok(removed)
}

fn parse_log_entry(line: &[u8], line_number: usize) -> LogEntry {
    let text = String::from_utf8_lossy(line)
        .trim_end_matches('\r')
        .to_string();
    match serde_json::from_str::<LogEntryPayload>(&text) {
        Ok(val) if val.is_valid() => LogEntry {
            line: line_number,
            schema_version: val.schema_version,
            timestamp: val.timestamp,
            level: val.level,
            namespace: val.namespace,
            message: val.message,
            source: val.source,
            event: val.event,
            error: val.error,
            context: val.context,
        },
        _ => LogEntry {
            line: line_number,
            schema_version: 2,
            timestamp: String::new(),
            level: "warn".to_string(),
            namespace: "System".to_string(),
            message: format!("[日志解析失败] {}", text),
            source: String::new(),
            event: "logger.parse_failed".to_string(),
            error: None,
            context: None,
        },
    }
}

fn read_log_page(
    file: &mut fs::File,
    file_len: u64,
    before: Option<u64>,
    page_size: usize,
) -> Result<LogPage, String> {
    let end = before.unwrap_or(file_len).min(file_len);
    if end == 0 {
        return Ok(LogPage {
            entries: vec![],
            next_before: None,
            has_more: false,
        });
    }

    let page_size = page_size.clamp(1, 500);
    let mut start = end;
    let mut buffer = Vec::<u8>::new();
    let mut newline_count = 0usize;

    while start > 0 && newline_count <= page_size {
        let chunk_start = start.saturating_sub(8192);
        let chunk_len = (start - chunk_start) as usize;
        let mut chunk = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(chunk_start))
            .map_err(|e| format!("定位日志文件失败: {}", e))?;
        file.read_exact(&mut chunk)
            .map_err(|e| format!("读取日志文件失败: {}", e))?;
        newline_count += chunk.iter().filter(|&&b| b == b'\n').count();
        chunk.extend_from_slice(&buffer);
        buffer = chunk;
        start = chunk_start;
    }

    // start > 0 时首行可能从中间开始，必须从第一个换行符后再解析。
    let first_complete = if start == 0 {
        0
    } else {
        buffer
            .iter()
            .position(|&b| b == b'\n')
            .map_or(buffer.len(), |i| i + 1)
    };
    let mut ranges = Vec::<(usize, usize)>::new();
    let mut line_start = first_complete;
    for (i, &byte) in buffer.iter().enumerate().skip(first_complete) {
        if byte == b'\n' {
            if i > line_start {
                ranges.push((line_start, i));
            }
            line_start = i + 1;
        }
    }
    if line_start < buffer.len() {
        ranges.push((line_start, buffer.len()));
    }

    let selected_from = ranges.len().saturating_sub(page_size);
    let selected = &ranges[selected_from..];
    let page_start = selected
        .first()
        .map(|(s, _)| start + *s as u64)
        .unwrap_or(end);
    let entries = selected
        .iter()
        .enumerate()
        .map(|(i, (from, to))| parse_log_entry(&buffer[*from..*to], i + 1))
        .collect();
    let has_more = page_start > 0;

    Ok(LogPage {
        entries,
        next_before: has_more.then_some(page_start),
        has_more,
    })
}

/// 追加日志条目到日志文件（JSONL 格式）
#[tauri::command]
pub(crate) fn append_log_entries(
    filename: String,
    entries: Vec<LogEntryPayload>,
) -> Result<(), String> {
    // 验证文件名安全（只允许字母、数字、连字符、点）
    if !is_safe_filename(&filename) || !is_log_filename(&filename) {
        return Err("无效的文件名".to_string());
    }
    if entries.iter().any(|entry| !entry.is_valid()) {
        return Err("日志条目不符合 v2 schema".to_string());
    }

    let _guard = log_write_lock()
        .lock()
        .map_err(|_| "日志写入锁已损坏".to_string())?;
    let path = log_dir().join(&filename);
    // 超过大小上限先轮转，避免单文件无限增长
    rotate_log_if_needed(&path);
    // 追加模式写入
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;

    let mut output = String::new();
    for entry in &entries {
        let line = serde_json::json!({
            "schemaVersion": entry.schema_version,
            "timestamp": entry.timestamp,
            "level": entry.level,
            "namespace": entry.namespace,
            "message": entry.message,
            "source": entry.source,
            "event": entry.event,
            "error": entry.error,
            "context": entry.context,
        });
        output.push_str(&line.to_string());
        output.push('\n');
    }
    file.write_all(output.as_bytes())
        .map_err(|e| format!("写入日志失败: {}", e))?;

    Ok(())
}

fn write_native_log_file(level: &str, namespace: &str, message: String, event: &str) {
    let Some(dir) = initialized_log_dir() else {
        return;
    };
    let now = Local::now();
    let path = dir.join(format!("app-v2-{}.jsonl", now.format("%Y-%m-%d")));
    rotate_log_if_needed(&path);
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let line = serde_json::json!({
        "schemaVersion": 2,
        "timestamp": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "namespace": namespace,
        "message": message,
        "source": "Rust",
        "event": event
    });
    let _ = writeln!(file, "{}", line);
}

/// 写入 Rust 原生侧日志，与 WebView 日志共用 JSONL、轮转和写入锁。
pub(crate) fn write_native_log(level: &str, namespace: &str, message: String) {
    let _guard = log_write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_native_log_file(level, namespace, message, "native.runtime_log");
}

fn try_write_panic_log(message: String) {
    // panic 可能发生在持有日志锁时；try_lock 可避免 panic hook 自锁死。
    let _guard = match log_write_lock().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    write_native_log_file("error", "RustPanic", message, "native.panic");
}

/// 把未捕获 Rust panic 记入当日日志，同时保留默认 panic 输出。
pub(crate) fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("未知 panic");
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        try_write_panic_log(format!("{} ({})", payload, location));
        previous(info);
    }));
}

/// 读取日志文件内容
#[tauri::command]
pub(crate) fn read_log_file(filename: String) -> Result<Vec<LogEntry>, String> {
    if !is_safe_filename(&filename) || !is_log_filename(&filename) {
        return Err("无效的日志文件名".to_string());
    }

    let path = log_dir().join(&filename);
    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("读取日志文件失败: {}", e))?;

    let mut entries = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        entries.push(parse_log_entry(line.as_bytes(), i + 1));
    }

    Ok(entries)
}

/// 从文件尾部向前分页读取日志。首次不传 before，之后传回 next_before；每页仍按
/// 时间正序返回，便于前端把旧页插到列表顶部并保持滚动位置。
#[tauri::command]
pub(crate) fn read_log_file_page(
    filename: String,
    before: Option<u64>,
    limit: Option<usize>,
) -> Result<LogPage, String> {
    if !is_safe_filename(&filename) || !is_log_filename(&filename) {
        return Err("无效的日志文件名".to_string());
    }

    let path = log_dir().join(&filename);
    if !path.exists() {
        return Ok(LogPage {
            entries: vec![],
            next_before: None,
            has_more: false,
        });
    }

    let mut file = fs::File::open(&path).map_err(|e| format!("读取日志文件失败: {}", e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("读取日志信息失败: {}", e))?
        .len();
    read_log_page(&mut file, file_len, before, limit.unwrap_or(200))
}

/// 导出日志文件到指定路径（由前端 dialog 选择目标路径）
#[tauri::command]
pub(crate) fn export_log_file(source_filename: String, dest_path: String) -> Result<(), String> {
    if !is_safe_filename(&source_filename) {
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
                e.file_name()
                    .to_str()
                    .filter(|name| is_log_filename(name))
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();
    files.sort_by(|a, b| {
        let (a_date, a_rotation) = log_sort_parts(a);
        let (b_date, b_rotation) = log_sort_parts(b);
        b_date.cmp(a_date).then(a_rotation.cmp(&b_rotation))
    });
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_application_jsonl_files_are_log_files() {
        assert!(is_log_filename("app-v2-2026-08-30.jsonl"));
        assert!(is_log_filename("app-v2-2026-08-30.jsonl.2"));
        assert!(!is_log_filename("app-2026-08-30.jsonl"));
        assert!(!is_log_filename("sessions.json"));
        assert!(!is_log_filename("__export_temp.jsonl"));
        assert!(!is_log_filename("app-v2-2026-8-30.jsonl"));
        assert!(!is_log_filename("app-v2-2026-08-30.jsonl.backup"));
        assert_eq!(
            log_file_date("app-v2-2026-08-30.jsonl.2"),
            NaiveDate::from_ymd_opt(2026, 8, 30),
        );
        assert_eq!(
            retention_cutoff(NaiveDate::from_ymd_opt(2026, 9, 8).unwrap(), 14),
            NaiveDate::from_ymd_opt(2026, 8, 26).unwrap(),
        );

        let mut files = [
            "app-v2-2026-08-29.jsonl".to_string(),
            "app-v2-2026-08-30.jsonl.2".to_string(),
            "app-v2-2026-08-30.jsonl".to_string(),
            "app-v2-2026-08-30.jsonl.1".to_string(),
        ];
        files.sort_by(|a, b| {
            let (a_date, a_rotation) = log_sort_parts(a);
            let (b_date, b_rotation) = log_sort_parts(b);
            b_date.cmp(a_date).then(a_rotation.cmp(&b_rotation))
        });
        assert_eq!(files[0], "app-v2-2026-08-30.jsonl");
        assert_eq!(files[1], "app-v2-2026-08-30.jsonl.1");
        assert_eq!(files[3], "app-v2-2026-08-29.jsonl");
    }

    #[test]
    fn reads_history_from_the_end_in_stable_pages() {
        let path = std::env::temp_dir().join(format!(
            "kisaki-log-page-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut content = String::new();
        for i in 0..450 {
            content.push_str(
                &serde_json::json!({
                    "schemaVersion": 2,
                    "timestamp": "2026-08-30T00:00:00.000Z",
                    "level": "info",
                    "namespace": "Test",
                    "message": format!("entry-{i}"),
                    "source": "test",
                    "event": "test.entry"
                })
                .to_string(),
            );
            content.push('\n');
        }
        fs::write(&path, content).unwrap();

        let mut file = fs::File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        let newest = read_log_page(&mut file, len, None, 200).unwrap();
        assert_eq!(newest.entries.len(), 200);
        assert_eq!(newest.entries.first().unwrap().message, "entry-250");
        assert_eq!(newest.entries.last().unwrap().message, "entry-449");
        assert!(newest.has_more);

        let middle = read_log_page(&mut file, len, newest.next_before, 200).unwrap();
        assert_eq!(middle.entries.first().unwrap().message, "entry-50");
        assert_eq!(middle.entries.last().unwrap().message, "entry-249");
        assert!(middle.has_more);

        let oldest = read_log_page(&mut file, len, middle.next_before, 200).unwrap();
        assert_eq!(oldest.entries.len(), 50);
        assert_eq!(oldest.entries.first().unwrap().message, "entry-0");
        assert_eq!(oldest.entries.last().unwrap().message, "entry-49");
        assert!(!oldest.has_more);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn preserves_structured_diagnostic_fields() {
        let line = serde_json::json!({
            "schemaVersion": 2,
            "timestamp": "2026-09-08T01:02:03.000Z",
            "level": "error",
            "namespace": "API",
            "message": "request failed",
            "source": "主窗口",
            "event": "ai.request_failed",
            "error": { "name": "Error", "message": "timeout", "stack": "stack" },
            "context": { "requestId": "req-1" }
        })
        .to_string();

        let entry = parse_log_entry(line.as_bytes(), 1);
        assert_eq!(entry.schema_version, 2);
        assert_eq!(entry.event, "ai.request_failed");
        assert_eq!(entry.error.as_ref().unwrap()["message"], "timeout");
        assert_eq!(entry.context.as_ref().unwrap()["requestId"], "req-1");
    }

    #[test]
    fn rejects_non_v2_or_unknown_log_fields() {
        let legacy = serde_json::json!({
            "timestamp": "2026-09-08T01:02:03.000Z",
            "level": "info",
            "namespace": "Test",
            "message": "legacy",
            "source": "test",
            "event": "test.entry",
            "args": []
        });
        assert!(serde_json::from_value::<LogEntryPayload>(legacy).is_err());

        let unknown = serde_json::json!({
            "schemaVersion": 2,
            "timestamp": "2026-09-08T01:02:03.000Z",
            "level": "info",
            "namespace": "Test",
            "message": "entry",
            "source": "test",
            "event": "test.entry",
            "extra": true
        });
        assert!(serde_json::from_value::<LogEntryPayload>(unknown).is_err());

        let invalid_level = serde_json::json!({
            "schemaVersion": 2,
            "timestamp": "2026-09-08T01:02:03.000Z",
            "level": "notice",
            "namespace": "Test",
            "message": "entry",
            "source": "test",
            "event": "test.entry"
        });
        let payload = serde_json::from_value::<LogEntryPayload>(invalid_level).unwrap();
        assert!(!payload.is_valid());
        assert!(!is_valid_event_name("legacy"));
        assert!(!is_valid_event_name("Request.Started"));
    }
}
