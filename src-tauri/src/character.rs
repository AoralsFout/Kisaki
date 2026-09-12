//! 角色文件、图片与 Live2D 的显式目录业务及薄命令适配器。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::app_paths::AppPaths;
use crate::path::{safe_join, sanitize_path_component};

/** 写入角色配置文件 */
/// filename 如 "character.json" 或 "prompt.txt"
#[tauri::command]
pub(crate) fn write_character_file(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    write_file(&paths, &id, &filename, &content)
}

pub(crate) fn write_file(
    paths: &AppPaths,
    id: &str,
    filename: &str,
    content: &str,
) -> Result<(), String> {
    sanitize_path_component(id)?;
    let base = paths.characters_dir().join(id);
    fs::create_dir_all(&base).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&base, filename)?;
    fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 保存上传的立绘图片
/// data_base64: 图片的 base64 数据（不含 data:image/... 前缀）
#[tauri::command]
pub(crate) fn save_character_image(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    filename: String,
    data_base64: String,
) -> Result<(), String> {
    save_image(&paths, &id, &filename, &data_base64)
}

pub(crate) fn save_image(
    paths: &AppPaths,
    id: &str,
    filename: &str,
    data_base64: &str,
) -> Result<(), String> {
    sanitize_path_component(id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let dir = paths.characters_dir().join(id).join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&dir, filename)?;
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    Ok(())
}

/// 删除角色的立绘图片文件
#[tauri::command]
pub(crate) fn delete_character_image(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    filename: String,
) -> Result<(), String> {
    delete_image(&paths, &id, &filename)
}

pub(crate) fn delete_image(paths: &AppPaths, id: &str, filename: &str) -> Result<(), String> {
    sanitize_path_component(id)?;
    let dir = paths.characters_dir().join(id).join("images");
    // 先确保目录存在，safe_join 需要 canonicalize 基目录
    if !dir.exists() {
        return Ok(());
    }
    let path = safe_join(&dir, filename)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除图片失败: {}", e))?;
    }
    Ok(())
}

/// 删除整个角色目录（含所有图片和配置文件）
#[tauri::command]
pub(crate) fn delete_character(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
) -> Result<(), String> {
    delete(&paths, &id)
}

pub(crate) fn delete(paths: &AppPaths, id: &str) -> Result<(), String> {
    sanitize_path_component(id)?;
    let verified_path = safe_join(paths.characters_dir(), id)?;
    if !verified_path.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }
    fs::remove_dir_all(&verified_path).map_err(|e| format!("删除角色目录失败: {}", e))?;
    Ok(())
}

/// 扫描 characters 目录，返回所有有效角色 ID（含 character.json 的子目录）。
/// dev 模式指向 <项目>/characters/；生产模式指向 app_data_dir/characters/。
/// 不再有预置 fallback：目录为空即返回空列表。
#[tauri::command]
pub(crate) fn list_characters(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<Vec<String>, String> {
    list(&paths)
}

pub(crate) fn list(paths: &AppPaths) -> Result<Vec<String>, String> {
    let dir = paths.characters_dir();
    let mut result: Vec<String> = Vec::new();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Some(name) = entry.file_name().to_str() {
                        if entry.path().join("character.json").exists() {
                            result.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    result.sort();
    Ok(result)
}

/// 角色列表所需的轻量元数据。列表页不需要提示词、图片清单等完整配置。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CharacterSummary {
    id: String,
    name: Option<String>,
    render: Option<String>,
}

#[derive(Deserialize)]
struct CharacterSummaryConfig {
    name: Option<String>,
    render: Option<String>,
}

/// 一次扫描返回角色 ID 及列表元数据，避免前端为每个角色分别读取完整配置和 prompt.txt。
#[tauri::command]
pub(crate) fn list_character_summaries(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<Vec<CharacterSummary>, String> {
    list_summaries(&paths)
}

pub(crate) fn list_summaries(paths: &AppPaths) -> Result<Vec<CharacterSummary>, String> {
    let dir = paths.characters_dir();
    let mut result: Vec<CharacterSummary> = Vec::new();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let config_path = entry.path().join("character.json");
                if !config_path.exists() {
                    continue;
                }
                let config = fs::read_to_string(config_path)
                    .ok()
                    .and_then(|text| serde_json::from_str::<CharacterSummaryConfig>(&text).ok());
                result.push(CharacterSummary {
                    id,
                    name: config.as_ref().and_then(|data| data.name.clone()),
                    render: config.and_then(|data| data.render),
                });
            }
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

/// 返回前端需要的数据目录路径（characters、logs）
#[tauri::command]
pub(crate) fn get_data_dirs(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<serde_json::Value, String> {
    data_dirs(&paths)
}

pub(crate) fn data_dirs(paths: &AppPaths) -> Result<serde_json::Value, String> {
    // 保留查询目录时尽力创建日志目录的既有行为。
    let _ = fs::create_dir_all(paths.logs_dir());
    Ok(serde_json::json!({
        "characters": paths.characters_dir().to_string_lossy(),
        "logs": paths.logs_dir().to_string_lossy(),
    }))
}

/// 仅扫描 data_dir 下的角色（不含预置列表），供前端判断哪些角色有本地文件
#[tauri::command]
pub(crate) fn list_data_dir_characters(
    paths: tauri::State<'_, Arc<AppPaths>>,
) -> Result<Vec<String>, String> {
    list_data_characters(&paths)
}

pub(crate) fn list_data_characters(paths: &AppPaths) -> Result<Vec<String>, String> {
    let dir = paths.characters_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    if entry.path().join("character.json").exists() {
                        result.push(name.to_string());
                    }
                }
            }
        }
    }
    result.sort();
    Ok(result)
}

/// 读取角色目录下的文件（character.json / prompt.txt 等）
/// 返回文件内容字符串
#[tauri::command]
pub(crate) fn read_character_file(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    filename: String,
) -> Result<String, String> {
    read_file(&paths, &id, &filename)
}

pub(crate) fn read_file(paths: &AppPaths, id: &str, filename: &str) -> Result<String, String> {
    sanitize_path_component(id)?;
    let path = safe_join(&paths.characters_dir().join(id), filename)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", filename));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 递归二进制拷贝目录（保留子目录结构，如贴图 xxx.2048/、motions/）
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("遍历源目录失败: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("拷贝文件失败: {}", e))?;
        }
        // 符号链接等其它类型忽略
    }
    Ok(())
}

/// 判断文件名是否为 *.model3.json
fn is_model3(p: &Path) -> bool {
    p.is_file()
        && p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".model3.json"))
            .unwrap_or(false)
}

/// 在目录中查找 *.model3.json（先顶层，再下一层子目录），返回相对 root 的路径
fn find_model3(root: &Path) -> Option<PathBuf> {
    // 顶层
    if let Ok(entries) = fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if is_model3(&p) {
                return p.file_name().map(PathBuf::from);
            }
        }
    }
    // 下一层子目录
    if let Ok(entries) = fs::read_dir(root) {
        for e in entries.flatten() {
            let dir = e.path();
            if dir.is_dir() {
                if let Ok(sub) = fs::read_dir(&dir) {
                    for se in sub.flatten() {
                        let sp = se.path();
                        if is_model3(&sp) {
                            let dname = dir.file_name()?;
                            let fname = sp.file_name()?;
                            return Some(PathBuf::from(dname).join(fname));
                        }
                    }
                }
            }
        }
    }
    None
}

/// 导入 Live2D 模型文件夹到 characters/<id>/live2d/<模型名>/。
/// 返回 model3.json 相对角色目录的路径（如 "live2d/Hiyori/Hiyori.model3.json"，正斜杠）。
/// 同名模型已存在则报错（不覆盖）。
#[tauri::command]
pub(crate) fn import_live2d_model(
    paths: tauri::State<'_, Arc<AppPaths>>,
    id: String,
    src_dir: String,
) -> Result<String, String> {
    import_live2d(&paths, &id, &src_dir)
}

pub(crate) fn import_live2d(paths: &AppPaths, id: &str, src_dir: &str) -> Result<String, String> {
    sanitize_path_component(id)?;
    let src = PathBuf::from(src_dir);
    if !src.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }

    // 校验是有效 Live2D 模型（含 model3.json）
    let model_rel_in_src = find_model3(&src)
        .ok_or_else(|| "该文件夹内未找到 *.model3.json，不是有效的 Live2D 模型".to_string())?;

    // 模型名 = 源文件夹名（作为目标子目录名）
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法识别模型文件夹名".to_string())?
        .to_string();
    sanitize_path_component(&name)?;

    // 目标 characters/<id>/live2d/<name>/
    let live2d_dir = paths.characters_dir().join(id).join("live2d");
    fs::create_dir_all(&live2d_dir).map_err(|e| format!("创建 live2d 目录失败: {}", e))?;
    let dest = safe_join(&live2d_dir, &name)?;
    if dest.exists() {
        return Err(format!("已存在同名模型「{}」，请改名或先删除旧模型", name));
    }

    copy_dir_all(&src, &dest)?;

    // 返回相对角色目录的 model3.json 路径（正斜杠，供前端 live2d.model 使用）
    let rel = PathBuf::from("live2d").join(&name).join(&model_rel_in_src);
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{TempAppPaths, TempDir};

    #[test]
    fn independent_paths_isolate_same_named_character_images_and_live2d_models() {
        let first = TempAppPaths::new();
        let second = TempAppPaths::new();
        let first_src = first.root().join("incoming/Model");
        let second_src = second.root().join("incoming/Model");
        for (src, bytes) in [(&first_src, b"first"), (&second_src, b"other")] {
            fs::create_dir_all(src).unwrap();
            fs::write(src.join("Model.model3.json"), "{}").unwrap();
            fs::write(src.join("Model.moc3"), bytes).unwrap();
        }
        let populate = |paths: &AppPaths, src: &Path, name: &str, image: &str| {
            let config = serde_json::json!({"name": name, "render": "live2d"}).to_string();
            write_file(paths, "shared", "character.json", &config).unwrap();
            write_file(paths, "shared", "prompt.txt", name).unwrap();
            save_image(paths, "shared", "portrait.png", image).unwrap();
            assert_eq!(
                import_live2d(paths, "shared", &src.to_string_lossy()).unwrap(),
                "live2d/Model/Model.model3.json"
            );
        };
        std::thread::scope(|scope| {
            scope.spawn(|| populate(first.paths(), &first_src, "第一套", "AQID"));
            scope.spawn(|| populate(second.paths(), &second_src, "第二套", "BAUG"));
        });

        assert_eq!(
            read_file(first.paths(), "shared", "prompt.txt").unwrap(),
            "第一套"
        );
        assert_eq!(
            read_file(second.paths(), "shared", "prompt.txt").unwrap(),
            "第二套"
        );
        assert_eq!(
            serde_json::to_value(list_summaries(first.paths()).unwrap()).unwrap()[0]["name"],
            "第一套"
        );
        assert_eq!(
            serde_json::to_value(list_summaries(second.paths()).unwrap()).unwrap()[0]["name"],
            "第二套"
        );
        assert_eq!(
            fs::read(
                first
                    .paths()
                    .characters_dir()
                    .join("shared/images/portrait.png")
            )
            .unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            fs::read(
                second
                    .paths()
                    .characters_dir()
                    .join("shared/images/portrait.png")
            )
            .unwrap(),
            [4, 5, 6]
        );
        assert_eq!(
            fs::read(
                first
                    .paths()
                    .characters_dir()
                    .join("shared/live2d/Model/Model.moc3")
            )
            .unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(
                second
                    .paths()
                    .characters_dir()
                    .join("shared/live2d/Model/Model.moc3")
            )
            .unwrap(),
            b"other"
        );

        delete_image(first.paths(), "shared", "portrait.png").unwrap();
        delete(first.paths(), "shared").unwrap();
        assert!(list(first.paths()).unwrap().is_empty());
        assert_eq!(list(second.paths()).unwrap(), ["shared"]);
        assert_eq!(list_data_characters(second.paths()).unwrap(), ["shared"]);
        assert_eq!(
            read_file(second.paths(), "shared", "prompt.txt").unwrap(),
            "第二套"
        );
        assert_eq!(
            fs::read(
                second
                    .paths()
                    .characters_dir()
                    .join("shared/images/portrait.png")
            )
            .unwrap(),
            [4, 5, 6]
        );
        assert!(second
            .paths()
            .characters_dir()
            .join("shared/live2d/Model/Model.model3.json")
            .is_file());
    }

    #[test]
    fn live2d_import_finds_a_model_one_directory_below_the_source() {
        let fixture = TempAppPaths::new();
        let source = TempDir::new();
        let src = source.path().join("Model");
        fs::create_dir_all(src.join("runtime/textures")).unwrap();
        fs::write(src.join("runtime/Model.model3.json"), "{}").unwrap();
        fs::write(src.join("runtime/textures/texture.png"), [255, 0]).unwrap();

        let relative = import_live2d(fixture.paths(), "kisaki", &src.to_string_lossy()).unwrap();
        assert_eq!(relative, "live2d/Model/runtime/Model.model3.json");
        assert!(fixture
            .paths()
            .characters_dir()
            .join("kisaki")
            .join(relative)
            .is_file());
        assert_eq!(
            fs::read(
                fixture
                    .root()
                    .join("characters/kisaki/live2d/Model/runtime/textures/texture.png")
            )
            .unwrap(),
            [255, 0]
        );
    }

    #[test]
    fn live2d_import_rejects_missing_invalid_and_unsafe_sources() {
        let fixture = TempAppPaths::new();
        let source = TempDir::new();
        let file = source.path().join("file");
        fs::write(&file, "不是文件夹").unwrap();
        for src in [source.path().join("missing"), file] {
            assert_eq!(
                import_live2d(fixture.paths(), "kisaki", &src.to_string_lossy()).unwrap_err(),
                "所选路径不是文件夹"
            );
        }
        let empty = source.path().join("empty");
        let deep = source.path().join("deep");
        fs::create_dir(&empty).unwrap();
        fs::create_dir_all(deep.join("level1/level2")).unwrap();
        fs::write(deep.join("level1/level2/Model.model3.json"), "{}").unwrap();
        for src in [empty, deep] {
            assert_eq!(
                import_live2d(fixture.paths(), "kisaki", &src.to_string_lossy()).unwrap_err(),
                "该文件夹内未找到 *.model3.json，不是有效的 Live2D 模型"
            );
        }
        let unsafe_name = source.path().join("Model..backup");
        fs::create_dir(&unsafe_name).unwrap();
        fs::write(unsafe_name.join("Model.model3.json"), "{}").unwrap();
        assert_eq!(
            import_live2d(fixture.paths(), "kisaki", &unsafe_name.to_string_lossy()).unwrap_err(),
            "路径组件不能包含 '..'"
        );
        assert_eq!(
            fs::read_dir(fixture.paths().characters_dir())
                .unwrap()
                .count(),
            0
        );

        fs::write(fixture.paths().characters_dir().join("blocked"), "不是目录").unwrap();
        let error = import_live2d(fixture.paths(), "blocked", &source.path().to_string_lossy())
            .unwrap_err();
        assert!(error.starts_with("创建 live2d 目录失败: "), "{error}");
    }

    #[test]
    fn character_operations_reject_invalid_ids_before_touching_storage() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        for (id, expected) in [
            ("", "路径组件不能为空"),
            ("..", "路径组件不能包含 '..'"),
            ("../neighbor", "路径组件不能包含 '..'"),
            ("nested/character", "路径组件不能包含分隔符"),
            (r"nested\character", "路径组件不能包含分隔符"),
        ] {
            assert_eq!(
                write_file(paths, id, "character.json", "{}").unwrap_err(),
                expected
            );
            assert_eq!(
                read_file(paths, id, "character.json").unwrap_err(),
                expected
            );
            assert_eq!(
                save_image(paths, id, "portrait.png", "AQID").unwrap_err(),
                expected
            );
            assert_eq!(
                delete_image(paths, id, "portrait.png").unwrap_err(),
                expected
            );
            assert_eq!(delete(paths, id).unwrap_err(), expected);
            assert_eq!(
                import_live2d(paths, id, "missing-source").unwrap_err(),
                expected
            );
        }
        assert_eq!(fs::read_dir(paths.characters_dir()).unwrap().count(), 0);
    }

    #[test]
    fn character_files_and_images_reject_unsafe_filenames_without_changing_existing_data() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        write_file(paths, "kisaki", "prompt.txt", "原有人设").unwrap();
        save_image(paths, "kisaki", "portrait.png", "AQID").unwrap();
        fs::write(fixture.root().join("outside.txt"), "目录外数据").unwrap();

        let check = |filename: &str, expected: &str| {
            assert_eq!(
                write_file(paths, "kisaki", filename, "替换").unwrap_err(),
                expected
            );
            assert_eq!(read_file(paths, "kisaki", filename).unwrap_err(), expected);
            assert_eq!(
                save_image(paths, "kisaki", filename, "BAUG").unwrap_err(),
                expected
            );
            assert_eq!(
                delete_image(paths, "kisaki", filename).unwrap_err(),
                expected
            );
        };
        for (filename, expected) in [
            ("", "路径组件不能为空"),
            ("..", "路径组件不能包含 '..'"),
            ("../outside.txt", "路径组件不能包含 '..'"),
            (r"..\outside.txt", "路径组件不能包含 '..'"),
            ("nested/file.txt", "路径组件不能包含分隔符"),
            (r"nested\file.txt", "路径组件不能包含分隔符"),
            ("/outside.txt", "路径组件不能包含分隔符"),
        ] {
            check(filename, expected);
        }
        if cfg!(windows) {
            check("C:outside.txt", "不允许绝对路径");
            check(
                "prompt.txt:stream",
                "路径组件不能包含 ':'（Windows 数据流）",
            );
        }
        assert_eq!(
            read_file(paths, "kisaki", "prompt.txt").unwrap(),
            "原有人设"
        );
        assert_eq!(
            fs::read(paths.characters_dir().join("kisaki/images/portrait.png")).unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("outside.txt")).unwrap(),
            "目录外数据"
        );
    }

    #[test]
    fn invalid_image_data_fails_before_creating_a_character_directory() {
        let fixture = TempAppPaths::new();
        for data in ["not base64!", "data:image/png;base64,AQID"] {
            let error = save_image(fixture.paths(), "kisaki", "portrait.png", data).unwrap_err();
            assert!(error.starts_with("base64 解码失败: "), "{error}");
        }
        assert!(!fixture.paths().characters_dir().join("kisaki").exists());
    }

    #[test]
    fn filesystem_failures_keep_the_existing_error_categories() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let error = read_file(paths, "missing", "prompt.txt").unwrap_err();
        assert!(error.starts_with("无法解析工作目录 '"), "{error}");

        fs::write(paths.characters_dir().join("blocked"), "不是目录").unwrap();
        let error = write_file(paths, "blocked", "prompt.txt", "人设").unwrap_err();
        assert!(error.starts_with("创建目录失败: "), "{error}");
        let error = save_image(paths, "blocked", "portrait.png", "AQID").unwrap_err();
        assert!(error.starts_with("创建目录失败: "), "{error}");

        write_file(paths, "kisaki", "character.json", "{}").unwrap();
        fs::write(paths.characters_dir().join("kisaki/prompt.txt"), [255, 254]).unwrap();
        let error = read_file(paths, "kisaki", "prompt.txt").unwrap_err();
        assert!(error.starts_with("读取文件失败: "), "{error}");

        fs::create_dir(paths.characters_dir().join("kisaki/directory")).unwrap();
        let error = write_file(paths, "kisaki", "directory", "人设").unwrap_err();
        assert!(error.starts_with("写入文件失败: "), "{error}");
        fs::create_dir_all(paths.characters_dir().join("kisaki/images/directory")).unwrap();
        let error = save_image(paths, "kisaki", "directory", "AQID").unwrap_err();
        assert!(error.starts_with("写入图片失败: "), "{error}");
        let error = delete_image(paths, "kisaki", "directory").unwrap_err();
        assert!(error.starts_with("删除图片失败: "), "{error}");
    }

    #[test]
    fn directory_queries_keep_empty_lists_and_best_effort_log_creation() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        fs::remove_dir(paths.characters_dir()).unwrap();
        fs::remove_dir(paths.logs_dir()).unwrap();
        assert!(list(paths).unwrap().is_empty());
        assert!(list_data_characters(paths).unwrap().is_empty());
        assert!(list_summaries(paths).unwrap().is_empty());
        let directories = data_dirs(paths).unwrap();
        assert!(paths.logs_dir().is_dir());
        assert!(!paths.characters_dir().exists());

        fs::write(paths.characters_dir(), "不是目录").unwrap();
        fs::remove_dir(paths.logs_dir()).unwrap();
        fs::write(paths.logs_dir(), "日志目录被文件占用").unwrap();
        assert!(list(paths).unwrap().is_empty());
        assert!(list_data_characters(paths).unwrap().is_empty());
        assert!(list_summaries(paths).unwrap().is_empty());
        assert_eq!(data_dirs(paths).unwrap(), directories);
    }

    #[test]
    fn live2d_import_preserves_binary_resources_and_rejects_duplicate_models() {
        let fixture = TempAppPaths::new();
        let source = TempDir::new();
        let src = source.path().join("Hiyori");
        fs::create_dir_all(src.join("Hiyori.2048")).unwrap();
        fs::create_dir_all(src.join("motions")).unwrap();
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("Hiyori.model3.json"), r#"{"Version":3}"#).unwrap();
        fs::write(src.join("nested/Other.model3.json"), "{}").unwrap();
        fs::write(src.join("Hiyori.2048/texture_00.png"), [0, 255, 128, 1]).unwrap();
        fs::write(src.join("motions/idle.motion3.json"), "动作数据").unwrap();
        fs::write(src.join("Hiyori.moc3"), [255, 0, 254]).unwrap();

        let relative = import_live2d(fixture.paths(), "kisaki", &src.to_string_lossy()).unwrap();
        assert_eq!(relative, "live2d/Hiyori/Hiyori.model3.json");
        let dest = fixture.root().join("characters/kisaki/live2d/Hiyori");
        assert_eq!(
            fs::read_to_string(dest.join("Hiyori.model3.json")).unwrap(),
            r#"{"Version":3}"#
        );
        assert_eq!(
            fs::read(dest.join("Hiyori.2048/texture_00.png")).unwrap(),
            [0, 255, 128, 1]
        );
        assert_eq!(fs::read(dest.join("Hiyori.moc3")).unwrap(), [255, 0, 254]);
        assert_eq!(
            fs::read_to_string(dest.join("motions/idle.motion3.json")).unwrap(),
            "动作数据"
        );
        assert_eq!(fs::read(src.join("Hiyori.moc3")).unwrap(), [255, 0, 254]);

        fs::write(src.join("Hiyori.moc3"), "替换数据").unwrap();
        assert_eq!(
            import_live2d(fixture.paths(), "kisaki", &src.to_string_lossy()).unwrap_err(),
            "已存在同名模型「Hiyori」，请改名或先删除旧模型"
        );
        assert_eq!(fs::read(dest.join("Hiyori.moc3")).unwrap(), [255, 0, 254]);
    }

    #[test]
    fn deleting_a_character_removes_its_resources_but_preserves_neighbors() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        write_file(paths, "kisaki", "character.json", "{}").unwrap();
        save_image(paths, "kisaki", "portrait.png", "AQID").unwrap();
        let model_dir = paths.characters_dir().join("kisaki/live2d/Model/motions");
        fs::create_dir_all(&model_dir).unwrap();
        fs::write(model_dir.join("idle.motion3.json"), "{}").unwrap();
        write_file(paths, "neighbor", "character.json", "保留").unwrap();

        delete(paths, "kisaki").unwrap();
        assert!(!paths.characters_dir().join("kisaki").exists());
        assert_eq!(list(paths).unwrap(), ["neighbor"]);
        assert_eq!(
            read_file(paths, "neighbor", "character.json").unwrap(),
            "保留"
        );
        assert_eq!(
            delete(paths, "kisaki").unwrap_err(),
            "角色目录不存在: kisaki"
        );
    }

    #[test]
    fn listings_use_local_configuration_and_preserve_sorted_summary_shapes() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        assert!(list(paths).unwrap().is_empty());
        assert!(list_data_characters(paths).unwrap().is_empty());
        assert!(list_summaries(paths).unwrap().is_empty());

        write_file(
            paths,
            "zeta",
            "character.json",
            r#"{"name":"妃咲","render":"image"}"#,
        )
        .unwrap();
        write_file(paths, "alpha", "character.json", r#"{"render":"live2d"}"#).unwrap();
        write_file(paths, "broken", "character.json", "不是 JSON").unwrap();
        write_file(paths, "incomplete", "prompt.txt", "没有配置").unwrap();
        fs::write(paths.characters_dir().join("not-a-character"), "普通文件").unwrap();

        assert_eq!(list(paths).unwrap(), ["alpha", "broken", "zeta"]);
        assert_eq!(
            list_data_characters(paths).unwrap(),
            ["alpha", "broken", "zeta"]
        );
        assert_eq!(
            serde_json::to_value(list_summaries(paths).unwrap()).unwrap(),
            serde_json::json!([
                {"id": "alpha", "name": null, "render": "live2d"},
                {"id": "broken", "name": null, "render": null},
                {"id": "zeta", "name": "妃咲", "render": "image"}
            ])
        );
        assert_eq!(
            data_dirs(paths).unwrap(),
            serde_json::json!({
                "characters": fixture.root().join("characters").to_string_lossy(),
                "logs": fixture.root().join("logs").to_string_lossy()
            })
        );
    }

    #[test]
    fn images_roundtrip_overwrite_and_delete_without_removing_character_files() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        delete_image(paths, "kisaki", "portrait.png").unwrap();
        write_file(paths, "kisaki", "character.json", "{}").unwrap();

        save_image(paths, "kisaki", "portrait.png", "AAECA//+").unwrap();
        let image = fixture.root().join("characters/kisaki/images/portrait.png");
        assert_eq!(fs::read(&image).unwrap(), [0, 1, 2, 3, 255, 254]);
        save_image(paths, "kisaki", "portrait.png", "BAUG").unwrap();
        assert_eq!(fs::read(&image).unwrap(), [4, 5, 6]);

        delete_image(paths, "kisaki", "portrait.png").unwrap();
        assert!(!image.exists());
        delete_image(paths, "kisaki", "portrait.png").unwrap();
        assert_eq!(read_file(paths, "kisaki", "character.json").unwrap(), "{}");
    }

    #[test]
    fn character_files_roundtrip_and_overwrite_in_the_injected_directory() {
        let fixture = TempAppPaths::new();
        let paths = fixture.paths();
        let config = r#"{"id":"kisaki","name":"妃咲","render":"image"}"#;

        write_file(paths, "kisaki", "character.json", config).unwrap();
        write_file(paths, "kisaki", "prompt.txt", "第一版人设").unwrap();
        assert_eq!(
            read_file(paths, "kisaki", "character.json").unwrap(),
            config
        );
        assert_eq!(
            read_file(paths, "kisaki", "prompt.txt").unwrap(),
            "第一版人设"
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("characters/kisaki/character.json")).unwrap(),
            config
        );

        write_file(paths, "kisaki", "prompt.txt", "更新后的人设\n保留换行").unwrap();
        assert_eq!(
            read_file(paths, "kisaki", "prompt.txt").unwrap(),
            "更新后的人设\n保留换行"
        );
        assert_eq!(
            read_file(paths, "kisaki", "missing.txt").unwrap_err(),
            "文件不存在: missing.txt"
        );
    }
}
