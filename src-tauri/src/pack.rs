use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::path::{characters_dir, sanitize_path_component};

/// 单条目解压上限（防止超大文件一次性读入内存）
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
/// 单包解压总量上限（防止 zip 炸弹耗尽磁盘）
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 单包条目数上限
const MAX_ENTRIES: usize = 100_000;
/// 扫描阶段读取 character.json 的上限（仅用于提取 id）
const MAX_MANIFEST_JSON_BYTES: usize = 1024 * 1024;
/// 分块读取缓冲区大小
const READ_CHUNK_SIZE: usize = 64 * 1024;

/// 带上限分块读取压缩条目内容。
/// `cap` 为 0 表示不限制。超出上限返回 Err，避免恶意包把巨型文件撑爆内存。
fn read_entry_limited(entry: &mut zip::read::ZipFile, cap: u64) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; READ_CHUNK_SIZE];
    let mut total: u64 = 0;
    loop {
        let n = entry
            .read(&mut chunk)
            .map_err(|e| format!("读取压缩条目失败: {}", e))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if cap > 0 && total > cap {
            return Err(format!(
                "条目过大（超过 {} MiB 上限）",
                cap / (1024 * 1024)
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

/// 角色包导入结果
#[derive(Serialize)]
pub(crate) struct ImportResult {
    imported: Vec<String>,
    skipped: Vec<String>,
}

/// 递归把 `cur` 目录下所有文件写入 zip；zip 内路径为相对 `base` 的路径（POSIX 分隔符）。
fn zip_dir_recursive<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    cur: &Path,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(cur).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let rel = path.strip_prefix(base).map_err(|e| e.to_string())?;
        let name = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{}/", name), options)
                .map_err(|e| e.to_string())?;
            zip_dir_recursive(zip, base, &path, options)?;
        } else {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 把单个角色目录打包为 zip（zip 内路径形如 <id>/character.json、<id>/images/x.png）。
/// dest_path 由前端 dialog.save 选择。
#[tauri::command]
pub(crate) fn export_character_pack(id: String, dest_path: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let base = characters_dir();
    let char_dir = base.join(&id);
    if !char_dir.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }

    // 防御性校验目标路径（正常由前端 dialog 传入）
    let dest = PathBuf::from(&dest_path);
    if dest.to_string_lossy().contains("..") {
        return Err("无效的导出路径".to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    let file = fs::File::create(&dest).map_err(|e| format!("创建角色包失败: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.add_directory(format!("{}/", id), options)
        .map_err(|e| e.to_string())?;
    zip_dir_recursive(&mut zip, &base, &char_dir, options)?;
    zip.finish().map_err(|e| format!("完成角色包写入失败: {}", e))?;
    Ok(())
}

/// 从 zip 角色包导入角色到 characters_dir。
/// 冲突策略：跳过已存在的角色 id（保护用户已改过的角色）。
/// 角色 id 取自每个 character.json 的 `id` 字段（回退到所在目录名）；
/// 兼容 `character.json` 在包根、`<id>/character.json`、`<前缀>/<id>/character.json` 等结构，
/// 以 character.json 所在目录为前缀重映射解压到 characters_dir/<id>。
/// 安全：enclosed_name 防 zip-slip；id 过 sanitize 校验；解压目标须在 characters_dir 内。
#[tauri::command]
pub(crate) fn import_character_pack(src_path: String) -> Result<ImportResult, String> {
    let base = characters_dir();
    fs::create_dir_all(&base).map_err(|e| format!("创建角色目录失败: {}", e))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("解析角色目录失败: {}", e))?;

    let file =
        fs::File::open(&src_path).map_err(|e| format!("打开角色包失败: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("解析角色包失败: {}", e))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "角色包条目过多（{} > {}），疑似恶意压缩包",
            archive.len(),
            MAX_ENTRIES
        ));
    }

    eprintln!(
        "[kisaki] 导入角色包: {}（{} 个条目）",
        src_path,
        archive.len()
    );

    // 第一遍：找出所有 character.json。角色 id 以其内部的 `id` 字段为权威来源
    // （回退到所在目录名），所在目录作为 zip 内前缀用于解压重映射。
    // 兼容根级 character.json（前缀为空，整包即一个角色）。
    let mut roots: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut sample_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().to_string();
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                eprintln!("[kisaki]   跳过不安全条目: {}", raw_name);
                continue;
            }
        };
        if sample_names.len() < 20 {
            sample_names.push(enclosed.to_string_lossy().replace('\\', "/"));
        }
        if !enclosed.file_name().map(|f| f == "character.json").unwrap_or(false) {
            continue;
        }
        // 角色根前缀 = character.json 所在目录（根级则为空路径）
        let prefix = enclosed
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        // 优先取 character.json 内的 id 字段；回退到所在目录名
        let content = match read_entry_limited(&mut entry, MAX_MANIFEST_JSON_BYTES as u64) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                eprintln!("[kisaki]   character.json 读取失败，跳过: {}", e);
                continue;
            }
        };
        let id_from_json = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty());
        let id = match id_from_json.or_else(|| {
            enclosed
                .parent()
                .and_then(|p| p.file_name())
                .map(|os| os.to_string_lossy().to_string())
        }) {
            Some(id) => id,
            None => {
                eprintln!("[kisaki]   {} 无 id 字段且位于包根，跳过", raw_name);
                continue;
            }
        };
        eprintln!(
            "[kisaki]   发现角色: id={} 前缀=\"{}\"",
            id,
            prefix.display()
        );
        roots.insert(id, prefix);
    }

    if roots.is_empty() {
        return Err(format!(
            "角色包中未找到 <角色id>/character.json。包内条目示例：[{}]。\
             请确保 zip 内每个角色是一个以角色 id 命名的文件夹（其中含 character.json）。",
            sample_names.join(", ")
        ));
    }

    // 决定导入 / 跳过
    let mut imported: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut to_import: BTreeMap<String, PathBuf> = BTreeMap::new();
    for (id, prefix) in &roots {
        if sanitize_path_component(id).is_err() {
            skipped.push(id.clone());
        } else if base.join(id).exists() {
            skipped.push(id.clone()); // 已存在 → 跳过，不覆盖
        } else {
            to_import.insert(id.clone(), prefix.clone());
        }
    }

    // 第二遍：解压属于 to_import 角色的条目，按角色根前缀重映射到 characters_dir/<id>/...
    let mut total_extracted: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        // 找到此条目所属的待导入角色根（按 zip 内前缀匹配）。
        // 用「最长前缀优先」：空前缀（根级 character.json）会匹配所有条目，
        // 必须让更具体的目录前缀胜出，否则根级角色会吞掉嵌套角色的所有条目。
        let mut mapped: Option<(String, PathBuf)> = None;
        for (id, prefix) in &to_import {
            if let Ok(rel) = enclosed.strip_prefix(prefix) {
                let better = mapped
                    .as_ref()
                    .map_or(true, |(_, cur)| rel.components().count() < cur.components().count());
                if better {
                    mapped = Some((id.clone(), rel.to_path_buf()));
                }
            }
        }
        let (id, rel) = match mapped {
            Some(v) => v,
            None => continue,
        };

        let target = canonical_base.join(&id).join(&rel);
        if !target.starts_with(&canonical_base) {
            continue; // zip-slip 双保险
        }
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let buf = read_entry_limited(&mut entry, MAX_ENTRY_BYTES)?;
            total_extracted += buf.len() as u64;
            if total_extracted > MAX_TOTAL_BYTES {
                return Err(format!(
                    "角色包解压总量超过 {} GiB 上限，已中止导入（防 zip 炸弹）",
                    MAX_TOTAL_BYTES / (1024 * 1024 * 1024)
                ));
            }
            fs::write(&target, &buf).map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    for id in to_import.keys() {
        imported.push(id.clone());
    }
    imported.sort();
    skipped.sort();
    eprintln!(
        "[kisaki] 导入完成: imported={:?} skipped={:?}",
        imported, skipped
    );
    Ok(ImportResult { imported, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 构造一个包含单个条目的内存 zip，返回其字节
    fn make_zip(entry_name: &str, content: &[u8]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(entry_name, options).unwrap();
        writer.write_all(content).unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn read_entry_limited_ok_within_cap() {
        let bytes = make_zip("a.txt", b"hello world");
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entry = archive.by_index(0).unwrap();
        let data = read_entry_limited(&mut entry, 1024).unwrap();
        assert_eq!(data, b"hello world");
    }

    #[test]
    fn read_entry_limited_rejects_oversized() {
        let payload = vec![b'x'; 2048];
        let bytes = make_zip("big.bin", &payload);
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entry = archive.by_index(0).unwrap();
        let err = read_entry_limited(&mut entry, 1024).unwrap_err();
        assert!(err.contains("过大"), "应提示条目过大，实际: {}", err);
    }

    #[test]
    fn read_entry_limited_unlimited() {
        let payload = vec![b'y'; 5000];
        let bytes = make_zip("u.bin", &payload);
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entry = archive.by_index(0).unwrap();
        let data = read_entry_limited(&mut entry, 0).unwrap();
        assert_eq!(data.len(), 5000);
    }

    #[test]
    fn entries_cap_constants_are_sane() {
        // 常量自检：确保上限为正且总量大于单条目
        assert!(MAX_ENTRY_BYTES > 0);
        assert!(MAX_TOTAL_BYTES > MAX_ENTRY_BYTES);
        assert!(MAX_ENTRIES > 1000);
    }
}
