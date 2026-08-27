//! 应用数据备份、恢复与清除。
//!
//! 备份包含角色、会话和前端传入的非敏感设置；不包含 API Key、密钥链条目、
//! 日志或 AI 工作区文件。恢复前会把现有角色与会话保留到 cache/recovery-*。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::path::{backups_dir, characters_dir, log_dir, sessions_file};

const FORMAT_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 100_000;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_SETTINGS_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct BackupManifest {
    format_version: u32,
    app_version: String,
    includes_secrets: bool,
}

fn validate_dest(dest_path: &str) -> Result<PathBuf, String> {
    let dest = PathBuf::from(dest_path);
    if dest.extension().and_then(|v| v.to_str()) != Some("zip") {
        return Err("备份文件必须使用 .zip 扩展名".to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
    }
    Ok(dest)
}

fn add_tree<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    disk_root: &Path,
    current: &Path,
    archive_root: &str,
    options: zip::write::SimpleFileOptions,
    total: &mut u64,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(|e| format!("读取数据目录失败: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(disk_root).map_err(|e| e.to_string())?;
        let rel_name = rel.to_string_lossy().replace('\\', "/");
        let archive_name = format!("{archive_root}/{rel_name}");
        if file_type.is_dir() {
            zip.add_directory(format!("{archive_name}/"), options)
                .map_err(|e| e.to_string())?;
            add_tree(zip, disk_root, &path, archive_root, options, total)?;
        } else if file_type.is_file() {
            let size = entry.metadata().map_err(|e| e.to_string())?.len();
            if size > MAX_ENTRY_BYTES || total.saturating_add(size) > MAX_TOTAL_BYTES {
                return Err("应用数据超过备份大小上限".to_string());
            }
            *total += size;
            zip.start_file(archive_name, options)
                .map_err(|e| e.to_string())?;
            let mut source = fs::File::open(&path).map_err(|e| format!("读取备份文件失败: {e}"))?;
            std::io::copy(&mut source, zip).map_err(|e| format!("写入备份失败: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn export_data_backup(dest_path: String, settings_json: String) -> Result<(), String> {
    if settings_json.len() > MAX_SETTINGS_BYTES {
        return Err("设置数据过大".to_string());
    }
    let settings: serde_json::Value =
        serde_json::from_str(&settings_json).map_err(|_| "设置数据不是有效 JSON".to_string())?;
    if !settings.is_object() {
        return Err("设置数据必须是 JSON 对象".to_string());
    }

    let dest = validate_dest(&dest_path)?;
    let file = fs::File::create(dest).map_err(|e| format!("创建备份失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let manifest = BackupManifest {
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        includes_secrets: false,
    };
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("settings.json", options).map_err(|e| e.to_string())?;
    zip.write_all(settings_json.as_bytes()).map_err(|e| e.to_string())?;

    let session = sessions_file();
    if session.is_file() {
        zip.start_file("sessions.json", options).map_err(|e| e.to_string())?;
        let mut source = fs::File::open(session).map_err(|e| e.to_string())?;
        std::io::copy(&mut source, &mut zip).map_err(|e| e.to_string())?;
    }

    let chars = characters_dir();
    zip.add_directory("characters/", options).map_err(|e| e.to_string())?;
    let mut total = 0;
    add_tree(&mut zip, &chars, &chars, "characters", options, &mut total)?;
    zip.finish().map_err(|e| format!("完成备份失败: {e}"))?;
    Ok(())
}

fn allowed_backup_path(path: &Path) -> bool {
    path == Path::new("manifest.json")
        || path == Path::new("settings.json")
        || path == Path::new("sessions.json")
        || path.starts_with("characters")
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn import_data_backup(src_path: String) -> Result<String, String> {
    let file = fs::File::open(src_path).map_err(|e| format!("打开备份失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析备份失败: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("备份条目过多".to_string());
    }

    let stage = backups_dir().join(format!("data-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut total = 0_u64;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let rel = entry
                .enclosed_name()
                .ok_or_else(|| "备份包含不安全路径".to_string())?
                .to_path_buf();
            if !allowed_backup_path(&rel) {
                return Err(format!("备份包含未知条目: {}", rel.display()));
            }
            if entry.size() > MAX_ENTRY_BYTES || total.saturating_add(entry.size()) > MAX_TOTAL_BYTES {
                return Err("备份解压大小超过上限".to_string());
            }
            total += entry.size();
            let target = stage.join(&rel);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }

        let manifest: BackupManifest = serde_json::from_str(
            &fs::read_to_string(stage.join("manifest.json"))
                .map_err(|_| "备份缺少 manifest.json".to_string())?,
        )
        .map_err(|_| "备份清单损坏".to_string())?;
        if manifest.format_version != FORMAT_VERSION || manifest.includes_secrets {
            return Err("不支持的备份格式".to_string());
        }
        let settings = fs::read_to_string(stage.join("settings.json"))
            .map_err(|_| "备份缺少 settings.json".to_string())?;
        if !serde_json::from_str::<serde_json::Value>(&settings)
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            return Err("备份设置损坏".to_string());
        }
        let staged_sessions = stage.join("sessions.json");
        if staged_sessions.exists() {
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&staged_sessions).map_err(|e| e.to_string())?,
            )
            .map_err(|_| "备份会话数据损坏".to_string())?;
        }

        let recovery = backups_dir().join(format!("recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&recovery).map_err(|e| e.to_string())?;
        let chars = characters_dir();
        copy_tree(&chars, &recovery.join("characters"))?;
        if sessions_file().is_file() {
            fs::copy(sessions_file(), recovery.join("sessions.json")).map_err(|e| e.to_string())?;
        }

        if chars.exists() {
            fs::remove_dir_all(&chars).map_err(|e| format!("清理现有角色失败: {e}"))?;
        }
        let staged_chars = stage.join("characters");
        if staged_chars.exists() {
            copy_tree(&staged_chars, &chars)?;
        } else {
            fs::create_dir_all(&chars).map_err(|e| e.to_string())?;
        }
        if staged_sessions.exists() {
            fs::copy(&staged_sessions, sessions_file()).map_err(|e| e.to_string())?;
        } else if sessions_file().exists() {
            fs::remove_file(sessions_file()).map_err(|e| e.to_string())?;
        }
        Ok(settings)
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

#[tauri::command]
pub(crate) fn reset_all_local_data() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("开发模式禁止一键清除，避免删除仓库中的角色资源".to_string());
    }
    let chars = characters_dir();
    let logs = log_dir();
    let backups = backups_dir();
    if chars.exists() {
        fs::remove_dir_all(&chars).map_err(|e| format!("删除角色失败: {e}"))?;
    }
    if sessions_file().exists() {
        fs::remove_file(sessions_file()).map_err(|e| format!("删除会话失败: {e}"))?;
    }
    if logs.exists() {
        fs::remove_dir_all(&logs).map_err(|e| format!("删除日志失败: {e}"))?;
    }
    if backups.exists() {
        fs::remove_dir_all(&backups).map_err(|e| format!("删除缓存备份失败: {e}"))?;
    }
    fs::create_dir_all(chars).map_err(|e| e.to_string())?;
    fs::create_dir_all(logs).map_err(|e| e.to_string())?;
    fs::create_dir_all(backups).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_paths_are_allowlisted() {
        assert!(allowed_backup_path(Path::new("manifest.json")));
        assert!(allowed_backup_path(Path::new("characters/a/character.json")));
        assert!(!allowed_backup_path(Path::new("logs/app.jsonl")));
        assert!(!allowed_backup_path(Path::new("../secret")));
    }
}
