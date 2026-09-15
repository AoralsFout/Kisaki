//! 应用数据备份、恢复与清除。
//!
//! 备份包含角色、会话和前端传入的非敏感设置；不包含 API Key、密钥链条目、
//! 日志或 AI 工作区文件。恢复前会把现有角色与会话保留到 cache/recovery-*。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::app_paths::AppPaths;

const FORMAT_VERSION: u32 = 2;
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
pub(crate) fn export_data_backup(
    paths: tauri::State<'_, Arc<AppPaths>>,
    dest_path: String,
    settings_json: String,
) -> Result<(), String> {
    export(&paths, &dest_path, &settings_json)
}

pub(crate) fn export(paths: &AppPaths, dest_path: &str, settings_json: &str) -> Result<(), String> {
    if settings_json.len() > MAX_SETTINGS_BYTES {
        return Err("设置数据过大".to_string());
    }
    let settings: serde_json::Value =
        serde_json::from_str(settings_json).map_err(|_| "设置数据不是有效 JSON".to_string())?;
    if !settings.is_object() {
        return Err("设置数据必须是 JSON 对象".to_string());
    }

    let dest = validate_dest(dest_path)?;
    let file = fs::File::create(dest).map_err(|e| format!("创建备份失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let manifest = BackupManifest {
        format_version: FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        includes_secrets: false,
    };
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("settings.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(settings_json.as_bytes())
        .map_err(|e| e.to_string())?;

    let session = paths.sessions_v2_file();
    if session.is_file() {
        zip.start_file("sessions-v2.json", options)
            .map_err(|e| e.to_string())?;
        let mut source = fs::File::open(session).map_err(|e| e.to_string())?;
        std::io::copy(&mut source, &mut zip).map_err(|e| e.to_string())?;
    }

    let chars = paths.characters_dir();
    zip.add_directory("characters/", options)
        .map_err(|e| e.to_string())?;
    let mut total = 0;
    add_tree(&mut zip, chars, chars, "characters", options, &mut total)?;
    zip.finish().map_err(|e| format!("完成备份失败: {e}"))?;
    Ok(())
}

fn allowed_backup_path(path: &Path) -> bool {
    path == Path::new("manifest.json")
        || path == Path::new("settings.json")
        || path == Path::new("sessions-v2.json")
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

fn remove_directory_in(directory: &Path, allowed_root: &Path) -> io::Result<()> {
    let directory = std::path::absolute(directory)?;
    let root = allowed_root.canonicalize()?;
    let resolved = directory.canonicalize()?;
    if !resolved.is_absolute() || !resolved.starts_with(&root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("拒绝清理数据目录范围之外的路径: {}", directory.display()),
        ));
    }
    // 先核对实际绝对位置属于注入的根目录；仍删除原目录项，不把符号链接替换成其目标。
    fs::remove_dir_all(directory)
}

#[tauri::command]
pub(crate) fn import_data_backup(
    paths: tauri::State<'_, Arc<AppPaths>>,
    src_path: String,
) -> Result<String, String> {
    import(&paths, &src_path)
}

pub(crate) fn import(paths: &AppPaths, src_path: &str) -> Result<String, String> {
    let file = fs::File::open(src_path).map_err(|e| format!("打开备份失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析备份失败: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("备份条目过多".to_string());
    }

    let stage = paths
        .backups_dir()
        .join(format!("data-import-{}", uuid::Uuid::new_v4()));
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
            if entry.size() > MAX_ENTRY_BYTES
                || total.saturating_add(entry.size()) > MAX_TOTAL_BYTES
            {
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
        let staged_sessions = stage.join("sessions-v2.json");
        if staged_sessions.exists() {
            let session_document = serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&staged_sessions).map_err(|e| e.to_string())?,
            )
            .map_err(|_| "备份会话数据损坏".to_string())?;
            if session_document
                .get("schemaVersion")
                .and_then(|value| value.as_u64())
                != Some(2)
                || !session_document
                    .get("sessions")
                    .map(|value| value.is_array())
                    .unwrap_or(false)
                || !session_document
                    .get("currentSessionId")
                    .map(|value| value.is_string())
                    .unwrap_or(false)
            {
                return Err("备份会话格式不受支持".to_string());
            }
        }

        let recovery = paths
            .backups_dir()
            .join(format!("recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&recovery).map_err(|e| e.to_string())?;
        let chars = paths.characters_dir();
        copy_tree(chars, &recovery.join("characters"))?;
        if paths.sessions_v2_file().is_file() {
            fs::copy(paths.sessions_v2_file(), recovery.join("sessions-v2.json"))
                .map_err(|e| e.to_string())?;
        }

        if chars.exists() {
            remove_directory_in(chars, paths.characters_dir())
                .map_err(|e| format!("清理现有角色失败: {e}"))?;
        }
        let staged_chars = stage.join("characters");
        if staged_chars.exists() {
            copy_tree(&staged_chars, chars)?;
        } else {
            fs::create_dir_all(chars).map_err(|e| e.to_string())?;
        }
        if staged_sessions.exists() {
            fs::copy(&staged_sessions, paths.sessions_v2_file()).map_err(|e| e.to_string())?;
        } else if paths.sessions_v2_file().exists() {
            fs::remove_file(paths.sessions_v2_file()).map_err(|e| e.to_string())?;
        }
        Ok(settings)
    })();
    let _ = remove_directory_in(&stage, paths.backups_dir());
    result
}

#[tauri::command]
pub(crate) fn reset_all_local_data(paths: tauri::State<'_, Arc<AppPaths>>) -> Result<(), String> {
    reset(&paths, cfg!(debug_assertions))
}

/// 构建模式由命令适配层提供；测试与生产执行同一条删除路径。
pub(crate) fn reset(paths: &AppPaths, development_mode: bool) -> Result<(), String> {
    if development_mode {
        return Err("开发模式禁止一键清除，避免删除仓库中的角色资源".to_string());
    }
    let chars = paths.characters_dir();
    let logs = paths.logs_dir();
    let backups = paths.backups_dir();
    if chars.exists() {
        remove_directory_in(chars, paths.characters_dir())
            .map_err(|e| format!("删除角色失败: {e}"))?;
    }
    if paths.sessions_v2_file().exists() {
        fs::remove_file(paths.sessions_v2_file()).map_err(|e| format!("删除会话失败: {e}"))?;
    }
    if paths.legacy_sessions_file().exists() {
        fs::remove_file(paths.legacy_sessions_file())
            .map_err(|e| format!("删除旧会话备份失败: {e}"))?;
    }
    if logs.exists() {
        remove_directory_in(logs, paths.logs_dir()).map_err(|e| format!("删除日志失败: {e}"))?;
    }
    if backups.exists() {
        remove_directory_in(backups, paths.backups_dir())
            .map_err(|e| format!("删除缓存备份失败: {e}"))?;
    }
    fs::create_dir_all(chars).map_err(|e| e.to_string())?;
    fs::create_dir_all(logs).map_err(|e| e.to_string())?;
    fs::create_dir_all(backups).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Read;

    use crate::test_support::{TempAppPaths, TempDir};

    const SETTINGS: &str = "{\n  \"theme\": \"dark\",\n  \"language\": \"中文\"\n}\n";
    const SESSIONS: &str = r#"{"schemaVersion":2,"currentSessionId":"a","sessions":[{"id":"a"}]}"#;

    fn write_file(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn directory_contents(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        let mut contents = BTreeMap::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                if entry.file_type().unwrap().is_dir() {
                    contents.insert(relative, None);
                    pending.push(path);
                } else {
                    contents.insert(relative, Some(fs::read(path).unwrap()));
                }
            }
        }
        contents
    }

    fn archive_contents(path: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut contents = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            contents.insert(entry.name().to_string(), bytes);
        }
        contents
    }

    #[test]
    fn export_preserves_backup_format_and_excludes_private_data() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        write_file(
            paths.characters_dir().join("model/character.json"),
            r#"{"name":"角色 A"}"#,
        );
        write_file(
            paths.characters_dir().join("model/textures/texture.png"),
            [0, 1, 2, 255],
        );
        fs::create_dir(paths.characters_dir().join("empty")).unwrap();
        write_file(paths.sessions_v2_file(), SESSIONS);
        write_file(paths.legacy_sessions_file(), "旧会话不导出");
        write_file(paths.logs_dir().join("app.jsonl"), "日志不导出");
        write_file(
            paths.backups_dir().join("checkpoint/original.txt"),
            "检查点不导出",
        );
        write_file(paths.workspace_grants_file(), "授权不导出");
        write_file(
            paths.execution_output_dir().join("output.txt"),
            "执行输出不导出",
        );
        write_file(paths.sessions_dir().join("credentials.json"), "凭据不导出");
        let output = TempDir::new();
        let backup = output.path().join("nested/data.zip");

        export(paths, backup.to_str().unwrap(), SETTINGS).unwrap();

        let contents = archive_contents(&backup);
        assert_eq!(
            contents.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "characters/",
                "characters/empty/",
                "characters/model/",
                "characters/model/character.json",
                "characters/model/textures/",
                "characters/model/textures/texture.png",
                "manifest.json",
                "sessions-v2.json",
                "settings.json",
            ]
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&contents["manifest.json"]).unwrap(),
            serde_json::json!({
                "format_version": 2,
                "app_version": env!("CARGO_PKG_VERSION"),
                "includes_secrets": false,
            })
        );
        assert_eq!(contents["settings.json"], SETTINGS.as_bytes());
        assert_eq!(contents["sessions-v2.json"], SESSIONS.as_bytes());
        assert_eq!(
            contents["characters/model/character.json"],
            r#"{"name":"角色 A"}"#.as_bytes()
        );
        assert_eq!(
            contents["characters/model/textures/texture.png"],
            [0, 1, 2, 255]
        );
    }

    #[test]
    fn export_then_import_roundtrips_characters_sessions_and_settings() {
        let source = TempAppPaths::new();
        write_file(
            source.paths().characters_dir().join("model/character.json"),
            r#"{"name":"角色"}"#,
        );
        write_file(
            source.paths().characters_dir().join("model/texture.png"),
            [0, 255, 7, 8],
        );
        fs::create_dir(source.paths().characters_dir().join("empty")).unwrap();
        write_file(source.paths().sessions_v2_file(), SESSIONS);
        let source_before = directory_contents(source.root());
        let output = TempDir::new();
        let backup = output.path().join("data.zip");
        let destination = TempAppPaths::new();

        export(source.paths(), backup.to_str().unwrap(), SETTINGS).unwrap();
        let settings = import(destination.paths(), backup.to_str().unwrap()).unwrap();

        assert_eq!(settings, SETTINGS);
        assert_eq!(
            directory_contents(destination.paths().characters_dir()),
            directory_contents(source.paths().characters_dir())
        );
        assert_eq!(
            fs::read_to_string(destination.paths().sessions_v2_file()).unwrap(),
            SESSIONS
        );
        assert_eq!(directory_contents(source.root()), source_before);
        assert!(fs::read_dir(destination.paths().backups_dir())
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("data-import-")
            }));
    }

    const MANIFEST: &str = r#"{"format_version":2,"app_version":"test","includes_secrets":false}"#;

    fn write_archive(path: &Path, entries: &[(&str, &str)]) {
        let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, contents) in entries {
            archive
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn import_preserves_recovery_and_does_not_change_another_state() {
        let target = TempAppPaths::new();
        let other = TempAppPaths::new();
        for fixture in [&target, &other] {
            write_file(
                fixture.paths().characters_dir().join("old/character.json"),
                "原角色",
            );
            write_file(fixture.paths().sessions_v2_file(), SESSIONS);
            write_file(fixture.paths().workspace_grants_file(), "独立授权");
            write_file(fixture.paths().logs_dir().join("app.jsonl"), "原日志");
        }
        let other_before = directory_contents(other.root());
        let old_characters = directory_contents(target.paths().characters_dir());
        let output = TempDir::new();
        let backup = output.path().join("replace.zip");
        write_archive(
            &backup,
            &[
                ("manifest.json", MANIFEST),
                ("settings.json", SETTINGS),
                ("characters/new/character.json", "新角色"),
            ],
        );

        assert_eq!(
            import(target.paths(), backup.to_str().unwrap()).unwrap(),
            SETTINGS
        );

        assert_eq!(
            fs::read_to_string(target.paths().characters_dir().join("new/character.json")).unwrap(),
            "新角色"
        );
        assert!(!target.paths().characters_dir().join("old").exists());
        assert!(!target.paths().sessions_v2_file().exists());
        let recoveries: Vec<_> = fs::read_dir(target.paths().backups_dir())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("recovery-")
            })
            .collect();
        assert_eq!(recoveries.len(), 1);
        assert_eq!(
            directory_contents(&recoveries[0].join("characters")),
            old_characters
        );
        assert_eq!(
            fs::read_to_string(recoveries[0].join("sessions-v2.json")).unwrap(),
            SESSIONS
        );
        assert_eq!(
            fs::read_to_string(target.paths().workspace_grants_file()).unwrap(),
            "独立授权"
        );
        assert_eq!(
            fs::read_to_string(target.paths().logs_dir().join("app.jsonl")).unwrap(),
            "原日志"
        );
        assert_eq!(directory_contents(other.root()), other_before);
    }

    #[test]
    fn invalid_archives_leave_existing_data_unchanged_and_remove_staging() {
        let target = TempAppPaths::new();
        write_file(
            target.paths().characters_dir().join("model/character.json"),
            "原角色",
        );
        write_file(target.paths().sessions_v2_file(), SESSIONS);
        write_file(target.paths().workspace_grants_file(), "原授权");
        let before = directory_contents(target.root());
        let output = TempDir::new();
        let backup = output.path().join("invalid.zip");
        let cases = [
            vec![("settings.json", SETTINGS)],
            vec![
                ("manifest.json", "损坏的 JSON"),
                ("settings.json", SETTINGS),
            ],
            vec![
                (
                    "manifest.json",
                    r#"{"format_version":1,"app_version":"test","includes_secrets":false}"#,
                ),
                ("settings.json", SETTINGS),
            ],
            vec![
                (
                    "manifest.json",
                    r#"{"format_version":2,"app_version":"test","includes_secrets":true}"#,
                ),
                ("settings.json", SETTINGS),
            ],
            vec![("manifest.json", MANIFEST), ("settings.json", "[]")],
            vec![
                ("manifest.json", MANIFEST),
                ("settings.json", SETTINGS),
                ("sessions-v2.json", "{}"),
            ],
            vec![
                ("manifest.json", MANIFEST),
                ("settings.json", SETTINGS),
                ("logs/app.jsonl", "不能导入日志"),
            ],
            vec![
                ("manifest.json", MANIFEST),
                ("settings.json", SETTINGS),
                ("../outside.txt", "不能逃逸"),
            ],
        ];
        for entries in cases {
            write_archive(&backup, &entries);
            assert!(
                import(target.paths(), backup.to_str().unwrap()).is_err(),
                "应拒绝条目 {entries:?}"
            );
            assert_eq!(directory_contents(target.root()), before);
        }
        fs::write(&backup, "不是 ZIP").unwrap();
        assert!(import(target.paths(), backup.to_str().unwrap())
            .unwrap_err()
            .contains("解析备份失败"));
        assert_eq!(directory_contents(target.root()), before);
        assert!(!target.root().join("outside.txt").exists());
    }

    #[test]
    fn export_rejects_invalid_settings_and_unavailable_destination() {
        let source = TempAppPaths::new();
        let output = TempDir::new();
        let backup = output.path().join("data.zip");
        for settings in ["无效 JSON", "[]"] {
            assert!(export(source.paths(), backup.to_str().unwrap(), settings).is_err());
            assert!(!backup.exists());
        }
        assert!(export(
            source.paths(),
            backup.to_str().unwrap(),
            &" ".repeat(MAX_SETTINGS_BYTES + 1)
        )
        .unwrap_err()
        .contains("设置数据过大"));
        assert!(export(
            source.paths(),
            output.path().join("data.txt").to_str().unwrap(),
            SETTINGS
        )
        .unwrap_err()
        .contains(".zip"));
        let blocker = output.path().join("blocked");
        fs::write(&blocker, "文件不能作为父目录").unwrap();
        assert!(export(
            source.paths(),
            blocker.join("data.zip").to_str().unwrap(),
            SETTINGS
        )
        .unwrap_err()
        .contains("创建目标目录失败"));
    }

    #[test]
    fn import_reports_filesystem_failures_without_overwriting_existing_characters() {
        let source = TempAppPaths::new();
        let target = TempAppPaths::new();
        let output = TempDir::new();
        let backup = output.path().join("data.zip");
        export(source.paths(), backup.to_str().unwrap(), SETTINGS).unwrap();
        write_file(
            target.paths().characters_dir().join("model/character.json"),
            "原角色",
        );
        let before = directory_contents(target.paths().characters_dir());
        fs::remove_dir(target.paths().backups_dir()).unwrap();
        fs::write(target.paths().backups_dir(), "阻断暂存目录").unwrap();

        assert!(import(target.paths(), backup.to_str().unwrap()).is_err());
        assert_eq!(directory_contents(target.paths().characters_dir()), before);
        assert!(import(
            target.paths(),
            output.path().join("missing.zip").to_str().unwrap()
        )
        .unwrap_err()
        .contains("打开备份失败"));
    }

    #[test]
    fn reset_preserves_grants_credentials_outputs_and_other_state() {
        let target = TempAppPaths::new();
        let other = TempAppPaths::new();
        for fixture in [&target, &other] {
            let paths = fixture.paths();
            write_file(paths.characters_dir().join("model/character.json"), "角色");
            write_file(paths.logs_dir().join("app.jsonl"), "日志");
            write_file(
                paths.backups_dir().join("checkpoint/original.txt"),
                "检查点",
            );
            write_file(paths.sessions_v2_file(), SESSIONS);
            write_file(paths.legacy_sessions_file(), "旧会话");
            write_file(paths.workspace_grants_file(), "保留授权");
            write_file(paths.sessions_dir().join("credentials.json"), "保留凭据");
            write_file(
                paths.execution_output_dir().join("output.txt"),
                "保留执行输出",
            );
        }
        let other_before = directory_contents(other.root());

        reset(target.paths(), false).unwrap();

        for directory in [
            target.paths().characters_dir(),
            target.paths().logs_dir(),
            target.paths().backups_dir(),
        ] {
            assert!(directory.is_dir());
            assert!(directory_contents(directory).is_empty());
        }
        assert!(!target.paths().sessions_v2_file().exists());
        assert!(!target.paths().legacy_sessions_file().exists());
        assert_eq!(
            fs::read_to_string(target.paths().workspace_grants_file()).unwrap(),
            "保留授权"
        );
        assert_eq!(
            fs::read_to_string(target.paths().sessions_dir().join("credentials.json")).unwrap(),
            "保留凭据"
        );
        assert_eq!(
            fs::read_to_string(target.paths().execution_output_dir().join("output.txt")).unwrap(),
            "保留执行输出"
        );
        assert_eq!(directory_contents(other.root()), other_before);
    }

    #[test]
    fn development_reset_is_rejected_before_any_filesystem_change() {
        let target = TempAppPaths::new();
        write_file(
            target.paths().characters_dir().join("model/character.json"),
            "开发角色",
        );
        write_file(target.paths().sessions_v2_file(), SESSIONS);
        let before = directory_contents(target.root());

        assert!(reset(target.paths(), true)
            .unwrap_err()
            .contains("开发模式禁止一键清除"));
        assert_eq!(directory_contents(target.root()), before);
    }

    #[test]
    fn reset_reports_unavailable_session_target_and_preserves_unrelated_files() {
        let target = TempAppPaths::new();
        fs::create_dir(target.paths().sessions_v2_file()).unwrap();
        write_file(target.paths().workspace_grants_file(), "保留授权");

        assert!(reset(target.paths(), false)
            .unwrap_err()
            .contains("删除会话失败"));
        assert!(target.paths().sessions_v2_file().is_dir());
        assert_eq!(
            fs::read_to_string(target.paths().workspace_grants_file()).unwrap(),
            "保留授权"
        );
    }

    #[test]
    fn backup_paths_are_allowlisted() {
        assert!(allowed_backup_path(Path::new("manifest.json")));
        assert!(allowed_backup_path(Path::new("sessions-v2.json")));
        assert!(allowed_backup_path(Path::new(
            "characters/a/character.json"
        )));
        assert!(!allowed_backup_path(Path::new("sessions.json")));
        assert!(!allowed_backup_path(Path::new("logs/app.jsonl")));
        assert!(!allowed_backup_path(Path::new("../secret")));
    }
}
