use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;

use crate::path::{characters_dir, log_dir, safe_join, sanitize_path_component};

/** 写入角色配置文件 */
/// filename 如 "character.json" 或 "prompt.txt"
#[tauri::command]
pub(crate) fn write_character_file(id: String, filename: String, content: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let base = characters_dir().join(&id);
    fs::create_dir_all(&base).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&base, &filename)?;
    fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 保存上传的立绘图片
/// data_base64: 图片的 base64 数据（不含 data:image/... 前缀）
#[tauri::command]
pub(crate) fn save_character_image(id: String, filename: String, data_base64: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let dir = characters_dir().join(&id).join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&dir, &filename)?;
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    Ok(())
}

/// 删除角色的立绘图片文件
#[tauri::command]
pub(crate) fn delete_character_image(id: String, filename: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let dir = characters_dir().join(&id).join("images");
    // 先确保目录存在，safe_join 需要 canonicalize 基目录
    if !dir.exists() {
        return Ok(());
    }
    let path = safe_join(&dir, &filename)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除图片失败: {}", e))?;
    }
    Ok(())
}

/// 删除整个角色目录（含所有图片和配置文件）
#[tauri::command]
pub(crate) fn delete_character(id: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let verified_path = safe_join(&characters_dir(), &id)?;
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
pub(crate) fn list_characters() -> Result<Vec<String>, String> {
    let dir = characters_dir();
    let mut result: Vec<String> = Vec::new();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
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

/// 返回前端需要的数据目录路径（characters、logs）
#[tauri::command]
pub(crate) fn get_data_dirs() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "characters": characters_dir().to_string_lossy(),
        "logs": log_dir().to_string_lossy(),
    }))
}

/// 仅扫描 data_dir 下的角色（不含预置列表），供前端判断哪些角色有本地文件
#[tauri::command]
pub(crate) fn list_data_dir_characters() -> Result<Vec<String>, String> {
    let dir = characters_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    if let Ok(entries) = fs::read_dir(&dir) {
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
pub(crate) fn read_character_file(id: String, filename: String) -> Result<String, String> {
    sanitize_path_component(&id)?;
    let path = safe_join(&characters_dir().join(&id), &filename)?;
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
        let ty = entry.file_type().map_err(|e| format!("读取文件类型失败: {}", e))?;
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
pub(crate) fn import_live2d_model(id: String, src_dir: String) -> Result<String, String> {
    sanitize_path_component(&id)?;
    let src = PathBuf::from(&src_dir);
    if !src.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }

    // 校验是有效 Live2D 模型（含 model3.json）
    let model_rel_in_src =
        find_model3(&src).ok_or_else(|| "该文件夹内未找到 *.model3.json，不是有效的 Live2D 模型".to_string())?;

    // 模型名 = 源文件夹名（作为目标子目录名）
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法识别模型文件夹名".to_string())?
        .to_string();
    sanitize_path_component(&name)?;

    // 目标 characters/<id>/live2d/<name>/
    let live2d_dir = characters_dir().join(&id).join("live2d");
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
