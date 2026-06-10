use std::path::PathBuf;
use std::fs;
use serde::Serialize;

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

// ---- CosyVoice TTS ----

/// TTS 返回结果
#[derive(Serialize)]
struct TtsResult {
    audio_base64: String,
    format: String,
}

/// 通过 CosyVoice WebSocket API 合成语音并返回音频数据（base64）
#[tauri::command]
async fn cosyvoice_tts(
    api_key: String,
    model: String,
    voice: String,
    text: String,
    ws_url: String,
) -> Result<TtsResult, String> {
    use base64::Engine;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::connect_async;
    use uuid::Uuid;

    if text.trim().is_empty() {
        return Err("合成文本不能为空".to_string());
    }

    // 构建 WebSocket 请求（添加 Authorization 头）
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let auth_value = format!("bearer {}", api_key);
    request.headers_mut().insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&auth_value).map_err(|_| "无效的 Authorization 头".to_string())?,
    );

    // 连接 WebSocket
    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    let (mut write, mut read) = ws_stream.split();

    let task_id = Uuid::new_v4().to_string();

    // 发送 run-task 事件
    let run_task = serde_json::json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": model,
            "parameters": {
                "text_type": "PlainText",
                "voice": voice,
                "format": "mp3",
                "sample_rate": 24000
            },
            "input": {}
        }
    });

    write
        .send(tokio_tungstenite::tungstenite::Message::Text(run_task.to_string()))
        .await
        .map_err(|e| format!("发送 run-task 失败: {}", e))?;

    let mut audio_data: Vec<u8> = Vec::new();
    let mut finished = false;

    while !finished {
        match read.next().await {
            Some(Ok(msg)) => match msg {
                tokio_tungstenite::tungstenite::Message::Binary(data) => {
                    audio_data.extend_from_slice(&data);
                }
                tokio_tungstenite::tungstenite::Message::Text(text_msg) => {
                    let parsed: serde_json::Value =
                        serde_json::from_str(&text_msg).map_err(|e| format!("JSON 解析失败: {}", e))?;

                    let event = parsed["header"]["event"].as_str().unwrap_or("");

                    match event {
                        "task-started" => {
                            // 发送 continue-task
                            let continue_task = serde_json::json!({
                                "header": {
                                    "action": "continue-task",
                                    "task_id": task_id,
                                    "streaming": "duplex"
                                },
                                "payload": {
                                    "input": {
                                        "text": text
                                    }
                                }
                            });
                            write
                                .send(tokio_tungstenite::tungstenite::Message::Text(
                                    continue_task.to_string(),
                                ))
                                .await
                                .map_err(|e| format!("发送 continue-task 失败: {}", e))?;

                            // 立即发送 finish-task
                            let finish_task = serde_json::json!({
                                "header": {
                                    "action": "finish-task",
                                    "task_id": task_id,
                                    "streaming": "duplex"
                                },
                                "payload": {
                                    "input": {}
                                }
                            });
                            write
                                .send(tokio_tungstenite::tungstenite::Message::Text(
                                    finish_task.to_string(),
                                ))
                                .await
                                .map_err(|e| format!("发送 finish-task 失败: {}", e))?;
                        }
                        "task-finished" => {
                            finished = true;
                        }
                        "task-failed" => {
                            let err_msg = parsed["header"]["error_message"]
                                .as_str()
                                .unwrap_or("未知错误");
                            return Err(format!("TTS 任务失败: {}", err_msg));
                        }
                        _ => {
                            // result-generated 等事件忽略
                        }
                    }
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => {
                    finished = true;
                }
                _ => {}
            },
            Some(Err(e)) => {
                return Err(format!("WebSocket 接收错误: {}", e));
            }
            None => {
                finished = true;
            }
        }
    }

    if audio_data.is_empty() {
        return Err("未接收到音频数据".to_string());
    }

    Ok(TtsResult {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(&audio_data),
        format: "mp3".to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            write_character_file,
            save_character_image,
            delete_character_image,
            delete_character,
            list_characters,
            cosyvoice_tts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
