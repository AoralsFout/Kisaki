//! 角色包导入导出的显式目录业务及薄命令适配器。

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::app_paths::AppPaths;
use crate::path::sanitize_path_component;

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
            return Err(format!("条目过大（超过 {} MiB 上限）", cap / (1024 * 1024)));
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
pub(crate) fn export_character_pack(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    dest_path: String,
) -> Result<(), String> {
    export(&paths, &id, &dest_path)
}

pub(crate) fn export(paths: &AppPaths, id: &str, dest_path: &str) -> Result<(), String> {
    sanitize_path_component(id)?;
    let base = paths.characters_dir();
    let char_dir = base.join(id);
    if !char_dir.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }

    // 防御性校验目标路径（正常由前端 dialog 传入）
    let dest = PathBuf::from(dest_path);
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
    zip_dir_recursive(&mut zip, base, &char_dir, options)?;
    zip.finish()
        .map_err(|e| format!("完成角色包写入失败: {}", e))?;
    Ok(())
}

/// 从 zip 角色包导入角色到 characters_dir。
/// 冲突策略：跳过已存在的角色 id（保护用户已改过的角色）。
/// 角色 id 取自每个 character.json 的 `id` 字段（回退到所在目录名）；
/// 兼容 `character.json` 在包根、`<id>/character.json`、`<前缀>/<id>/character.json` 等结构，
/// 以 character.json 所在目录为前缀重映射解压到 characters_dir/<id>。
/// 安全：enclosed_name 防 zip-slip；id 过 sanitize 校验；解压目标须在 characters_dir 内。
#[tauri::command]
pub(crate) fn import_character_pack(
    paths: tauri::State<'_, Arc<AppPaths>>,
    src_path: String,
) -> Result<ImportResult, String> {
    import(&paths, &src_path)
}

pub(crate) fn import(paths: &AppPaths, src_path: &str) -> Result<ImportResult, String> {
    let base = paths.characters_dir();
    fs::create_dir_all(base).map_err(|e| format!("创建角色目录失败: {}", e))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("解析角色目录失败: {}", e))?;

    let file = fs::File::open(src_path).map_err(|e| format!("打开角色包失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析角色包失败: {}", e))?;

    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "角色包条目过多（{} > {}），疑似恶意压缩包",
            archive.len(),
            MAX_ENTRIES
        ));
    }

    crate::log::write_native_log(
        "info",
        "Pack",
        format!("导入角色包: {}（{} 个条目）", src_path, archive.len()),
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
                crate::log::write_native_log(
                    "warn",
                    "Pack",
                    format!("跳过不安全条目: {}", raw_name),
                );
                continue;
            }
        };
        if sample_names.len() < 20 {
            sample_names.push(enclosed.to_string_lossy().replace('\\', "/"));
        }
        if !enclosed
            .file_name()
            .map(|f| f == "character.json")
            .unwrap_or(false)
        {
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
                crate::log::write_native_log(
                    "warn",
                    "Pack",
                    format!("character.json 读取失败，跳过: {}", e),
                );
                continue;
            }
        };
        let id_from_json = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| {
                v.get("id")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string())
            })
            .filter(|s| !s.is_empty());
        let id = match id_from_json.or_else(|| {
            enclosed
                .parent()
                .and_then(|p| p.file_name())
                .map(|os| os.to_string_lossy().to_string())
        }) {
            Some(id) => id,
            None => {
                crate::log::write_native_log(
                    "warn",
                    "Pack",
                    format!("{} 无 id 字段且位于包根，跳过", raw_name),
                );
                continue;
            }
        };
        crate::log::write_native_log(
            "debug",
            "Pack",
            format!("发现角色: id={} 前缀=\"{}\"", id, prefix.display()),
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
                    .is_none_or(|(_, cur)| rel.components().count() < cur.components().count());
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
    crate::log::write_native_log(
        "info",
        "Pack",
        format!("导入完成: imported={:?} skipped={:?}", imported, skipped),
    );
    Ok(ImportResult { imported, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::character;
    use crate::test_support::{TempAppPaths, TempDir};
    use std::io::Write;

    fn write_pack(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn import_skips_unsafe_entries_and_ids_without_writing_outside_the_character_directory() {
        let fixture = TempAppPaths::new();
        fs::write(fixture.root().join("outside.txt"), "目录外数据").unwrap();
        let source = fixture.root().join("source.zip");
        write_pack(
            &source,
            &[
                ("safe/character.json", br#"{"id":"safe"}"#),
                ("safe/prompt.txt", b"safe prompt"),
                ("safe/../../outside.txt", b"attack"),
                ("../outside.txt", b"attack"),
                ("../escaped/character.json", br#"{"id":"escaped"}"#),
                ("/absolute/character.json", br#"{"id":"absolute"}"#),
                ("evil/character.json", br#"{"id":"../escaped"}"#),
                ("slash/character.json", br#"{"id":"bad/id"}"#),
                ("backslash/character.json", br#"{"id":"bad\\id"}"#),
            ],
        );

        let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
        assert_eq!(result.imported, ["safe"]);
        assert_eq!(result.skipped, ["../escaped", "bad/id", r"bad\id"]);
        assert_eq!(
            character::read_file(fixture.paths(), "safe", "prompt.txt").unwrap(),
            "safe prompt"
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("outside.txt")).unwrap(),
            "目录外数据"
        );
        assert!(!fixture.root().join("escaped").exists());
        assert_eq!(
            fs::read_dir(fixture.paths().characters_dir())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn import_rejects_missing_malformed_and_manifestless_packs() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("应拒绝缺失的角色包");
        assert!(error.starts_with("打开角色包失败: "), "{error}");

        fs::write(&source, "不是 ZIP 文件").unwrap();
        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("应拒绝损坏的角色包");
        assert!(error.starts_with("解析角色包失败: "), "{error}");

        write_pack(&source, &[("readme.txt", b"no character")]);
        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("应拒绝没有角色清单的包");
        assert!(
            error.starts_with("角色包中未找到 <角色id>/character.json。"),
            "{error}"
        );
        assert!(error.contains("readme.txt"), "{error}");
        for config in ["{}", "not JSON", r#"{"id":"  "}"#] {
            write_pack(&source, &[("character.json", config.as_bytes())]);
            let error = import(fixture.paths(), &source.to_string_lossy())
                .err()
                .expect("根级清单必须给出 id");
            assert!(
                error.starts_with("角色包中未找到 <角色id>/character.json。"),
                "{error}"
            );
        }
        assert_eq!(
            fs::read_dir(fixture.paths().characters_dir())
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn oversized_manifests_are_skipped_without_blocking_other_characters() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        let mut oversized = br#"{"id":"oversized"}"#.to_vec();
        oversized.resize(MAX_MANIFEST_JSON_BYTES + 1, b' ');
        write_pack(
            &source,
            &[
                ("oversized/character.json", &oversized),
                ("good/character.json", br#"{"id":"good"}"#),
                ("good/prompt.txt", b"kept"),
            ],
        );
        let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
        assert_eq!(result.imported, ["good"]);
        assert!(result.skipped.is_empty());
        assert!(!fixture.paths().characters_dir().join("oversized").exists());
        assert_eq!(
            character::read_file(fixture.paths(), "good", "prompt.txt").unwrap(),
            "kept"
        );

        write_pack(&source, &[("oversized/character.json", &oversized)]);
        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("仅有超限清单时应拒绝导入");
        assert!(
            error.starts_with("角色包中未找到 <角色id>/character.json。"),
            "{error}"
        );
    }

    #[test]
    fn import_rejects_excessive_entry_counts_before_extracting_anything() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        let file = std::io::BufWriter::new(fs::File::create(&source).unwrap());
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for index in 0..=MAX_ENTRIES {
            writer
                .start_file(format!("empty/{index}"), options)
                .unwrap();
        }
        writer.finish().unwrap().flush().unwrap();

        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("应拒绝条目数超限的角色包");
        assert_eq!(error, "角色包条目过多（100001 > 100000），疑似恶意压缩包");
        assert_eq!(
            fs::read_dir(fixture.paths().characters_dir())
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn export_rejects_invalid_ids_missing_characters_and_unsafe_destinations() {
        let fixture = TempAppPaths::new();
        let destination = fixture.root().join("export.zip");
        for (id, expected) in [
            ("", "路径组件不能为空"),
            ("../outside", "路径组件不能包含 '..'"),
            ("nested/character", "路径组件不能包含分隔符"),
            (r"nested\character", "路径组件不能包含分隔符"),
            ("missing", "角色目录不存在: missing"),
        ] {
            assert_eq!(
                export(fixture.paths(), id, &destination.to_string_lossy()).unwrap_err(),
                expected
            );
        }
        assert!(!destination.exists());
        character::write_file(fixture.paths(), "kisaki", "character.json", "{}").unwrap();
        // 保留原始 '..' 入参，避免 Windows 的 \\?\ 路径在 join 时提前归一化。
        for suffix in ["bad..zip", "parent/../outside.zip"] {
            let destination = format!("{}/{suffix}", fixture.root().display());
            assert_eq!(
                export(fixture.paths(), "kisaki", &destination).unwrap_err(),
                "无效的导出路径"
            );
            assert!(!Path::new(&destination).exists());
        }
        fs::write(fixture.root().join("blocked"), "不是目录").unwrap();
        let error = export(
            fixture.paths(),
            "kisaki",
            &fixture.root().join("blocked/export.zip").to_string_lossy(),
        )
        .unwrap_err();
        assert!(error.starts_with("创建目标目录失败: "), "{error}");
        let error =
            export(fixture.paths(), "kisaki", &fixture.root().to_string_lossy()).unwrap_err();
        assert!(error.starts_with("创建角色包失败: "), "{error}");
    }

    #[test]
    fn import_recreates_a_missing_character_directory_but_rejects_an_unusable_one() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        write_pack(&source, &[("kisaki/character.json", br#"{"id":"kisaki"}"#)]);
        fs::remove_dir(fixture.paths().characters_dir()).unwrap();
        let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
        assert_eq!(result.imported, ["kisaki"]);
        assert_eq!(character::list(fixture.paths()).unwrap(), ["kisaki"]);

        character::delete(fixture.paths(), "kisaki").unwrap();
        fs::remove_dir(fixture.paths().characters_dir()).unwrap();
        fs::write(fixture.paths().characters_dir(), "不是目录").unwrap();
        let error = import(fixture.paths(), &source.to_string_lossy())
            .err()
            .expect("应报告不可用的角色目录");
        assert!(error.starts_with("创建角色目录失败: "), "{error}");
        assert_eq!(
            fs::read_to_string(fixture.paths().characters_dir()).unwrap(),
            "不是目录"
        );
    }

    #[test]
    fn independent_paths_export_only_their_own_same_named_character() {
        let first = TempAppPaths::new();
        let second = TempAppPaths::new();
        for (fixture, prompt) in [(&first, "第一套人设"), (&second, "第二套人设")] {
            character::write_file(
                fixture.paths(),
                "shared",
                "character.json",
                r#"{"id":"shared"}"#,
            )
            .unwrap();
            character::write_file(fixture.paths(), "shared", "prompt.txt", prompt).unwrap();
        }
        let first_pack = first.root().join("shared.zip");
        let second_pack = second.root().join("shared.zip");
        std::thread::scope(|scope| {
            scope.spawn(|| export(first.paths(), "shared", &first_pack.to_string_lossy()).unwrap());
            scope.spawn(|| {
                export(second.paths(), "shared", &second_pack.to_string_lossy()).unwrap()
            });
        });
        let read_prompt = |path: &Path| {
            let mut archive = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
            let mut prompt = String::new();
            archive
                .by_name("shared/prompt.txt")
                .unwrap()
                .read_to_string(&mut prompt)
                .unwrap();
            prompt
        };
        assert_eq!(read_prompt(&first_pack), "第一套人设");
        assert_eq!(read_prompt(&second_pack), "第二套人设");

        character::write_file(first.paths(), "shared", "prompt.txt", "更新第一套").unwrap();
        export(first.paths(), "shared", &first_pack.to_string_lossy()).unwrap();
        assert_eq!(read_prompt(&first_pack), "更新第一套");
        assert_eq!(read_prompt(&second_pack), "第二套人设");
        assert_eq!(
            character::read_file(second.paths(), "shared", "prompt.txt").unwrap(),
            "第二套人设"
        );
    }

    #[test]
    fn import_skips_existing_directories_and_preserves_user_changes() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::create_dir(paths.characters_dir().join("alpha")).unwrap();
        character::write_file(paths, "beta", "character.json", "本地配置").unwrap();
        character::write_file(paths, "beta", "prompt.txt", "用户人设").unwrap();
        character::save_image(paths, "beta", "portrait.png", "AQID").unwrap();
        let source = fixture.root().join("source.zip");
        write_pack(
            &source,
            &[
                ("gamma/character.json", br#"{"id":"gamma"}"#),
                ("gamma/prompt.txt", b"new"),
                ("beta/character.json", br#"{"id":"beta"}"#),
                ("beta/prompt.txt", b"replacement"),
                ("beta/images/portrait.png", b"replacement"),
                ("alpha/character.json", br#"{"id":"alpha"}"#),
            ],
        );

        let result = import(paths, &source.to_string_lossy()).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"imported": ["gamma"], "skipped": ["alpha", "beta"]})
        );
        assert_eq!(
            fs::read_dir(paths.characters_dir().join("alpha"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            character::read_file(paths, "beta", "character.json").unwrap(),
            "本地配置"
        );
        assert_eq!(
            character::read_file(paths, "beta", "prompt.txt").unwrap(),
            "用户人设"
        );
        assert_eq!(
            fs::read(paths.characters_dir().join("beta/images/portrait.png")).unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            character::read_file(paths, "gamma", "prompt.txt").unwrap(),
            "new"
        );
    }

    #[test]
    fn import_supports_root_and_prefixed_layouts_and_manifest_id_fallbacks() {
        for (manifest, prompt, config, id) in [
            (
                "character.json",
                "prompt.txt",
                r#"{"id":"  canonical  "}"#,
                "canonical",
            ),
            ("folder/character.json", "folder/prompt.txt", "{}", "folder"),
            (
                "prefix/source/character.json",
                "prefix/source/prompt.txt",
                r#"{"id":"canonical"}"#,
                "canonical",
            ),
            (
                "broken/character.json",
                "broken/prompt.txt",
                "not JSON",
                "broken",
            ),
            (
                "blank/character.json",
                "blank/prompt.txt",
                r#"{"id":"  "}"#,
                "blank",
            ),
            (
                "numeric/character.json",
                "numeric/prompt.txt",
                r#"{"id":42}"#,
                "numeric",
            ),
        ] {
            let fixture = TempAppPaths::new();
            let source = fixture.root().join("source.zip");
            write_pack(
                &source,
                &[
                    (manifest, config.as_bytes()),
                    (prompt, "角色人设".as_bytes()),
                ],
            );

            let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
            assert_eq!(result.imported, [id]);
            assert!(result.skipped.is_empty());
            assert_eq!(
                character::read_file(fixture.paths(), id, "character.json").unwrap(),
                config
            );
            assert_eq!(
                character::read_file(fixture.paths(), id, "prompt.txt").unwrap(),
                "角色人设"
            );
            assert_eq!(character::list(fixture.paths()).unwrap(), [id]);
        }
    }

    #[test]
    fn import_assigns_nested_entries_to_the_most_specific_character_root() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        write_pack(
            &source,
            &[
                ("character.json", br#"{"id":"root"}"#),
                ("prompt.txt", b"root prompt"),
                ("nested/character.json", br#"{"id":"child"}"#),
                ("nested/prompt.txt", b"child prompt"),
                ("nested/images/portrait.png", &[0, 255]),
            ],
        );

        let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
        assert_eq!(result.imported, ["child", "root"]);
        assert!(result.skipped.is_empty());
        assert_eq!(
            character::read_file(fixture.paths(), "root", "prompt.txt").unwrap(),
            "root prompt"
        );
        assert_eq!(
            character::read_file(fixture.paths(), "child", "prompt.txt").unwrap(),
            "child prompt"
        );
        assert_eq!(
            fs::read(
                fixture
                    .paths()
                    .characters_dir()
                    .join("child/images/portrait.png")
            )
            .unwrap(),
            [0, 255]
        );
        assert!(!fixture
            .paths()
            .characters_dir()
            .join("root/nested")
            .exists());
    }

    #[test]
    fn duplicate_manifest_ids_keep_the_last_archive_prefix() {
        let fixture = TempAppPaths::new();
        let source = fixture.root().join("source.zip");
        write_pack(
            &source,
            &[
                ("first/character.json", br#"{"id":"shared"}"#),
                ("first/only-first.txt", b"first"),
                ("last/character.json", br#"{"id":"shared"}"#),
                ("last/prompt.txt", b"last"),
            ],
        );

        let result = import(fixture.paths(), &source.to_string_lossy()).unwrap();
        assert_eq!(result.imported, ["shared"]);
        assert!(result.skipped.is_empty());
        assert_eq!(
            character::read_file(fixture.paths(), "shared", "prompt.txt").unwrap(),
            "last"
        );
        assert!(!fixture
            .paths()
            .characters_dir()
            .join("shared/only-first.txt")
            .exists());
    }

    #[test]
    fn character_pack_roundtrip_preserves_layout_configuration_and_binary_assets() {
        let source = TempAppPaths::new();
        let target = TempAppPaths::new();
        let incoming = TempDir::new();
        let model = incoming.path().join("Model");
        fs::create_dir_all(model.join("textures")).unwrap();
        fs::create_dir(model.join("empty")).unwrap();
        fs::write(model.join("Model.model3.json"), r#"{"Version":3}"#).unwrap();
        fs::write(model.join("textures/texture.png"), [0, 255, 128]).unwrap();
        let config = r#"{"id":"kisaki","name":"妃咲","render":"live2d","live2d":{"model":"live2d/Model/Model.model3.json"}}"#;
        character::write_file(source.paths(), "kisaki", "character.json", config).unwrap();
        character::write_file(source.paths(), "kisaki", "prompt.txt", "角色人设\n第二行").unwrap();
        character::save_image(source.paths(), "kisaki", "portrait.png", "AQID").unwrap();
        character::import_live2d(source.paths(), "kisaki", &model.to_string_lossy()).unwrap();

        let destination = source.root().join("exports/nested/kisaki.zip");
        export(source.paths(), "kisaki", &destination.to_string_lossy()).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&destination).unwrap()).unwrap();
        let mut names: Vec<_> = archive.file_names().map(str::to_owned).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "kisaki/",
                "kisaki/character.json",
                "kisaki/images/",
                "kisaki/images/portrait.png",
                "kisaki/live2d/",
                "kisaki/live2d/Model/",
                "kisaki/live2d/Model/Model.model3.json",
                "kisaki/live2d/Model/empty/",
                "kisaki/live2d/Model/textures/",
                "kisaki/live2d/Model/textures/texture.png",
                "kisaki/prompt.txt",
            ]
        );
        assert_eq!(
            archive.by_name("kisaki/prompt.txt").unwrap().compression(),
            zip::CompressionMethod::Deflated
        );
        drop(archive);

        let result = import(target.paths(), &destination.to_string_lossy()).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"imported": ["kisaki"], "skipped": []})
        );
        assert_eq!(
            character::read_file(target.paths(), "kisaki", "character.json").unwrap(),
            config
        );
        assert_eq!(
            character::read_file(target.paths(), "kisaki", "prompt.txt").unwrap(),
            "角色人设\n第二行"
        );
        assert_eq!(character::list(target.paths()).unwrap(), ["kisaki"]);
        let imported = target.root().join("characters/kisaki");
        assert_eq!(
            fs::read(imported.join("images/portrait.png")).unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(imported.join("live2d/Model/Model.model3.json")).unwrap(),
            r#"{"Version":3}"#
        );
        assert_eq!(
            fs::read(imported.join("live2d/Model/textures/texture.png")).unwrap(),
            [0, 255, 128]
        );
        assert!(imported.join("live2d/Model/empty").is_dir());
    }

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
        const {
            assert!(MAX_ENTRY_BYTES > 0);
            assert!(MAX_TOTAL_BYTES > MAX_ENTRY_BYTES);
            assert!(MAX_ENTRIES > 1000);
        }
    }
}
