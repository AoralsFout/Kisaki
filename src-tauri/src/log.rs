use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, TryLockError};

use chrono::{Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::app_paths::AppPaths;

/// 单个日志文件大小上限（超过则轮转）
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// 保留的轮转日志数量（.1 ~ .N，外加当前文件）
const MAX_LOG_ROTATIONS: u32 = 3;

fn log_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 保留清空本地数据后按需重建目录的行为；具体读写仍报告各自的既有错误。
fn prepare_log_dir(paths: &AppPaths) -> &Path {
    let dir = paths.logs_dir();
    let _ = fs::create_dir_all(dir);
    dir
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
pub(crate) fn prune_log_files(
    paths: tauri::State<'_, Arc<AppPaths>>,
    retention_days: u32,
) -> Result<u32, String> {
    prune_files(&paths, retention_days)
}

pub(crate) fn prune_files(paths: &AppPaths, retention_days: u32) -> Result<u32, String> {
    // “保留 N 天”包含今天，因此 14 天表示今天 + 之前 13 个自然日。
    let cutoff = retention_cutoff(Local::now().date_naive(), retention_days);
    let dir = prepare_log_dir(paths);
    if !dir.exists() {
        return Ok(0);
    }

    let _guard = log_write_lock()
        .lock()
        .map_err(|_| "日志写入锁已损坏".to_string())?;
    let mut removed = 0;
    for entry in fs::read_dir(dir).map_err(|e| format!("读取日志目录失败: {}", e))? {
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
    paths: tauri::State<'_, Arc<AppPaths>>,
    filename: String,
    entries: Vec<LogEntryPayload>,
) -> Result<(), String> {
    append_entries(&paths, &filename, &entries)
}

pub(crate) fn append_entries(
    paths: &AppPaths,
    filename: &str,
    entries: &[LogEntryPayload],
) -> Result<(), String> {
    // 验证文件名安全（只允许字母、数字、连字符、点）
    if !is_safe_filename(filename) || !is_log_filename(filename) {
        return Err("无效的文件名".to_string());
    }
    if entries.iter().any(|entry| !entry.is_valid()) {
        return Err("日志条目不符合 v2 schema".to_string());
    }

    let _guard = log_write_lock()
        .lock()
        .map_err(|_| "日志写入锁已损坏".to_string())?;
    let path = prepare_log_dir(paths).join(filename);
    // 超过大小上限先轮转，避免单文件无限增长
    rotate_log_if_needed(&path);
    // 追加模式写入
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;

    let mut output = String::new();
    for entry in entries {
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

fn write_native_log_file(
    paths: &AppPaths,
    level: &str,
    namespace: &str,
    message: String,
    event: &str,
) -> Result<(), String> {
    let dir = prepare_log_dir(paths);
    let now = Local::now();
    let path = dir.join(format!("app-v2-{}.jsonl", now.format("%Y-%m-%d")));
    rotate_log_if_needed(&path);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;
    let line = serde_json::json!({
        "schemaVersion": 2,
        "timestamp": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "namespace": namespace,
        "message": message,
        "source": "Rust",
        "event": event
    });
    writeln!(file, "{}", line).map_err(|e| format!("写入日志失败: {}", e))
}

/// 写入 Rust 原生侧日志，与 WebView 日志共用 JSONL、轮转和写入锁。
/// 返回持久化错误；原生调用方仍按既有的尽力而为策略处理，不覆盖业务结果。
pub(crate) fn write_native_log(
    paths: &AppPaths,
    level: &str,
    namespace: &str,
    message: String,
) -> Result<(), String> {
    let _guard = log_write_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_native_log_file(paths, level, namespace, message, "native.runtime_log")
}

fn try_write_panic_log(paths: &AppPaths, message: String) {
    // panic 可能发生在持有日志锁时；try_lock 可避免 panic hook 自锁死。
    let _guard = match log_write_lock().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    let _ = write_native_log_file(paths, "error", "RustPanic", message, "native.panic");
}

/// 把未捕获 Rust panic 记入当日日志，同时保留默认 panic 输出。
pub(crate) fn install_panic_hook(paths: Arc<AppPaths>) {
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
        try_write_panic_log(&paths, format!("{} ({})", payload, location));
        previous(info);
    }));
}

/// 读取日志文件内容
#[tauri::command]
pub(crate) fn read_log_file(
    paths: tauri::State<'_, Arc<AppPaths>>,
    filename: String,
) -> Result<Vec<LogEntry>, String> {
    read_file(&paths, &filename)
}

pub(crate) fn read_file(paths: &AppPaths, filename: &str) -> Result<Vec<LogEntry>, String> {
    if !is_safe_filename(filename) || !is_log_filename(filename) {
        return Err("无效的日志文件名".to_string());
    }

    let path = prepare_log_dir(paths).join(filename);
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
    paths: tauri::State<'_, Arc<AppPaths>>,
    filename: String,
    before: Option<u64>,
    limit: Option<usize>,
) -> Result<LogPage, String> {
    read_file_page(&paths, &filename, before, limit)
}

pub(crate) fn read_file_page(
    paths: &AppPaths,
    filename: &str,
    before: Option<u64>,
    limit: Option<usize>,
) -> Result<LogPage, String> {
    if !is_safe_filename(filename) || !is_log_filename(filename) {
        return Err("无效的日志文件名".to_string());
    }

    let path = prepare_log_dir(paths).join(filename);
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
pub(crate) fn export_log_file(
    paths: tauri::State<'_, Arc<AppPaths>>,
    source_filename: String,
    dest_path: String,
) -> Result<(), String> {
    export_file(&paths, &source_filename, &dest_path)
}

pub(crate) fn export_file(
    paths: &AppPaths,
    source_filename: &str,
    dest_path: &str,
) -> Result<(), String> {
    if !is_safe_filename(source_filename) {
        return Err("无效的文件名".to_string());
    }

    let src = prepare_log_dir(paths).join(source_filename);
    if !src.exists() {
        return Err("日志文件不存在".to_string());
    }

    // 防御性校验：拒绝含 path traversal 的目标路径（正常由前端 dialog 传入，不应出现）
    let dest = std::path::PathBuf::from(dest_path);
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
pub(crate) fn list_log_files(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<Vec<String>, String> {
    list_files(&paths)
}

pub(crate) fn list_files(paths: &AppPaths) -> Result<Vec<String>, String> {
    let dir = prepare_log_dir(paths);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files: Vec<String> = fs::read_dir(dir)
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
    use crate::test_support::TempAppPaths;

    fn payload_value(message: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 2,
            "timestamp": "2026-09-12T01:02:03.000Z",
            "level": "info",
            "namespace": "Test",
            "message": message,
            "source": "主窗口",
            "event": "test.entry"
        })
    }

    fn payload(message: &str) -> LogEntryPayload {
        serde_json::from_value(payload_value(message)).unwrap()
    }

    fn today_filename() -> String {
        format!("app-v2-{}.jsonl", Local::now().format("%Y-%m-%d"))
    }

    #[test]
    fn native_logs_are_written_without_global_path_initialization() {
        let fixture = TempAppPaths::new();
        let other = TempAppPaths::new();
        write_native_log(fixture.paths(), "info", "Test", "独立日志目录".to_string()).unwrap();
        let files = list_files(fixture.paths()).unwrap();
        assert_eq!(files.len(), 1);
        let entries = read_file(fixture.paths(), &files[0]).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "独立日志目录");
        assert_eq!(entries[0].source, "Rust");
        assert_eq!(entries[0].event, "native.runtime_log");
        assert!(list_files(other.paths()).unwrap().is_empty());
    }

    #[test]
    fn command_logs_use_only_the_supplied_directory() {
        let first = TempAppPaths::new();
        let second = TempAppPaths::new();
        let filename = "app-v2-2026-09-12.jsonl";
        append_entries(first.paths(), filename, &[payload("第一份")]).unwrap();
        assert!(list_files(second.paths()).unwrap().is_empty());
        append_entries(second.paths(), filename, &[payload("第二份")]).unwrap();
        assert_eq!(list_files(first.paths()).unwrap(), [filename]);
        assert_eq!(list_files(second.paths()).unwrap(), [filename]);
        assert_eq!(
            read_file(first.paths(), filename).unwrap()[0].message,
            "第一份"
        );
        assert_eq!(
            read_file(second.paths(), filename).unwrap()[0].message,
            "第二份"
        );
    }

    #[test]
    fn command_and_native_entries_preserve_their_v2_fields_in_one_file() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = today_filename();
        let mut value = payload_value("请求失败\n保留换行");
        value["level"] = serde_json::json!("error");
        value["event"] = serde_json::json!("ai.request_failed");
        value["error"] =
            serde_json::json!({ "name": "Error", "message": "timeout", "stack": "stack" });
        value["context"] = serde_json::json!({ "requestId": "req-1" });
        append_entries(
            paths,
            &filename,
            &[serde_json::from_value(value.clone()).unwrap()],
        )
        .unwrap();
        write_native_log(paths, "warn", "TTS", "原生记录".to_string()).unwrap();

        let content = fs::read_to_string(paths.logs_dir().join(&filename)).unwrap();
        assert!(content.ends_with('\n'));
        let lines: Vec<serde_json::Value> = content
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2, "消息中的换行不能拆开 JSONL 记录");
        assert_eq!(lines[0], value);
        assert_eq!(lines[1].as_object().unwrap().len(), 7);
        assert_eq!(lines[1]["schemaVersion"], 2);
        assert_eq!(lines[1]["level"], "warn");
        assert_eq!(lines[1]["namespace"], "TTS");
        assert_eq!(lines[1]["message"], "原生记录");
        assert_eq!(lines[1]["source"], "Rust");
        assert_eq!(lines[1]["event"], "native.runtime_log");
        chrono::DateTime::parse_from_rfc3339(lines[1]["timestamp"].as_str().unwrap()).unwrap();

        let entries = read_file(paths, &filename).unwrap();
        assert_eq!(entries[0].line, 1);
        assert_eq!(entries[0].error.as_ref().unwrap()["message"], "timeout");
        assert_eq!(entries[0].context.as_ref().unwrap()["requestId"], "req-1");
        assert_eq!(entries[1].line, 2);
        assert!(entries[1].error.is_none());
        assert!(entries[1].context.is_none());
        let page = read_file_page(paths, &filename, None, None).unwrap();
        assert_eq!(
            serde_json::to_value(&page.entries).unwrap(),
            serde_json::to_value(entries).unwrap()
        );
        let serialized_page = serde_json::to_value(page).unwrap();
        assert_eq!(serialized_page.as_object().unwrap().len(), 3);
        assert_eq!(serialized_page["next_before"], serde_json::Value::Null);
        assert_eq!(serialized_page["has_more"], false);
    }

    #[test]
    fn lists_only_application_logs_sorted_by_date_and_rotation() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        for filename in [
            "app-v2-2026-09-11.jsonl",
            "app-v2-2026-09-12.jsonl.10",
            "app-v2-2026-09-12.jsonl.2",
            "app-v2-2026-09-12.jsonl",
            "app-v2-2026-09-12.jsonl.1",
            "sessions-v2.json",
            "app-2026-09-12.jsonl",
            "__export_temp.jsonl",
            "app-v2-2026-9-12.jsonl",
            "app-v2-2026-09-12.jsonl.backup",
        ] {
            fs::write(paths.logs_dir().join(filename), "保留原内容").unwrap();
        }
        fs::create_dir(paths.logs_dir().join("app-v2-2026-09-13.jsonl")).unwrap();
        assert_eq!(
            list_files(paths).unwrap(),
            [
                "app-v2-2026-09-12.jsonl",
                "app-v2-2026-09-12.jsonl.1",
                "app-v2-2026-09-12.jsonl.2",
                "app-v2-2026-09-12.jsonl.10",
                "app-v2-2026-09-11.jsonl",
            ]
        );
    }

    #[test]
    fn reads_history_from_the_end_in_stable_pages() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        let entries: Vec<_> = (0..450).map(|i| payload(&format!("entry-{i}"))).collect();
        append_entries(paths, filename, &entries).unwrap();

        let newest = read_file_page(paths, filename, None, None).unwrap();
        assert_eq!(newest.entries.len(), 200);
        assert_eq!(newest.entries.first().unwrap().message, "entry-250");
        assert_eq!(newest.entries.last().unwrap().message, "entry-449");
        assert!(newest.has_more);
        let middle = read_file_page(paths, filename, newest.next_before, Some(200)).unwrap();
        assert_eq!(middle.entries.first().unwrap().message, "entry-50");
        assert_eq!(middle.entries.last().unwrap().message, "entry-249");
        assert!(middle.has_more);
        assert!(middle.next_before < newest.next_before);
        let oldest = read_file_page(paths, filename, middle.next_before, Some(200)).unwrap();
        assert_eq!(oldest.entries.len(), 50);
        assert_eq!(oldest.entries.first().unwrap().message, "entry-0");
        assert_eq!(oldest.entries.last().unwrap().message, "entry-49");
        assert!(!oldest.has_more);
        assert_eq!(oldest.next_before, None);
        assert_eq!(read_file(paths, filename).unwrap().len(), 450);
    }

    #[test]
    fn pagination_keeps_long_utf8_records_and_clamps_limits_and_cursors() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        let long_message = "跨块中文".repeat(3000);
        append_entries(
            paths,
            filename,
            &[payload("首条"), payload(&long_message), payload("末条")],
        )
        .unwrap();
        let newest = read_file_page(paths, filename, Some(u64::MAX), Some(0)).unwrap();
        assert_eq!(newest.entries.len(), 1);
        assert_eq!(newest.entries[0].message, "末条");
        let middle = read_file_page(paths, filename, newest.next_before, Some(1)).unwrap();
        assert_eq!(middle.entries[0].message, long_message);
        let oldest = read_file_page(paths, filename, middle.next_before, Some(1)).unwrap();
        assert_eq!(oldest.entries[0].message, "首条");
        assert!(!oldest.has_more);
        let empty = read_file_page(paths, filename, Some(0), None).unwrap();
        assert!(empty.entries.is_empty());
        assert!(!empty.has_more);
        assert_eq!(empty.next_before, None);

        let many_filename = "app-v2-2026-09-11.jsonl";
        let many: Vec<_> = (0..550).map(|i| payload(&format!("entry-{i}"))).collect();
        append_entries(paths, many_filename, &many).unwrap();
        let page = read_file_page(paths, many_filename, None, Some(usize::MAX)).unwrap();
        assert_eq!(page.entries.len(), 500);
        assert_eq!(page.entries[0].message, "entry-50");
        assert_eq!(page.entries[499].message, "entry-549");
    }

    #[test]
    fn empty_or_missing_logs_return_empty_results_without_global_state() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        assert!(list_files(paths).unwrap().is_empty());
        assert!(read_file(paths, filename).unwrap().is_empty());
        let page = read_file_page(paths, filename, None, None).unwrap();
        assert!(page.entries.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.next_before, None);
        assert_eq!(prune_files(paths, 14).unwrap(), 0);
        append_entries(paths, filename, &[]).unwrap();
        assert_eq!(
            fs::metadata(paths.logs_dir().join(filename)).unwrap().len(),
            0
        );
        assert!(read_file(paths, filename).unwrap().is_empty());
        assert!(read_file_page(paths, filename, None, None)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn malformed_records_become_parse_failure_entries_without_losing_line_numbers() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        let mut unknown = payload_value("多余字段");
        unknown["extra"] = serde_json::json!(true);
        fs::write(
            paths.logs_dir().join(filename),
            format!(
                "\n{}\r\n不是 JSON\n{{\"schemaVersion\":1}}\n{}\n\n",
                payload_value("正常记录"),
                unknown,
            ),
        )
        .unwrap();
        let entries = read_file(paths, filename).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].line, 2);
        assert_eq!(entries[0].message, "正常记录");
        assert_eq!(entries[1].line, 3);
        assert_eq!(entries[1].message, "[日志解析失败] 不是 JSON");
        assert_eq!(entries[3].line, 5);
        for entry in &entries[1..] {
            assert_eq!(entry.schema_version, 2);
            assert_eq!(entry.level, "warn");
            assert_eq!(entry.namespace, "System");
            assert_eq!(entry.event, "logger.parse_failed");
            assert!(entry.source.is_empty());
            assert!(entry.error.is_none());
            assert!(entry.context.is_none());
        }
        let page = read_file_page(paths, filename, None, Some(10)).unwrap();
        assert_eq!(page.entries.len(), 4);
        assert_eq!(page.entries[1].event, "logger.parse_failed");
        assert_eq!(page.entries[3].line, 4, "分页继续使用页内行号");
    }

    #[test]
    fn rejects_non_v2_or_unknown_log_fields_before_appending_any_part_of_a_batch() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        let mut missing = payload_value("旧格式");
        missing.as_object_mut().unwrap().remove("schemaVersion");
        assert!(serde_json::from_value::<LogEntryPayload>(missing).is_err());
        let mut unknown = payload_value("未知字段");
        unknown["args"] = serde_json::json!([]);
        assert!(serde_json::from_value::<LogEntryPayload>(unknown).is_err());
        append_entries(paths, filename, &[payload("已提交")]).unwrap();
        let original = fs::read(paths.logs_dir().join(filename)).unwrap();
        for (field, invalid) in [
            ("schemaVersion", serde_json::json!(1)),
            ("level", serde_json::json!("notice")),
            ("timestamp", serde_json::json!(" ")),
            ("namespace", serde_json::json!(" ")),
            ("message", serde_json::json!("\t")),
            ("source", serde_json::json!("")),
            ("event", serde_json::json!("legacy")),
            ("event", serde_json::json!("Request.Started")),
            ("event", serde_json::json!("test..entry")),
        ] {
            let mut value = payload_value("不能写入");
            value[field] = invalid;
            let invalid = serde_json::from_value(value).unwrap();
            assert_eq!(
                append_entries(paths, filename, &[payload("也不能写入"), invalid]).unwrap_err(),
                "日志条目不符合 v2 schema"
            );
            assert_eq!(fs::read(paths.logs_dir().join(filename)).unwrap(), original);
        }
    }

    #[test]
    fn rejects_unsafe_or_non_log_names_at_the_read_and_append_boundary() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        for filename in [
            "../outside.jsonl",
            r"..\outside.jsonl",
            "/tmp/log.jsonl",
            "",
            "sessions-v2.json",
            "app-2026-09-12.jsonl",
            "app-v2-2026-09-12.jsonl.backup",
        ] {
            assert_eq!(
                append_entries(paths, filename, &[payload("不能写入")]).unwrap_err(),
                "无效的文件名"
            );
            assert_eq!(
                read_file(paths, filename).err().unwrap(),
                "无效的日志文件名"
            );
            assert_eq!(
                read_file_page(paths, filename, None, None).err().unwrap(),
                "无效的日志文件名"
            );
        }
        assert_eq!(
            export_file(paths, "../outside.jsonl", "unused").unwrap_err(),
            "无效的文件名"
        );
        assert!(fs::read_dir(paths.logs_dir()).unwrap().next().is_none());
    }

    #[test]
    fn export_copies_exact_bytes_from_the_supplied_directory_and_reports_failures() {
        let fixture = TempAppPaths::new();
        let other = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = "app-v2-2026-09-12.jsonl";
        append_entries(paths, filename, &[payload("导出内容"), payload("第二条")]).unwrap();
        append_entries(other.paths(), filename, &[payload("不能混入")]).unwrap();
        let destination = fixture.root().join("export/nested/log.jsonl");
        export_file(paths, filename, &destination.to_string_lossy()).unwrap();
        assert_eq!(
            fs::read(&destination).unwrap(),
            fs::read(paths.logs_dir().join(filename)).unwrap()
        );
        assert_eq!(
            export_file(paths, "missing.jsonl", &destination.to_string_lossy()).unwrap_err(),
            "日志文件不存在"
        );
        // Windows verbatim 路径的 join 会消去 ..；保留未经规范化的输入，且目标仍在 fixture 内。
        let unsafe_destination = format!("{}/export/../escaped.jsonl", fixture.root().display());
        assert!(unsafe_destination.contains(".."), "遍历用例必须保留原始 ..");
        assert_eq!(
            export_file(paths, filename, &unsafe_destination).unwrap_err(),
            "无效的导出路径"
        );
        assert!(!fixture.root().join("escaped.jsonl").exists());
        let blocked_parent = fixture.root().join("blocked");
        fs::write(&blocked_parent, "不能覆盖").unwrap();
        assert!(export_file(
            paths,
            filename,
            &blocked_parent.join("log.jsonl").to_string_lossy()
        )
        .unwrap_err()
        .starts_with("创建目标目录失败: "));
        assert!(
            export_file(paths, filename, &fixture.root().to_string_lossy())
                .unwrap_err()
                .starts_with("导出日志文件失败: ")
        );
        assert_eq!(fs::read_to_string(blocked_parent).unwrap(), "不能覆盖");
        // 既有导出只校验安全文件名，不额外收紧为日志列表的筛选规则。
        fs::write(paths.logs_dir().join("other.txt"), "既有导出语义").unwrap();
        export_file(paths, "other.txt", &destination.to_string_lossy()).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "既有导出语义");
    }

    #[test]
    fn log_writers_recreate_removed_directories_and_report_unusable_storage() {
        for native in [false, true] {
            let fixture = TempAppPaths::new();
            let paths = fixture.paths();
            fs::remove_dir(paths.logs_dir()).unwrap();
            if native {
                write_native_log(paths, "info", "Test", "重建目录".to_string()).unwrap();
            } else {
                append_entries(paths, &today_filename(), &[payload("重建目录")]).unwrap();
            }
            let files = list_files(paths).unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(read_file(paths, &files[0]).unwrap()[0].message, "重建目录");
        }
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::remove_dir(paths.logs_dir()).unwrap();
        fs::write(paths.logs_dir(), "不是目录").unwrap();
        assert!(
            append_entries(paths, &today_filename(), &[payload("不能写入")])
                .unwrap_err()
                .starts_with("打开日志文件失败: ")
        );
        assert!(
            write_native_log(paths, "error", "Test", "不能写入".to_string())
                .unwrap_err()
                .starts_with("打开日志文件失败: ")
        );
        assert!(list_files(paths)
            .unwrap_err()
            .starts_with("读取日志目录失败: "));
        assert!(prune_files(paths, 14)
            .unwrap_err()
            .starts_with("读取日志目录失败: "));
        assert_eq!(fs::read_to_string(paths.logs_dir()).unwrap(), "不是目录");
    }

    #[test]
    fn read_append_and_export_report_unusable_log_files() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = today_filename();
        fs::create_dir(paths.logs_dir().join(&filename)).unwrap();
        assert!(append_entries(paths, &filename, &[payload("不能写入")])
            .unwrap_err()
            .starts_with("打开日志文件失败: "));
        assert!(
            write_native_log(paths, "error", "Test", "不能写入".to_string())
                .unwrap_err()
                .starts_with("打开日志文件失败: ")
        );
        assert!(read_file(paths, &filename)
            .err()
            .unwrap()
            .starts_with("读取日志文件失败: "));
        assert!(read_file_page(paths, &filename, None, None)
            .err()
            .unwrap()
            .starts_with("读取日志文件失败: "));
        assert!(export_file(
            paths,
            &filename,
            &fixture.root().join("export.jsonl").to_string_lossy()
        )
        .unwrap_err()
        .starts_with("导出日志文件失败: "));
        assert!(list_files(paths).unwrap().is_empty());
    }
    /// 用合法 JSONL 精确铺到轮转边界，避免用稀疏文件跳过真实内容校验。
    fn sized_log_line(message: &str, bytes: usize) -> String {
        let mut value = payload_value(message);
        let padding = bytes - value.to_string().len() - 1;
        value["message"] = serde_json::json!(format!("{message}{}", "x".repeat(padding)));
        let line = format!("{value}\n");
        assert_eq!(line.len(), bytes);
        line
    }

    #[test]
    fn native_and_webview_writers_keep_complete_records_during_concurrent_rotation() {
        use std::collections::BTreeSet;
        use std::sync::Barrier;

        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let filename = today_filename();
        let seed = sized_log_line("轮转前的记录", 5 * 1024 * 1024 + 1);
        fs::write(paths.logs_dir().join(&filename), &seed).unwrap();
        let barrier = Barrier::new(8);
        let detail = "跨线程中文与换行\n".repeat(64);
        std::thread::scope(|scope| {
            for worker in 0..8 {
                let barrier = &barrier;
                let filename = &filename;
                let detail = &detail;
                scope.spawn(move || {
                    barrier.wait();
                    for index in 0..40 {
                        let message = format!("{worker}:{index}:{detail}");
                        if worker % 2 == 0 {
                            write_native_log(paths, "info", "Test", message).unwrap();
                        } else {
                            let mut entry = payload(&message);
                            entry.source = format!("窗口-{worker}");
                            append_entries(paths, filename, &[entry]).unwrap();
                        }
                    }
                });
            }
        });

        assert_eq!(
            list_files(paths).unwrap(),
            [filename.clone(), format!("{filename}.1")]
        );
        assert_eq!(
            fs::read_to_string(paths.logs_dir().join(format!("{filename}.1"))).unwrap(),
            seed
        );
        let entries = read_file(paths, &filename).unwrap();
        assert_eq!(entries.len(), 8 * 40, "并发写入不能丢失或拆开记录");
        let mut expected = BTreeSet::new();
        for worker in 0..8 {
            for index in 0..40 {
                expected.insert(format!("{worker}:{index}:{detail}"));
            }
        }
        let actual: BTreeSet<_> = entries.iter().map(|entry| entry.message.clone()).collect();
        assert_eq!(actual, expected, "每条记录都应完整保留且恰好写入一次");
        for entry in entries {
            assert_eq!(entry.schema_version, 2);
            assert_eq!(entry.namespace, "Test");
            assert_eq!(entry.level, "info");
            if entry.source == "Rust" {
                assert_eq!(entry.event, "native.runtime_log");
            } else {
                assert!(entry.source.starts_with("窗口-"));
                assert_eq!(entry.event, "test.entry");
            }
        }
    }

    #[test]
    fn both_writers_rotate_only_above_five_mebibytes_and_keep_three_backups() {
        for native_first in [false, true] {
            let fixture = TempAppPaths::new();
            let paths = fixture.paths();
            let filename = today_filename();
            let current = paths.logs_dir().join(&filename);
            fs::write(&current, sized_log_line("恰好到达边界", 5 * 1024 * 1024)).unwrap();
            for rotation in 1..=3 {
                fs::write(
                    paths.logs_dir().join(format!("{filename}.{rotation}")),
                    format!("旧轮转-{rotation}"),
                )
                .unwrap();
            }
            if native_first {
                write_native_log(paths, "info", "Test", "边界不轮转".to_string()).unwrap();
            } else {
                append_entries(paths, &filename, &[payload("边界不轮转")]).unwrap();
            }
            for rotation in 1..=3 {
                assert_eq!(
                    fs::read_to_string(paths.logs_dir().join(format!("{filename}.{rotation}")))
                        .unwrap(),
                    format!("旧轮转-{rotation}")
                );
            }
            let before_rotation = fs::read(&current).unwrap();
            assert!(before_rotation.len() > 5 * 1024 * 1024);
            assert_eq!(
                read_file(paths, &filename).unwrap()[1].message,
                "边界不轮转"
            );

            if native_first {
                append_entries(paths, &filename, &[payload("超过边界后轮转")]).unwrap();
            } else {
                write_native_log(paths, "info", "Test", "超过边界后轮转".to_string()).unwrap();
            }
            assert_eq!(
                fs::read(paths.logs_dir().join(format!("{filename}.1"))).unwrap(),
                before_rotation
            );
            assert_eq!(
                fs::read_to_string(paths.logs_dir().join(format!("{filename}.2"))).unwrap(),
                "旧轮转-1"
            );
            assert_eq!(
                fs::read_to_string(paths.logs_dir().join(format!("{filename}.3"))).unwrap(),
                "旧轮转-2"
            );
            assert!(!paths.logs_dir().join(format!("{filename}.4")).exists());
            assert_eq!(list_files(paths).unwrap().len(), 4);
            let entries = read_file(paths, &filename).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].message, "超过边界后轮转");
        }
    }

    #[test]
    fn pruning_includes_today_clamps_retention_and_preserves_other_files_and_directories() {
        use std::collections::BTreeSet;

        for (requested_days, kept_days) in [(0, 1), (1, 1), (14, 14), (365, 365), (u32::MAX, 365)] {
            let fixture = TempAppPaths::new();
            let other = TempAppPaths::new();
            let paths = fixture.paths();
            let today = Local::now().date_naive();
            let expired = today - Duration::days(kept_days);
            let cutoff = today - Duration::days(kept_days - 1);
            let expired_names = [
                format!("app-v2-{expired}.jsonl"),
                format!("app-v2-{expired}.jsonl.1"),
                format!("app-v2-{expired}.jsonl.10"),
            ];
            for name in &expired_names {
                fs::write(paths.logs_dir().join(name), "过期内容").unwrap();
            }
            fs::write(
                other.paths().logs_dir().join(&expired_names[0]),
                "其他装配的日志",
            )
            .unwrap();
            let kept_names: BTreeSet<_> = [
                format!("app-v2-{cutoff}.jsonl"),
                format!("app-v2-{cutoff}.jsonl.3"),
                format!("app-v2-{today}.jsonl"),
                format!("app-v2-{}.jsonl", today + Duration::days(1)),
                format!("app-v2-{expired}.jsonl.backup"),
                "app-v2-2026-02-30.jsonl".to_string(),
                "sessions-v2.json".to_string(),
                "app-2000-01-01.jsonl".to_string(),
                "__export_temp.jsonl".to_string(),
            ]
            .into_iter()
            .collect();
            for name in &kept_names {
                fs::write(paths.logs_dir().join(name), "保留内容").unwrap();
            }
            let directory_name = format!("app-v2-{expired}.jsonl.2");
            fs::create_dir(paths.logs_dir().join(&directory_name)).unwrap();

            assert_eq!(prune_files(paths, requested_days).unwrap(), 3);
            assert_eq!(
                prune_files(paths, requested_days).unwrap(),
                0,
                "重复清理应幂等"
            );
            for name in expired_names {
                assert!(!paths.logs_dir().join(name).exists());
            }
            for name in &kept_names {
                assert_eq!(
                    fs::read_to_string(paths.logs_dir().join(name)).unwrap(),
                    "保留内容"
                );
            }
            assert!(paths.logs_dir().join(&directory_name).is_dir());
            let mut expected = kept_names;
            expected.insert(directory_name);
            let remaining: BTreeSet<_> = fs::read_dir(paths.logs_dir())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            assert_eq!(remaining, expected);
            assert_eq!(
                fs::read_to_string(
                    other
                        .paths()
                        .logs_dir()
                        .join(format!("app-v2-{expired}.jsonl"))
                )
                .unwrap(),
                "其他装配的日志"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn pruning_reports_locked_file_deletion_failure_and_keeps_the_file_for_retry() {
        use std::os::windows::fs::OpenOptionsExt;

        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let old = paths.logs_dir().join("app-v2-2000-01-01.jsonl");
        fs::write(&old, "不能误报为已清理").unwrap();
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&old)
            .unwrap();
        assert!(prune_files(paths, 14)
            .unwrap_err()
            .starts_with("删除过期日志失败: "));
        drop(guard);
        assert_eq!(fs::read_to_string(&old).unwrap(), "不能误报为已清理");
        assert_eq!(prune_files(paths, 14).unwrap(), 1);
        assert!(!old.exists());
    }

    fn assert_panic_entries(paths: &AppPaths, expected_payloads: &[&str]) {
        let files = list_files(paths).unwrap();
        assert_eq!(files.len(), 1);
        let entries = read_file(paths, &files[0]).unwrap();
        assert_eq!(entries.len(), expected_payloads.len());
        for (entry, payload) in entries.iter().zip(expected_payloads) {
            assert_eq!(entry.schema_version, 2);
            assert_eq!(entry.level, "error");
            assert_eq!(entry.namespace, "RustPanic");
            assert_eq!(entry.source, "Rust");
            assert_eq!(entry.event, "native.panic");
            assert!(entry.message.starts_with(&format!("{payload} (")));
            assert!(entry.message.contains("log.rs:"));
            assert!(entry.message.ends_with(')'));
            assert!(entry.error.is_none());
            assert!(entry.context.is_none());
            chrono::DateTime::parse_from_rfc3339(&entry.timestamp).unwrap();
        }
    }

    #[test]
    fn panic_hook_preserves_default_output_with_busy_poisoned_or_unwritable_logs() {
        const MODE: &str = "KISAKI_TICKET_33_PANIC_TEST_MODE";
        const MESSAGE: &str = "ticket-33 panic 日志验收";
        let Ok(mode) = std::env::var(MODE) else {
            // hook 和写锁中毒属于进程级状态；子进程隔离，不能污染并行执行的其他测试。
            for mode in ["normal", "busy", "poisoned", "unwritable"] {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "log::tests::panic_hook_preserves_default_output_with_busy_poisoned_or_unwritable_logs", "--nocapture", "--test-threads=1"])
                    .env(MODE, mode)
                    .env("RUST_BACKTRACE", "0")
                    .current_dir(std::env::current_dir().unwrap())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn().unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                let timed_out = loop {
                    if child.try_wait().unwrap().is_some() {
                        break false;
                    }
                    if std::time::Instant::now() >= deadline {
                        child.kill().unwrap();
                        break true;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                };
                let output = child.wait_with_output().unwrap();
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                assert!(
                    !timed_out,
                    "panic hook 在 {mode} 场景未退出，可能自锁死\n{stdout}\n{stderr}"
                );
                assert!(
                    output.status.success(),
                    "panic 子进程失败：{mode}\n{stdout}\n{stderr}"
                );
                assert!(
                    stdout.contains("1 passed;"),
                    "必须实际执行子进程测试：{stdout}"
                );
                assert!(
                    stderr.contains("panicked at"),
                    "默认 panic 输出不能丢失：{stderr}"
                );
                assert!(
                    stderr.contains(MESSAGE),
                    "默认输出应保留原始 panic：{stderr}"
                );
            }
            return;
        };

        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        // 清除子进程测试框架的 hook，让生产安装路径实际串接标准库默认输出。
        drop(std::panic::take_hook());
        install_panic_hook(fixture.shared_paths());
        match mode.as_str() {
            "normal" => {
                assert!(std::panic::catch_unwind(|| std::panic::panic_any(MESSAGE)).is_err());
                assert!(
                    std::panic::catch_unwind(|| std::panic::panic_any(MESSAGE.to_string()))
                        .is_err()
                );
                assert!(std::panic::catch_unwind(|| std::panic::panic_any(33_u8)).is_err());
                assert_panic_entries(paths, &[MESSAGE, MESSAGE, "未知 panic"]);
            }
            "busy" => {
                let guard = log_write_lock().lock().unwrap();
                assert!(std::panic::catch_unwind(|| std::panic::panic_any(MESSAGE)).is_err());
                drop(guard);
                assert!(
                    list_files(paths).unwrap().is_empty(),
                    "忙锁时只保留默认输出，不等待自己释放锁"
                );
            }
            "poisoned" => {
                assert!(std::panic::catch_unwind(|| {
                    let _guard = log_write_lock().lock().unwrap();
                    std::panic::panic_any(MESSAGE);
                })
                .is_err());
                assert!(list_files(paths).unwrap().is_empty());
                assert!(std::panic::catch_unwind(|| std::panic::panic_any(MESSAGE)).is_err());
                assert_panic_entries(paths, &[MESSAGE]);
                write_native_log(paths, "warn", "Test", "锁中毒后仍尽力写入".to_string()).unwrap();
                let files = list_files(paths).unwrap();
                assert_eq!(
                    read_file(paths, &files[0]).unwrap()[1].message,
                    "锁中毒后仍尽力写入"
                );
                assert_eq!(
                    append_entries(paths, &today_filename(), &[payload("不能误报成功")])
                        .unwrap_err(),
                    "日志写入锁已损坏"
                );
                assert_eq!(prune_files(paths, 14).unwrap_err(), "日志写入锁已损坏");
            }
            "unwritable" => {
                fs::remove_dir(paths.logs_dir()).unwrap();
                fs::write(paths.logs_dir(), "日志目录不可写").unwrap();
                assert!(std::panic::catch_unwind(|| std::panic::panic_any(MESSAGE)).is_err());
                assert_eq!(
                    fs::read_to_string(paths.logs_dir()).unwrap(),
                    "日志目录不可写"
                );
            }
            _ => panic!("未知 panic 测试场景：{mode}"),
        }
    }
}
