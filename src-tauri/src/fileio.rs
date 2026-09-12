//! AI 工作目录文件读写命令
//!
//! 供前端 agent 工具调用，让 AI 在「用户授权的工作目录」内读写文件。
//! 能力模型：
//!   - Rust 原生目录选择器为用户选中的目录签发随机 workspace_id。
//!   - 本模块只接受 workspace_id 与相对路径，WebView 不能登记任意绝对路径。
//!   - 所有相对路径经 `safe_join_rel` 校验，防 path traversal / 符号链接逃逸。

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::path::safe_join_rel;
use crate::workspace_grants::WorkspaceGrants;
use base64::Engine;
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

/// 单次读取上限：2 MiB。防止把超大文件灌进 LLM 上下文。
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// 单张模型输入图片上限：与前端附件限制保持一致。
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// 按行区间读取：返回行数与字节上限（保护上下文）。
const MAX_RANGE_LINES: u64 = 800;
const MAX_RANGE_BYTES: usize = 200 * 1024;
/// 查找/搜索：结果与扫描规模上限。
const MAX_FIND_RESULTS: usize = 200;
const MAX_SEARCH_MATCHES: usize = 100;
const MAX_ENTRIES_SCANNED: usize = 20000;
/// 搜索命中行文本的最大保留长度。
const SEARCH_LINE_MAX: usize = 200;

/// 由后端直接打开原生目录选择器并签发能力。路径从不作为授权输入来自 WebView。
#[tauri::command]
pub(crate) async fn agent_pick_workspace(
    app: tauri::AppHandle,
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    title: Option<String>,
) -> Result<Option<crate::path::WorkspaceGrant>, String> {
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    let Some(selected) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("无法解析所选工作目录: {}", e))?;
    grants.grant_from_selection(&path).map(Some)
}

/// 验证持久化能力仍有效，并返回其当前规范化路径。
#[tauri::command]
pub(crate) fn agent_resolve_workspace(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
) -> Result<String, String> {
    grants
        .resolve(&workspace_id)
        .map(|p| p.to_string_lossy().into_owned())
}

/// 用户取消工作区时同步撤销后端能力。
#[tauri::command]
pub(crate) fn agent_revoke_workspace(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
) -> Result<(), String> {
    revoke_workspace(&grants, &workspace_id)
}

pub(crate) fn revoke_workspace(grants: &WorkspaceGrants, workspace_id: &str) -> Result<(), String> {
    // 保留既有执行任务联动；执行注册表由后续工单迁移，不在此引入另一份执行状态。
    crate::command::revoke_workspace_tasks(workspace_id);
    grants.revoke(workspace_id)
}

/// 读取工作目录内某文本文件的内容（UTF-8）。
#[tauri::command]
pub(crate) fn agent_read_file(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
) -> Result<String, String> {
    read_file(&grants, &workspace_id, &rel_path)
}

pub(crate) fn read_file(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
) -> Result<String, String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
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

#[derive(Serialize)]
pub(crate) struct ImageReadResult {
    data_url: String,
    mime_type: &'static str,
    size: u64,
    name: String,
}

/// 根据文件签名识别允许发送给多模态模型的图片格式，不信任扩展名。
fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 读取工作区图片并编码为兼容 OpenAI image_url 的 data URL。
#[tauri::command]
pub(crate) fn agent_read_image(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
) -> Result<ImageReadResult, String> {
    read_image(&grants, &workspace_id, &rel_path)
}

pub(crate) fn read_image(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
) -> Result<ImageReadResult, String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
    let meta = fs::metadata(&path).map_err(|e| format!("读取失败: {}", e))?;
    if !meta.is_file() {
        return Err("目标不是文件".to_string());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {} 字节）",
            meta.len(),
            MAX_IMAGE_BYTES
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
    let mime_type = detect_image_mime(&bytes)
        .ok_or_else(|| "不支持的图片格式，仅支持 PNG、JPEG、WebP 和 GIF".to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".to_string());
    Ok(ImageReadResult {
        data_url: format!("data:{};base64,{}", mime_type, encoded),
        mime_type,
        size: meta.len(),
        name,
    })
}

/// 写入/覆盖工作目录内的文件，自动创建所需的父目录。
#[tauri::command]
pub(crate) fn agent_write_file(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    write_file(&grants, &workspace_id, &rel_path, &content)
}

pub(crate) fn write_file(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
    content: &str,
) -> Result<(), String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))
}

/// 在文件末尾追加内容（文件不存在则创建）。
#[tauri::command]
pub(crate) fn agent_append_file(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    append_file(&grants, &workspace_id, &rel_path, &content)
}

pub(crate) fn append_file(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
    content: &str,
) -> Result<(), String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
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
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
) -> Result<serde_json::Value, String> {
    list_dir(&grants, &workspace_id, &rel_path)
}

pub(crate) fn list_dir(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
) -> Result<serde_json::Value, String> {
    let rel = if rel_path.is_empty() { "." } else { rel_path };
    let dir = safe_join_rel(&grants.resolve(workspace_id)?, rel)?;
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
pub(crate) fn agent_delete_file(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
) -> Result<(), String> {
    delete_file(&grants, &workspace_id, &rel_path)
}

pub(crate) fn delete_file(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
) -> Result<(), String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    if path.is_dir() {
        return Err("拒绝删除目录，仅允许删除文件".to_string());
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))
}

// ─── 按行读取 ──────────────────────────────────────────

/// 读取文件指定行区间（1-based 闭区间），返回带右对齐行号的文本。
/// start 缺省=1，end 缺省=文件末尾。逐行流式读取，不受整文件 2MB 限制约束。
/// 受 MAX_RANGE_LINES / MAX_RANGE_BYTES 限制，超出则截断并附提示。
#[tauri::command]
pub(crate) fn agent_read_lines(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
    start_line: Option<u64>,
    end_line: Option<u64>,
) -> Result<String, String> {
    read_lines(&grants, &workspace_id, &rel_path, start_line, end_line)
}

pub(crate) fn read_lines(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
    start_line: Option<u64>,
    end_line: Option<u64>,
) -> Result<String, String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
    if !path.is_file() {
        return Err("目标不是文件".to_string());
    }
    let start = start_line.unwrap_or(1).max(1);
    let end = end_line.unwrap_or(u64::MAX).max(start);

    let file = fs::File::open(&path).map_err(|e| format!("打开文件失败: {}", e))?;
    let reader = BufReader::new(file);

    // 行号宽度：用区间上界估算（end 为 MAX 时退化为 start，后续按实际行号对齐）
    let mut collected: Vec<(u64, String)> = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut lineno = 0u64;
    for line in reader.lines() {
        lineno += 1;
        if lineno < start {
            continue;
        }
        if lineno > end {
            break;
        }
        let text = line.map_err(|e| format!("读取失败（需为 UTF-8 文本）: {}", e))?;
        bytes += text.len() + 1;
        if collected.len() as u64 >= MAX_RANGE_LINES || bytes > MAX_RANGE_BYTES {
            truncated = true;
            break;
        }
        collected.push((lineno, text));
    }

    if collected.is_empty() {
        return Ok(format!("（第 {} 行起无内容；文件共 {} 行）", start, lineno));
    }

    let width = collected
        .last()
        .map(|(n, _)| n.to_string().len())
        .unwrap_or(1);
    let mut out = String::new();
    for (n, text) in &collected {
        out.push_str(&format!("{:>width$} | {}\n", n, text, width = width));
    }
    if truncated {
        out.push_str(&format!(
            "…（已截断：单次最多 {} 行 / {} KiB，请用更小的行区间）",
            MAX_RANGE_LINES,
            MAX_RANGE_BYTES / 1024
        ));
    }
    Ok(out)
}

// ─── 按行编辑 ──────────────────────────────────────────

/// 检测文本的换行风格与是否以换行结尾，并切分为不含换行符的行序列。
fn split_lines(content: &str) -> (Vec<String>, &'static str, bool) {
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let ends_with_nl = content.ends_with('\n');
    // 按 \n 切，去掉可能的 \r；若以换行结尾，去掉末尾产生的空串
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if ends_with_nl {
        lines.pop();
    }
    (lines, newline, ends_with_nl)
}

/// 把行序列按原换行风格/结尾换行重新组合。
fn join_lines(lines: &[String], newline: &str, ends_with_nl: bool) -> String {
    let mut s = lines.join(newline);
    if ends_with_nl && !lines.is_empty() {
        s.push_str(newline);
    }
    s
}

/// 按行编辑：replace / insert / delete。行号 1-based。
#[tauri::command]
pub(crate) fn agent_edit_lines(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    rel_path: String,
    operation: String,
    start_line: Option<u64>,
    end_line: Option<u64>,
    content: Option<String>,
) -> Result<String, String> {
    edit_lines(
        &grants,
        &workspace_id,
        &rel_path,
        &operation,
        start_line,
        end_line,
        content.as_deref(),
    )
}

pub(crate) fn edit_lines(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    rel_path: &str,
    operation: &str,
    start_line: Option<u64>,
    end_line: Option<u64>,
    content: Option<&str>,
) -> Result<String, String> {
    let path = safe_join_rel(&grants.resolve(workspace_id)?, rel_path)?;
    if !path.is_file() {
        return Err("文件不存在或不是文件（新建文件请用 write_file）".to_string());
    }
    let original = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let (mut lines, newline, ends_with_nl) = split_lines(&original);
    let n = lines.len() as u64;

    let summary = match operation {
        "replace" => {
            let s = start_line.ok_or("replace 需要 start_line")?;
            let e = end_line.ok_or("replace 需要 end_line")?;
            let body = content.ok_or("replace 需要 content")?;
            if s < 1 || e < s || e > n {
                return Err(format!(
                    "行区间越界：start={}, end={}, 文件共 {} 行",
                    s, e, n
                ));
            }
            let (new_lines, _, _) = split_lines(body);
            let si = (s - 1) as usize;
            let ei = e as usize; // 闭区间 → 独占上界
            lines.splice(si..ei, new_lines.iter().cloned());
            format!("已替换第 {}-{} 行（共 {} 行新内容）", s, e, new_lines.len())
        }
        "insert" => {
            let line = start_line.ok_or("insert 需要 line（用 start_line 传入）")?;
            let body = content.ok_or("insert 需要 content")?;
            if line < 1 || line > n + 1 {
                return Err(format!(
                    "插入位置越界：line={}, 文件共 {} 行（可取 1..={}）",
                    line,
                    n,
                    n + 1
                ));
            }
            let (new_lines, _, _) = split_lines(body);
            let at = (line - 1) as usize;
            let cnt = new_lines.len();
            lines.splice(at..at, new_lines);
            format!("已在第 {} 行前插入 {} 行", line, cnt)
        }
        "delete" => {
            let s = start_line.ok_or("delete 需要 start_line")?;
            let e = end_line.ok_or("delete 需要 end_line")?;
            if s < 1 || e < s || e > n {
                return Err(format!(
                    "行区间越界：start={}, end={}, 文件共 {} 行",
                    s, e, n
                ));
            }
            let si = (s - 1) as usize;
            let ei = e as usize;
            lines.drain(si..ei);
            format!("已删除第 {}-{} 行", s, e)
        }
        other => return Err(format!("未知操作: {}（应为 replace/insert/delete）", other)),
    };

    let out = join_lines(&lines, newline, ends_with_nl);
    fs::write(&path, out).map_err(|e| format!("写入失败: {}", e))?;
    Ok(summary)
}

// ─── 查找 / 搜索 ───────────────────────────────────────

/// 递归遍历 base 下的文件（跳过符号链接目录防逃逸，扫描数封顶）。
/// 对每个文件调用 visit(相对 base 的路径, 绝对路径)；visit 返回 false 即停止遍历。
fn walk_files<F: FnMut(&str, &Path) -> bool>(base: &Path, visit: &mut F) {
    let mut scanned = 0usize;
    let mut stack: Vec<PathBuf> = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if scanned >= MAX_ENTRIES_SCANNED {
                return;
            }
            scanned += 1;
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let p = entry.path();
            if ft.is_symlink() {
                continue; // 不跟随符号链接，防逃逸
            }
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                let rel = p.strip_prefix(base).unwrap_or(&p);
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if !visit(&rel_str, &p) {
                    return;
                }
            }
        }
    }
}

/// 简单通配符匹配：支持 `*`（任意串）与 `?`（单字符），大小写不敏感。
fn glob_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.to_lowercase().chars().collect();
    let txt: Vec<char> = name.to_lowercase().chars().collect();
    // 经典双指针 + 星号回溯
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < txt.len() {
        if pi < pat.len() && (pat[pi] == '?' || pat[pi] == txt[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pat.len() && pat[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < pat.len() && pat[pi] == '*' {
        pi += 1;
    }
    pi == pat.len()
}

/// 按文件名通配符递归查找文件，返回相对工作根的路径列表。
#[tauri::command]
pub(crate) fn agent_find_files(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    pattern: String,
    rel_path: Option<String>,
) -> Result<Vec<String>, String> {
    find_files(&grants, &workspace_id, &pattern, rel_path.as_deref())
}

pub(crate) fn find_files(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    pattern: &str,
    rel_path: Option<&str>,
) -> Result<Vec<String>, String> {
    if pattern.trim().is_empty() {
        return Err("查找模式不能为空".to_string());
    }
    let base_root = grants.resolve(workspace_id)?;
    let rel = rel_path.unwrap_or_default();
    let base = safe_join_rel(&base_root, if rel.is_empty() { "." } else { rel })?;
    if !base.is_dir() {
        return Err("目标不是目录".to_string());
    }

    let mut results: Vec<String> = Vec::new();
    walk_files(&base, &mut |rel_str, abs| {
        let fname = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if glob_match(pattern, &fname) {
            // 路径相对「工作根」而非 base，便于后续直接读写
            let from_root = abs
                .strip_prefix(&base_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| rel_str.to_string());
            results.push(from_root);
        }
        results.len() < MAX_FIND_RESULTS
    });
    Ok(results)
}

/// 递归按内容搜索（大小写不敏感子串），返回命中 [{path,line,text}]。
#[tauri::command]
pub(crate) fn agent_search_in_files(
    grants: tauri::State<'_, Arc<WorkspaceGrants>>,
    workspace_id: String,
    query: String,
    rel_path: Option<String>,
) -> Result<serde_json::Value, String> {
    search_in_files(&grants, &workspace_id, &query, rel_path.as_deref())
}

pub(crate) fn search_in_files(
    grants: &WorkspaceGrants,
    workspace_id: &str,
    query: &str,
    rel_path: Option<&str>,
) -> Result<serde_json::Value, String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    let base_root = grants.resolve(workspace_id)?;
    let rel = rel_path.unwrap_or_default();
    let base = safe_join_rel(&base_root, if rel.is_empty() { "." } else { rel })?;
    if !base.is_dir() {
        return Err("目标不是目录".to_string());
    }
    let needle = query.to_lowercase();

    let mut matches: Vec<serde_json::Value> = Vec::new();
    walk_files(&base, &mut |_rel_str, abs| {
        // 跳过过大文件
        if let Ok(meta) = fs::metadata(abs) {
            if meta.len() > MAX_READ_BYTES {
                return true;
            }
        }
        // 非 UTF-8/读失败 → 跳过
        let content = match fs::read_to_string(abs) {
            Ok(c) => c,
            Err(_) => return true,
        };
        let from_root = abs
            .strip_prefix(&base_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let text: String = line.trim().chars().take(SEARCH_LINE_MAX).collect();
                matches.push(serde_json::json!({
                    "path": from_root,
                    "line": i + 1,
                    "text": text,
                }));
                if matches.len() >= MAX_SEARCH_MATCHES {
                    return false;
                }
            }
        }
        true
    });
    Ok(serde_json::Value::Array(matches))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{TempAppPaths, TempDir};

    struct Fixture {
        _paths: TempAppPaths,
        root: TempDir,
        grants: WorkspaceGrants,
        id: String,
    }

    impl Fixture {
        fn new() -> Self {
            let paths = TempAppPaths::new();
            let root = TempDir::new();
            let grants = WorkspaceGrants::new(paths.shared_paths());
            let id = grants.grant_from_selection(root.path()).unwrap().id;
            Self {
                _paths: paths,
                root,
                grants,
                id,
            }
        }
    }

    #[test]
    fn text_files_support_write_append_list_read_and_delete() {
        let fixture = Fixture::new();
        let (grants, id) = (&fixture.grants, fixture.id.as_str());
        write_file(grants, id, "nested/note.txt", "第一行\n").unwrap();
        append_file(grants, id, "nested/note.txt", "第二行\n").unwrap();
        append_file(grants, id, "created/append.txt", "追加也能新建").unwrap();
        assert_eq!(
            read_file(grants, id, "nested/note.txt").unwrap(),
            "第一行\n第二行\n"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("created/append.txt")).unwrap(),
            "追加也能新建"
        );
        let root_items = list_dir(grants, id, "").unwrap();
        assert_eq!(root_items.as_array().unwrap().len(), 2);
        assert!(root_items
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "nested" && item["is_dir"] == true));
        let nested = list_dir(grants, id, "nested").unwrap();
        assert_eq!(
            nested,
            serde_json::json!([{
                "name": "note.txt", "is_dir": false, "size": "第一行\n第二行\n".len(),
            }])
        );
        assert!(delete_file(grants, id, "nested")
            .unwrap_err()
            .contains("拒绝删除目录"));
        assert!(list_dir(grants, id, "nested/note.txt")
            .unwrap_err()
            .contains("不是目录"));
        assert!(read_file(grants, id, "nested")
            .unwrap_err()
            .contains("不是文件"));
        delete_file(grants, id, "nested/note.txt").unwrap();
        assert!(!fixture.root.path().join("nested/note.txt").exists());
        assert!(delete_file(grants, id, "nested/note.txt")
            .unwrap_err()
            .contains("不存在"));
        assert!(fixture.root.path().join("nested").is_dir());
    }

    #[test]
    fn text_reading_rejects_non_utf8_and_oversized_files() {
        let fixture = Fixture::new();
        fs::write(fixture.root.path().join("binary.txt"), [0xff, 0xfe]).unwrap();
        assert!(read_file(&fixture.grants, &fixture.id, "binary.txt")
            .unwrap_err()
            .contains("UTF-8"));
        let oversized = fs::File::create(fixture.root.path().join("large.txt")).unwrap();
        oversized.set_len(MAX_READ_BYTES + 1).unwrap();
        assert!(read_file(&fixture.grants, &fixture.id, "large.txt")
            .unwrap_err()
            .contains("文件过大"));
    }

    #[test]
    fn image_reading_uses_signatures_and_preserves_data_url_fields() {
        let fixture = Fixture::new();
        let images: &[(&[u8], &str)] = &[
            (b"\x89PNG\r\n\x1a\nrest", "image/png"),
            (b"\xff\xd8\xffrest", "image/jpeg"),
            (b"GIF87arest", "image/gif"),
            (b"GIF89arest", "image/gif"),
            (b"RIFF1234WEBPrest", "image/webp"),
        ];
        for (bytes, mime) in images {
            fs::write(fixture.root.path().join("picture.bin"), bytes).unwrap();
            let image = read_image(&fixture.grants, &fixture.id, "picture.bin").unwrap();
            assert_eq!(image.mime_type, *mime);
            assert_eq!(image.size, bytes.len() as u64);
            assert_eq!(image.name, "picture.bin");
            assert_eq!(
                image.data_url,
                format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            );
        }
        fs::write(fixture.root.path().join("fake.png"), "并非图片").unwrap();
        assert!(read_image(&fixture.grants, &fixture.id, "fake.png")
            .err()
            .unwrap()
            .contains("不支持的图片格式"));
        let oversized = fs::File::create(fixture.root.path().join("large.png")).unwrap();
        oversized.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_image(&fixture.grants, &fixture.id, "large.png")
            .err()
            .unwrap()
            .contains("图片过大"));
        assert!(read_image(&fixture.grants, &fixture.id, ".").is_err());
    }

    #[test]
    fn line_operations_preserve_crlf_and_the_original_trailing_newline() {
        let fixture = Fixture::new();
        let (grants, id) = (&fixture.grants, fixture.id.as_str());
        write_file(grants, id, "lines.txt", "一\r\n二\r\n三\r\n").unwrap();
        assert_eq!(
            read_lines(grants, id, "lines.txt", Some(2), Some(3)).unwrap(),
            "2 | 二\n3 | 三\n"
        );
        assert!(edit_lines(
            grants,
            id,
            "lines.txt",
            "replace",
            Some(2),
            Some(2),
            Some("新二\n额外")
        )
        .unwrap()
        .contains("已替换"));
        assert_eq!(
            read_file(grants, id, "lines.txt").unwrap(),
            "一\r\n新二\r\n额外\r\n三\r\n"
        );
        edit_lines(grants, id, "lines.txt", "insert", Some(1), None, Some("零")).unwrap();
        edit_lines(grants, id, "lines.txt", "delete", Some(3), Some(4), None).unwrap();
        assert_eq!(
            read_file(grants, id, "lines.txt").unwrap(),
            "零\r\n一\r\n三\r\n"
        );
        let before = read_file(grants, id, "lines.txt").unwrap();
        assert!(edit_lines(
            grants,
            id,
            "lines.txt",
            "replace",
            Some(0),
            Some(1),
            Some("不应写入")
        )
        .is_err());
        assert!(edit_lines(grants, id, "lines.txt", "unknown", None, None, None).is_err());
        assert_eq!(read_file(grants, id, "lines.txt").unwrap(), before);
        write_file(grants, id, "no-final-newline.txt", "a\nb").unwrap();
        edit_lines(
            grants,
            id,
            "no-final-newline.txt",
            "insert",
            Some(3),
            None,
            Some("c"),
        )
        .unwrap();
        assert_eq!(
            read_file(grants, id, "no-final-newline.txt").unwrap(),
            "a\nb\nc"
        );
    }

    #[test]
    fn line_reading_limits_large_ranges_and_reports_empty_ranges() {
        let fixture = Fixture::new();
        let (grants, id) = (&fixture.grants, fixture.id.as_str());
        let content = "短行\n".repeat(MAX_RANGE_LINES as usize + 2);
        write_file(grants, id, "many.txt", &content).unwrap();
        let range = read_lines(grants, id, "many.txt", None, None).unwrap();
        assert_eq!(range.matches(" | ").count(), MAX_RANGE_LINES as usize);
        assert!(range.contains("已截断"));
        assert!(read_lines(grants, id, "many.txt", Some(900), None)
            .unwrap()
            .contains("无内容"));
        write_file(
            grants,
            id,
            "wide.txt",
            &format!("首行\n{}\n", "x".repeat(MAX_RANGE_BYTES)),
        )
        .unwrap();
        let wide = read_lines(grants, id, "wide.txt", None, None).unwrap();
        assert!(wide.starts_with("1 | 首行\n"));
        assert!(wide.contains("已截断"));
    }

    #[test]
    fn find_and_search_walk_nested_files_with_relative_paths_and_limits() {
        let fixture = Fixture::new();
        let (grants, id) = (&fixture.grants, fixture.id.as_str());
        write_file(
            grants,
            id,
            "notes/A.TXT",
            "  Hello Needle  \nother\nneedle twice\n",
        )
        .unwrap();
        write_file(grants, id, "notes/deep/b.txt", "NEEDLE\n").unwrap();
        write_file(grants, id, "outside.txt", "needle\n").unwrap();
        fs::write(fixture.root.path().join("notes/binary.txt"), [0xff]).unwrap();
        let mut files = find_files(grants, id, "?.t?t", Some("notes")).unwrap();
        files.sort();
        assert_eq!(files, ["notes/A.TXT", "notes/deep/b.txt"]);
        let found = search_in_files(grants, id, "nEeDlE", Some("notes")).unwrap();
        let matches = found.as_array().unwrap();
        assert_eq!(matches.len(), 3);
        assert!(matches.contains(
            &serde_json::json!({"path": "notes/A.TXT", "line": 1, "text": "Hello Needle"})
        ));
        assert!(matches.contains(
            &serde_json::json!({"path": "notes/A.TXT", "line": 3, "text": "needle twice"})
        ));
        assert!(matches.contains(
            &serde_json::json!({"path": "notes/deep/b.txt", "line": 1, "text": "NEEDLE"})
        ));
        assert!(find_files(grants, id, " ", None).is_err());
        assert!(search_in_files(grants, id, "", None).is_err());
        write_file(
            grants,
            id,
            "many-matches.txt",
            &"needle\n".repeat(MAX_SEARCH_MATCHES + 2),
        )
        .unwrap();
        let all = search_in_files(grants, id, "needle", None).unwrap();
        assert_eq!(all.as_array().unwrap().len(), MAX_SEARCH_MATCHES);
        for i in 0..=MAX_FIND_RESULTS {
            write_file(grants, id, &format!("many/{i}.match"), "").unwrap();
        }
        assert_eq!(
            find_files(grants, id, "*.match", None).unwrap().len(),
            MAX_FIND_RESULTS
        );
    }

    fn assert_all_file_operations_reject(grants: &WorkspaceGrants, id: &str, relative: &str) {
        assert!(read_file(grants, id, relative).is_err());
        assert!(read_image(grants, id, relative).is_err());
        assert!(write_file(grants, id, relative, "不应写入").is_err());
        assert!(append_file(grants, id, relative, "不应追加").is_err());
        assert!(list_dir(grants, id, relative).is_err());
        assert!(delete_file(grants, id, relative).is_err());
        assert!(read_lines(grants, id, relative, None, None).is_err());
        assert!(edit_lines(
            grants,
            id,
            relative,
            "replace",
            Some(1),
            Some(1),
            Some("不应替换")
        )
        .is_err());
        assert!(find_files(grants, id, "*", Some(relative)).is_err());
        assert!(search_in_files(grants, id, "外部", Some(relative)).is_err());
    }

    #[test]
    fn every_file_operation_rejects_traversal_absolute_roots_and_revoked_capabilities() {
        let fixture = Fixture::new();
        let outside = TempDir::new();
        let protected = outside.path().join("secret.txt");
        fs::write(&protected, "外部文件").unwrap();
        assert_all_file_operations_reject(&fixture.grants, &fixture.id, "../secret.txt");
        assert_all_file_operations_reject(
            &fixture.grants,
            &fixture.id,
            &protected.to_string_lossy(),
        );
        assert_all_file_operations_reject(
            &fixture.grants,
            &outside.path().to_string_lossy(),
            "secret.txt",
        );
        write_file(&fixture.grants, &fixture.id, "owned.txt", "仍须保留").unwrap();
        revoke_workspace(&fixture.grants, &fixture.id).unwrap();
        assert_all_file_operations_reject(&fixture.grants, &fixture.id, "owned.txt");
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("owned.txt")).unwrap(),
            "仍须保留"
        );
        assert_eq!(fs::read_to_string(protected).unwrap(), "外部文件");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn file_operations_and_recursive_search_do_not_follow_external_directory_links() {
        use crate::path::tests::DirectoryLink;

        let fixture = Fixture::new();
        let outside = TempDir::new();
        fs::write(outside.path().join("secret.txt"), "外部秘密").unwrap();
        let _link = DirectoryLink::new(outside.path(), &fixture.root.path().join("link"));
        assert_all_file_operations_reject(&fixture.grants, &fixture.id, "link/secret.txt");
        assert!(write_file(&fixture.grants, &fixture.id, "link/new.txt", "不应写入").is_err());
        assert!(find_files(&fixture.grants, &fixture.id, "*", None)
            .unwrap()
            .is_empty());
        assert_eq!(
            search_in_files(&fixture.grants, &fixture.id, "外部", None).unwrap(),
            serde_json::json!([])
        );
        assert!(!outside.path().join("new.txt").exists());
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
            "外部秘密"
        );
    }
}
