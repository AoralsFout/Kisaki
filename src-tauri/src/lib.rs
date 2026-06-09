use std::path::PathBuf;
use std::fs;

/// 获取项目根目录
/// Tauri 运行时 cwd 是 src-tauri/，需要向上找一级
fn project_root() -> PathBuf {
    // 优先使用 Cargo manifest dir（编译时确定）
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project = manifest.parent().unwrap_or(&manifest);

    // 验证 public/character 存在
    if project.join("public").join("character").exists() {
        return project.to_path_buf();
    }

    // 回退：运行时 cwd
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("public").join("character").exists() {
        cwd
    } else {
        project.to_path_buf()
    }
}

/// 写入角色配置文件
/// filename 如 "character.json" 或 "prompt.txt"
#[tauri::command]
fn write_character_file(id: String, filename: String, content: String) -> Result<(), String> {
    let path = project_root().join("public").join("character").join(&id).join(&filename);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 保存上传的立绘图片
/// data_base64: 图片的 base64 数据（不含 data:image/... 前缀）
#[tauri::command]
fn save_character_image(id: String, filename: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let dir = project_root().join("public").join("character").join(&id).join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    Ok(())
}

/// 删除角色的立绘图片文件
#[tauri::command]
fn delete_character_image(id: String, filename: String) -> Result<(), String> {
    let path = project_root().join("public").join("character").join(&id).join("images").join(&filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除图片失败: {}", e))?;
    }
    Ok(())
}

/// 删除整个角色目录（含所有图片和配置文件）
#[tauri::command]
fn delete_character(id: String) -> Result<(), String> {
    let dir = project_root().join("public").join("character").join(&id);
    if !dir.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("删除角色目录失败: {}", e))?;
    Ok(())
}

/// 扫描角色目录，返回所有可用角色 ID
#[tauri::command]
fn list_characters() -> Result<Vec<String>, String> {
    let dir = project_root().join("public").join("character");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取角色目录失败: {}", e))?;
    for entry in entries {
        if let Ok(e) = entry {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = e.file_name().to_str() {
                    // 只返回包含 character.json 的有效角色目录
                    if e.path().join("character.json").exists() {
                        result.push(name.to_string());
                    }
                }
            }
        }
    }
    result.sort();
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![write_character_file, save_character_image, delete_character_image, delete_character, list_characters])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
