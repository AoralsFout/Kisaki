use std::path::PathBuf;
use std::fs;
use serde::Serialize;
use tauri::Emitter;

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

/// TTS 返回结果（批处理模式）
#[derive(Serialize)]
struct TtsResult {
    audio_base64: String,
    format: String,
}

/// TTS 流式音频帧事件
#[derive(Clone, Serialize)]
struct TtsChunk {
    data: String,
    format: String,
    is_last: bool,
}

/// 建立 CosyVoice WebSocket 连接并执行 run-task 握手
/// 返回 (write, read, task_id)，失败时返回 Err
async fn cosyvoice_handshake(
    ws_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
) -> Result<
    (
        futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, tokio_tungstenite::tungstenite::Message>,
        futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
        String,
    ),
    String,
> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::connect_async;
    use uuid::Uuid;

    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let auth_value = format!("bearer {}", api_key);
    request.headers_mut().insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&auth_value)
            .map_err(|_| "无效的 Authorization 头".to_string())?,
    );

    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("WebSocket 连接失败: {}", e))?;

    let (mut write, read) = ws_stream.split();
    let task_id = Uuid::new_v4().to_string();

    // 发送 run-task
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

    Ok((write, read, task_id))
}

/// 等待 task-started 事件，发送 continue-task + finish-task
async fn cosyvoice_send_text(
    write: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::Message,
    >,
    read: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    task_id: &str,
    text: &str,
) -> Result<(), String> {
    use futures_util::sink::SinkExt;
    use futures_util::StreamExt;

    loop {
        match read.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text_msg))) => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&text_msg).map_err(|e| format!("JSON 解析失败: {}", e))?;
                let event = parsed["header"]["event"].as_str().unwrap_or("");

                if event == "task-started" {
                    // 发送 continue-task（携带文本）
                    let continue_task = serde_json::json!({
                        "header": {
                            "action": "continue-task",
                            "task_id": task_id,
                            "streaming": "duplex"
                        },
                        "payload": {
                            "input": { "text": text }
                        }
                    });
                    write
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            continue_task.to_string(),
                        ))
                        .await
                        .map_err(|e| format!("发送 continue-task 失败: {}", e))?;

                    // 立即发送 finish-task（文本输入完毕）
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

                    return Ok(());
                }
            }
            Some(Err(e)) => {
                return Err(format!("等待 task-started 时出错: {}", e));
            }
            _ => {}
        }
    }
}

/// 通过 CosyVoice WebSocket API 合成语音并返回音频数据（base64，批处理）
#[tauri::command]
async fn cosyvoice_tts(
    api_key: String,
    model: String,
    voice: String,
    text: String,
    ws_url: String,
) -> Result<TtsResult, String> {
    use base64::Engine;
    use futures_util::StreamExt;

    if text.trim().is_empty() {
        return Err("合成文本不能为空".to_string());
    }

    let (mut write, mut read, task_id) =
        cosyvoice_handshake(&ws_url, &api_key, &model, &voice).await?;

    // 等待 task-started 并发送文本
    cosyvoice_send_text(&mut write, &mut read, &task_id, &text).await?;

    // 收集所有音频帧
    let mut audio_data: Vec<u8> = Vec::new();

    loop {
        match read.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(data))) => {
                audio_data.extend_from_slice(&data);
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text_msg))) => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&text_msg).map_err(|e| format!("JSON 解析失败: {}", e))?;
                let event = parsed["header"]["event"].as_str().unwrap_or("");

                match event {
                    "task-finished" => break,
                    "task-failed" => {
                        let err_msg = parsed["header"]["error_message"]
                            .as_str()
                            .unwrap_or("未知错误");
                        return Err(format!("TTS 任务失败: {}", err_msg));
                    }
                    _ => {}
                }
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
            Some(Err(e)) => return Err(format!("WebSocket 接收错误: {}", e)),
            None => break,
            _ => {}
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

/// 通过 CosyVoice WebSocket API 流式合成语音，逐帧 emit 给前端
#[tauri::command]
async fn cosyvoice_tts_stream(
    app_handle: tauri::AppHandle,
    api_key: String,
    model: String,
    voice: String,
    text: String,
    ws_url: String,
) -> Result<(), String> {
    use base64::Engine;
    use futures_util::StreamExt;

    if text.trim().is_empty() {
        return Err("合成文本不能为空".to_string());
    }

    let (mut write, mut read, task_id) =
        cosyvoice_handshake(&ws_url, &api_key, &model, &voice).await?;

    // 等待 task-started 并发送文本
    cosyvoice_send_text(&mut write, &mut read, &task_id, &text).await?;

    // 逐帧接收音频，即时 emit 给前端
    let mut has_data = false;

    loop {
        match read.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(data))) => {
                has_data = true;
                let chunk = TtsChunk {
                    data: base64::engine::general_purpose::STANDARD.encode(&data),
                    format: "mp3".to_string(),
                    is_last: false,
                };
                let _ = app_handle.emit("tts-audio-chunk", chunk);
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text_msg))) => {
                let parsed: serde_json::Value =
                    serde_json::from_str(&text_msg).map_err(|e| format!("JSON 解析失败: {}", e))?;
                let event = parsed["header"]["event"].as_str().unwrap_or("");

                match event {
                    "task-finished" => break,
                    "task-failed" => {
                        let err_msg = parsed["header"]["error_message"]
                            .as_str()
                            .unwrap_or("未知错误");
                        return Err(format!("TTS 任务失败: {}", err_msg));
                    }
                    _ => {}
                }
            }
            Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => break,
            Some(Err(e)) => return Err(format!("WebSocket 接收错误: {}", e)),
            None => break,
            _ => {}
        }
    }

    // 发送结束标记
    let _ = app_handle.emit(
        "tts-audio-chunk",
        TtsChunk {
            data: String::new(),
            format: "mp3".to_string(),
            is_last: true,
        },
    );

    if !has_data {
        return Err("未接收到音频数据".to_string());
    }

    Ok(())
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
            cosyvoice_tts_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
