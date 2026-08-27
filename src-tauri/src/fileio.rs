//! AI 工作目录文件读写命令
//!
//! 供前端 agent 工具调用，让 AI 在「用户授权的工作目录」内读写文件。
//! 沙箱模型：
//!   - 工作目录（root）由用户在前端通过目录选择框手动授权，按会话存储在前端。
//!   - 本模块的命令均无全局状态：每次调用把 root 作参数传入，LLM 只能提供
//!     相对路径（rel_path），永远碰不到 root 之外的文件。
//!   - 所有相对路径经 `safe_join_rel` 校验，防 path traversal / 符号链接逃逸。

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::path::safe_join_rel;

/// 单次读取上限：2 MiB。防止把超大文件灌进 LLM 上下文。
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// 按行区间读取：返回行数与字节上限（保护上下文）。
const MAX_RANGE_LINES: u64 = 800;
const MAX_RANGE_BYTES: usize = 200 * 1024;
/// 查找/搜索：结果与扫描规模上限。
const MAX_FIND_RESULTS: usize = 200;
const MAX_SEARCH_MATCHES: usize = 100;
const MAX_ENTRIES_SCANNED: usize = 20000;
/// 搜索命中行文本的最大保留长度。
const SEARCH_LINE_MAX: usize = 200;

/// 校验 root 是有效目录、已授权，并规范化返回。
pub(crate) fn check_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err("工作目录无效或已不存在".to_string());
    }
    let canon = p.canonicalize().map_err(|e| format!("无法解析工作目录: {}", e))?;
    if !crate::path::is_workspace_authorized(&canon) {
        return Err("工作目录未经授权，请先在界面中通过「设置工作区」选择授权目录".to_string());
    }
    Ok(canon)
}

/// 登记用户通过目录选择框授权的工作目录（加入后端白名单）。
/// 前端在用户选择目录时调用；fileio / command 只接受白名单内的 root。
#[tauri::command]
pub(crate) fn agent_authorize_workspace(root: String) -> Result<(), String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err("工作目录无效或已不存在".to_string());
    }
    crate::path::authorize_workspace(&p)
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

// ─── 按行读取 ──────────────────────────────────────────

/// 读取文件指定行区间（1-based 闭区间），返回带右对齐行号的文本。
/// start 缺省=1，end 缺省=文件末尾。逐行流式读取，不受整文件 2MB 限制约束。
/// 受 MAX_RANGE_LINES / MAX_RANGE_BYTES 限制，超出则截断并附提示。
#[tauri::command]
pub(crate) fn agent_read_lines(
    root: String,
    rel_path: String,
    start_line: Option<u64>,
    end_line: Option<u64>,
) -> Result<String, String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
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
    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
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
    root: String,
    rel_path: String,
    operation: String,
    start_line: Option<u64>,
    end_line: Option<u64>,
    content: Option<String>,
) -> Result<String, String> {
    let path = safe_join_rel(&check_root(&root)?, &rel_path)?;
    if !path.is_file() {
        return Err("文件不存在或不是文件（新建文件请用 write_file）".to_string());
    }
    let original = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let (mut lines, newline, ends_with_nl) = split_lines(&original);
    let n = lines.len() as u64;

    let summary = match operation.as_str() {
        "replace" => {
            let s = start_line.ok_or("replace 需要 start_line")?;
            let e = end_line.ok_or("replace 需要 end_line")?;
            let body = content.ok_or("replace 需要 content")?;
            if s < 1 || e < s || e > n {
                return Err(format!("行区间越界：start={}, end={}, 文件共 {} 行", s, e, n));
            }
            let (new_lines, _, _) = split_lines(&body);
            let si = (s - 1) as usize;
            let ei = e as usize; // 闭区间 → 独占上界
            lines.splice(si..ei, new_lines.iter().cloned());
            format!("已替换第 {}-{} 行（共 {} 行新内容）", s, e, new_lines.len())
        }
        "insert" => {
            let line = start_line.ok_or("insert 需要 line（用 start_line 传入）")?;
            let body = content.ok_or("insert 需要 content")?;
            if line < 1 || line > n + 1 {
                return Err(format!("插入位置越界：line={}, 文件共 {} 行（可取 1..={}）", line, n, n + 1));
            }
            let (new_lines, _, _) = split_lines(&body);
            let at = (line - 1) as usize;
            let cnt = new_lines.len();
            lines.splice(at..at, new_lines);
            format!("已在第 {} 行前插入 {} 行", line, cnt)
        }
        "delete" => {
            let s = start_line.ok_or("delete 需要 start_line")?;
            let e = end_line.ok_or("delete 需要 end_line")?;
            if s < 1 || e < s || e > n {
                return Err(format!("行区间越界：start={}, end={}, 文件共 {} 行", s, e, n));
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
    root: String,
    pattern: String,
    rel_path: Option<String>,
) -> Result<Vec<String>, String> {
    if pattern.trim().is_empty() {
        return Err("查找模式不能为空".to_string());
    }
    let base_root = check_root(&root)?;
    let rel = rel_path.unwrap_or_default();
    let base = safe_join_rel(&base_root, if rel.is_empty() { "." } else { &rel })?;
    if !base.is_dir() {
        return Err("目标不是目录".to_string());
    }

    let mut results: Vec<String> = Vec::new();
    walk_files(&base, &mut |rel_str, abs| {
        let fname = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if glob_match(&pattern, &fname) {
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
    root: String,
    query: String,
    rel_path: Option<String>,
) -> Result<serde_json::Value, String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    let base_root = check_root(&root)?;
    let rel = rel_path.unwrap_or_default();
    let base = safe_join_rel(&base_root, if rel.is_empty() { "." } else { &rel })?;
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
