use std::path::PathBuf;
use std::path::Path;
use std::fs;
use std::io::Write;
use serde::{Serialize, Deserialize};
use tauri::{Emitter, Manager};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio::sync::Mutex;
use uuid::Uuid;

/// 路径安全校验 — 防止 path traversal 攻击
///
/// 验证路径组件不包含 `..`、路径分隔符等危险字符。
fn sanitize_path_component(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("路径组件不能为空".to_string());
    }
    if name.contains("..") {
        return Err("路径组件不能包含 '..'".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("路径组件不能包含分隔符".to_string());
    }
    Ok(())
}

/// 安全的路径拼接 — 确保最终路径在基目录下
///
/// 1. 校验每个路径组件不含 path traversal
/// 2. 规范化基目录
/// 3. 验证最终路径前缀在基目录内
fn safe_join(base: &Path, filename: &str) -> Result<PathBuf, String> {
    sanitize_path_component(filename)?;

    // 规范化基目录（消解 .. 和符号链接）
    let canonical_base = base.canonicalize()
        .map_err(|e| format!("无法解析基路径 '{}': {}", base.display(), e))?;

    // 拼接目标路径
    let target = canonical_base.join(filename);

    // 验证目标路径仍在基目录下（防止符号链接绕过）
    if !target.starts_with(&canonical_base) {
        return Err("路径越权访问被拒绝".to_string());
    }

    Ok(target)
}

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
    sanitize_path_component(&id)?;
    let base = project_root().join("public").join("character").join(&id);
    fs::create_dir_all(&base).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&base, &filename)?;
    fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

/// 保存上传的立绘图片
/// data_base64: 图片的 base64 数据（不含 data:image/... 前缀）
#[tauri::command]
fn save_character_image(id: String, filename: String, data_base64: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let dir = project_root().join("public").join("character").join(&id).join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let path = safe_join(&dir, &filename)?;
    fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    Ok(())
}

/// 删除角色的立绘图片文件
#[tauri::command]
fn delete_character_image(id: String, filename: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let dir = project_root().join("public").join("character").join(&id).join("images");
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
fn delete_character(id: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let dir = project_root().join("public").join("character").join(&id);
    if !dir.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }
    // 用父目录 canonicalize 验证 id 不是 traversal
    let parent = project_root().join("public").join("character");
    let verified_path = safe_join(&parent, &id)?;
    fs::remove_dir_all(&verified_path).map_err(|e| format!("删除角色目录失败: {}", e))?;
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

/// WebSocket 流类型别名（简化冗长的泛型签名）
type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsWriteHalf = futures_util::stream::SplitSink<WsStream, Message>;
type WsReadHalf = futures_util::stream::SplitStream<WsStream>;

/// 解析 WebSocket JSON 消息，返回 (event_type, 可选错误消息)
fn parse_ws_event(text: &str) -> Result<(String, Option<String>), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let event = parsed["header"]["event"].as_str().unwrap_or("").to_string();
    let error = parsed["header"]["error_message"]
        .as_str()
        .map(|s| s.to_string());
    Ok((event, error))
}

/// 发送 WebSocket close frame 并等待服务端关闭确认
async fn ws_graceful_close(write: &mut WsWriteHalf, read: &mut WsReadHalf) {
    // 发送 close frame
    let _ = write.send(Message::Close(None)).await;
    // 等待服务端返回 close frame（最多等 2 秒）
    for _ in 0..20 {
        match read.next().await {
            Some(Ok(Message::Close(_))) | None => break,
            _ => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
}

/// 带超时的 WebSocket 连接
async fn connect_ws_with_timeout<R>(
    request: R,
    timeout: std::time::Duration,
) -> Result<WsStream, String>
where
    R: tokio_tungstenite::tungstenite::client::IntoClientRequest + Unpin,
{
    let ws_result = tokio::time::timeout(timeout, connect_async(request)).await
        .map_err(|_| format!("WebSocket 连接超时（{}秒）", timeout.as_secs()))?;
    ws_result
        .map(|(ws_stream, _)| ws_stream)
        .map_err(|e| format!("WebSocket 连接失败: {}", e))
}

// ─── WebSocket 连接池（复用 TCP+TLS 连接，减少握手开销） ─────

/// 缓存的 WebSocket 连接（与连接时间戳）
struct CachedWsConnection {
    write: WsWriteHalf,
    read: WsReadHalf,
    created_at: std::time::Instant,
}

/// TTS WebSocket 连接池（最多缓存 1 个连接，30 秒过期）
pub struct TtsConnectionPool {
    inner: Mutex<Option<CachedWsConnection>>,
}

impl TtsConnectionPool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 获取缓存的连接（过期或不可用时返回 None）
    pub async fn take_connection(&self, max_age_secs: u64) -> Option<(WsWriteHalf, WsReadHalf)> {
        let mut guard = self.inner.lock().await;
        let cached = guard.take()?;
        if cached.created_at.elapsed().as_secs() < max_age_secs {
            Some((cached.write, cached.read))
        } else {
            // 过期连接直接丢弃
            drop(cached);
            None
        }
    }

    /// 归还连接供后续复用
    pub async fn put_connection(&self, write: WsWriteHalf, read: WsReadHalf) {
        let mut guard = self.inner.lock().await;
        // 替换旧连接，旧的会被 drop（触发 close frame）
        *guard = Some(CachedWsConnection {
            write,
            read,
            created_at: std::time::Instant::now(),
        });
    }
}

/// 构建 run-task 握手消息的 JSON
fn build_run_task(task_id: &str, model: &str, voice: &str) -> serde_json::Value {
    serde_json::json!({
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
    })
}

/// 在已有连接上执行 run-task 握手
async fn run_task_on_connection(
    write: &mut WsWriteHalf,
    model: &str,
    voice: &str,
) -> Result<String, String> {
    let task_id = Uuid::new_v4().to_string();
    let run_task = build_run_task(&task_id, model, voice);
    write
        .send(Message::Text(run_task.to_string()))
        .await
        .map_err(|e| format!("发送 run-task 失败: {}", e))?;
    Ok(task_id)
}

/// 建立 CosyVoice WebSocket 连接并执行 run-task 握手
/// 返回 (write, read, task_id)，失败时返回 Err
async fn cosyvoice_handshake(
    ws_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
) -> Result<(WsWriteHalf, WsReadHalf, String), String> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let auth_value = format!("bearer {}", api_key);
    request.headers_mut().insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&auth_value)
            .map_err(|_| "无效的 Authorization 头".to_string())?,
    );

    let ws_stream = connect_ws_with_timeout(request, std::time::Duration::from_secs(15))
        .await?;

    let (mut write, read) = ws_stream.split();
    let task_id = run_task_on_connection(&mut write, model, voice).await?;

    Ok((write, read, task_id))
}

/// 等待 task-started 事件，发送 continue-task + finish-task
async fn cosyvoice_send_text(
    write: &mut WsWriteHalf,
    read: &mut WsReadHalf,
    task_id: &str,
    text: &str,
) -> Result<(), String> {
    loop {
        match read.next().await {
            Some(Ok(Message::Text(text_msg))) => {
                let (event, _) = parse_ws_event(&text_msg)?;
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
                    write.send(Message::Text(continue_task.to_string())).await
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
                    write.send(Message::Text(finish_task.to_string())).await
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

/// 获取连接（优先从池中取，取不到则新建）
/// 返回 (write, read, task_id, from_pool) — from_pool 表示完成后应归还
async fn acquire_or_connect(
    pool: &TtsConnectionPool,
    ws_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
) -> Result<(WsWriteHalf, WsReadHalf, String, bool), String> {
    // 尝试从连接池获取（5 秒内的连接可复用 TCP 连接）
    if let Some((mut write, read)) = pool.take_connection(5).await {
        // 在已有连接上发送新 run-task（复用 TCP/TLS 握手）
        match run_task_on_connection(&mut write, model, voice).await {
            Ok(task_id) => return Ok((write, read, task_id, true)),
            Err(e) => {
                eprintln!("连接池中现有连接不可复用，创建新连接: {}", e);
                // 丢弃旧的失效连接
                drop(write);
                drop(read);
            }
        }
    }

    // 没有可用缓存 → 新建完整连接
    let (write, read, task_id) = cosyvoice_handshake(ws_url, api_key, model, voice).await?;
    Ok((write, read, task_id, false))
}

/// 通过 CosyVoice WebSocket API 合成语音并返回音频数据（base64，批处理）
#[tauri::command]
async fn cosyvoice_tts(
    app_handle: tauri::AppHandle,
    api_key: String,
    model: String,
    voice: String,
    text: String,
    ws_url: String,
) -> Result<TtsResult, String> {
    if text.trim().is_empty() {
        return Err("合成文本不能为空".to_string());
    }

    let pool = app_handle.state::<TtsConnectionPool>();
    let (mut write, mut read, task_id, from_pool) =
        acquire_or_connect(&pool, &ws_url, &api_key, &model, &voice).await?;
    let result = audio_receive_batch(&mut write, &mut read, &task_id, &text, &pool, from_pool).await;
    if from_pool {
        pool.put_connection(write, read).await;
    } else {
        ws_graceful_close(&mut write, &mut read).await;
    }
    result
}

/// 收集音频数据至 Vec（批处理模式的接收循环）
async fn audio_receive_batch(
    write: &mut WsWriteHalf,
    read: &mut WsReadHalf,
    task_id: &str,
    text: &str,
    _pool: &TtsConnectionPool,
    _from_pool: bool,
) -> Result<TtsResult, String> {
    cosyvoice_send_text(write, read, task_id, text).await?;

    let mut audio_data: Vec<u8> = Vec::new();
    loop {
        match read.next().await {
            Some(Ok(Message::Binary(data))) => {
                audio_data.extend_from_slice(&data);
            }
            Some(Ok(Message::Text(text_msg))) => {
                let (event, error) = parse_ws_event(&text_msg)?;
                match event.as_str() {
                    "task-finished" => break,
                    "task-failed" => {
                        return Err(format!("TTS 任务失败: {}", error.unwrap_or_else(|| "未知错误".to_string())));
                    }
                    _ => {}
                }
            }
            Some(Ok(Message::Close(_))) => break,
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
    if text.trim().is_empty() {
        return Err("合成文本不能为空".to_string());
    }

    let pool = app_handle.state::<TtsConnectionPool>();
    let (mut write, mut read, task_id, from_pool) =
        acquire_or_connect(&pool, &ws_url, &api_key, &model, &voice).await?;

    // 等待 task-started 并发送文本
    cosyvoice_send_text(&mut write, &mut read, &task_id, &text).await?;

    // 逐帧接收音频，即时 emit 给前端
    let mut has_data = false;

    loop {
        match read.next().await {
            Some(Ok(Message::Binary(data))) => {
                has_data = true;
                let chunk = TtsChunk {
                    data: base64::engine::general_purpose::STANDARD.encode(&data),
                    format: "mp3".to_string(),
                    is_last: false,
                };
                let _ = app_handle.emit("tts-audio-chunk", chunk);
            }
            Some(Ok(Message::Text(text_msg))) => {
                let (event, error) = parse_ws_event(&text_msg)?;
                match event.as_str() {
                    "task-finished" => break,
                    "task-failed" => {
                        return Err(format!("TTS 任务失败: {}", error.unwrap_or_else(|| "未知错误".to_string())));
                    }
                    _ => {}
                }
            }
            Some(Ok(Message::Close(_))) => break,
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

    // 归还或关闭连接
    if from_pool {
        pool.put_connection(write, read).await;
    } else {
        ws_graceful_close(&mut write, &mut read).await;
    }

    if !has_data {
        return Err("未接收到音频数据".to_string());
    }

    Ok(())
}

// ---- 日志系统 ----

/// 日志条目结构（与前端约定）
#[derive(Deserialize)]
struct LogEntryPayload {
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: Option<String>,
}

/// 日志条目（含行号，返回给前端显示）
#[derive(Serialize, Clone)]
struct LogEntry {
    line: usize,
    timestamp: String,
    level: String,
    namespace: String,
    message: String,
    source: String,
}

/// 获取日志目录路径
fn log_dir() -> PathBuf {
    let dir = project_root().join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 追加日志条目到日志文件（JSONL 格式）
#[tauri::command]
fn append_log_entries(filename: String, entries: Vec<LogEntryPayload>) -> Result<(), String> {
    // 验证文件名安全（只允许字母、数字、连字符、点）
    if !filename.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("无效的文件名".to_string());
    }

    let path = log_dir().join(&filename);
    // 追加模式写入
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {}", e))?;

    for entry in &entries {
        let line = serde_json::json!({
            "timestamp": entry.timestamp,
            "level": entry.level,
            "namespace": entry.namespace,
            "message": entry.message,
            "source": entry.source,
        });
        writeln!(file, "{}", line).map_err(|e| format!("写入日志失败: {}", e))?;
    }

    Ok(())
}

/// 读取日志文件内容
#[tauri::command]
fn read_log_file(filename: String) -> Result<Vec<LogEntry>, String> {
    if !filename.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("无效的文件名".to_string());
    }

    let path = log_dir().join(&filename);
    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("读取日志文件失败: {}", e))?;

    let mut entries = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(val) => {
                entries.push(LogEntry {
                    line: i + 1,
                    timestamp: val["timestamp"].as_str().unwrap_or("").to_string(),
                    level: val["level"].as_str().unwrap_or("").to_string(),
                    namespace: val["namespace"].as_str().unwrap_or("").to_string(),
                    message: val["message"].as_str().unwrap_or("").to_string(),
                    source: val["source"].as_str().unwrap_or("主窗口").to_string(),
                });
            }
            Err(_) => {
                // 跳过解析失败的行
                entries.push(LogEntry {
                    line: i + 1,
                    timestamp: String::new(),
                    level: "warn".to_string(),
                    namespace: "System".to_string(),
                    message: format!("[日志解析失败] {}", line),
                    source: String::new(),
                });
            }
        }
    }

    Ok(entries)
}

/// 导出日志文件到指定路径
#[tauri::command]
fn export_log_file(source_filename: String, dest_path: String) -> Result<(), String> {
    if !source_filename.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("无效的文件名".to_string());
    }

    let src = log_dir().join(&source_filename);
    if !src.exists() {
        return Err("日志文件不存在".to_string());
    }

    let dest = PathBuf::from(&dest_path);
    // 确保目标目录存在
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    fs::copy(&src, &dest).map_err(|e| format!("导出日志文件失败: {}", e))?;
    Ok(())
}

/// 列出 logs 目录下所有日志文件名
#[tauri::command]
fn list_log_files() -> Result<Vec<String>, String> {
    let dir = log_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("读取日志目录失败: {}", e))?
        .filter_map(|entry| {
            let e = entry.ok()?;
            if e.file_type().ok()?.is_file() {
                e.file_name().to_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect();
    files.sort();
    files.reverse(); // 最新的在前
    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TtsConnectionPool::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            write_character_file,
            save_character_image,
            delete_character_image,
            delete_character,
            list_characters,
            cosyvoice_tts,
            cosyvoice_tts_stream,
            append_log_entries,
            read_log_file,
            export_log_file,
            list_log_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
