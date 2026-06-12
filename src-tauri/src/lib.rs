use std::path::PathBuf;
use std::path::Path;
use std::fs;
use std::io::Write;
use std::sync::OnceLock;
use serde::{Serialize, Deserialize};
use tauri::{Emitter, Manager};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio::sync::Mutex;
use uuid::Uuid;

// ─── 数据目录 ─────────────────────────────────────────
// 双路径策略：
//   dev  模式 → characters: public/characters/（git 可追踪）, logs: 项目根/logs/
//   生产模式 → characters: app_data_dir/characters/,    logs: app_data_dir/logs/
// setup() 阶段自动检测并初始化两个 OnceLock。

static CHARACTERS_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();

fn characters_dir() -> PathBuf {
    CHARACTERS_DIR.get().expect("CHARACTERS_DIR 未初始化").clone()
}

fn log_dir() -> PathBuf {
    let dir = LOGS_DIR.get().expect("LOGS_DIR 未初始化").clone();
    let _ = fs::create_dir_all(&dir);
    dir
}

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

/** 写入角色配置文件 */
/// filename 如 "character.json" 或 "prompt.txt"
#[tauri::command]
fn write_character_file(id: String, filename: String, content: String) -> Result<(), String> {
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
fn save_character_image(id: String, filename: String, data_base64: String) -> Result<(), String> {
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
fn delete_character_image(id: String, filename: String) -> Result<(), String> {
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
fn delete_character(id: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let verified_path = safe_join(&characters_dir(), &id)?;
    if !verified_path.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }
    fs::remove_dir_all(&verified_path).map_err(|e| format!("删除角色目录失败: {}", e))?;
    Ok(())
}

/// 预置角色 ID 列表。生产环境下 data_dir 初始为空，前端依赖此列表
/// 判断哪些角色可通过 web 静态路径（fetch）加载。
const PRESET_CHARACTER_IDS: &[&str] = &[
    "chryso", "kanade", "kanata", "kisaki", "misaki",
    "nagisa", "rio", "yamiko", "yoruko",
];

/// 扫描角色目录，返回所有可用角色 ID（合并 data_dir 中的角色 + 预置角色）
#[tauri::command]
fn list_characters() -> Result<Vec<String>, String> {
    let mut result: Vec<String> = PRESET_CHARACTER_IDS.iter().map(|s| s.to_string()).collect();
    let dir = characters_dir();
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Some(name) = entry.file_name().to_str() {
                        let id = name.to_string();
                        if entry.path().join("character.json").exists() && !result.contains(&id) {
                            result.push(id);
                        }
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
    /// 所属流的唯一标识，前端据此过滤掉已被取代的旧流的音频帧
    stream_id: String,
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
    // 等待服务端返回 close frame（每次读取最多等 200ms，最多 20 次 ≈ 4 秒）。
    // 用超时避免在已失联/停滞的连接上无限阻塞。
    for _ in 0..20 {
        match tokio::time::timeout(std::time::Duration::from_millis(200), read.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(_) => continue,
            Err(_) => break,
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
    match &result {
        // 仅在成功且来自连接池时归还连接；出错的连接可能已失效，丢弃而非污染连接池
        Ok(_) if from_pool => pool.put_connection(write, read).await,
        _ => ws_graceful_close(&mut write, &mut read).await,
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
        // 读取每帧最多等待 30 秒，避免服务端停滞导致命令永久挂起
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(30), read.next()).await {
            Ok(m) => m,
            Err(_) => return Err("TTS 接收超时（30 秒无数据）".to_string()),
        };
        match msg {
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
    stream_id: String,
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

    // 逐帧接收音频，即时 emit 给前端。所有退出路径都在循环外统一发送结束标记，
    // 确保前端 playStream 不会因缺少 is_last 而无限等待。
    let mut has_data = false;
    let recv_result: Result<(), String> = loop {
        // 读取每帧最多等待 30 秒，避免服务端停滞导致命令永久挂起
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(30), read.next()).await {
            Ok(m) => m,
            Err(_) => break Err("TTS 接收超时（30 秒无数据）".to_string()),
        };
        match msg {
            Some(Ok(Message::Binary(data))) => {
                has_data = true;
                let chunk = TtsChunk {
                    stream_id: stream_id.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(&data),
                    format: "mp3".to_string(),
                    is_last: false,
                };
                let _ = app_handle.emit("tts-audio-chunk", chunk);
            }
            Some(Ok(Message::Text(text_msg))) => {
                match parse_ws_event(&text_msg) {
                    Ok((event, error)) => match event.as_str() {
                        "task-finished" => break Ok(()),
                        "task-failed" => break Err(format!(
                            "TTS 任务失败: {}",
                            error.unwrap_or_else(|| "未知错误".to_string())
                        )),
                        _ => {}
                    },
                    Err(e) => break Err(e),
                }
            }
            Some(Ok(Message::Close(_))) => break Ok(()),
            Some(Err(e)) => break Err(format!("WebSocket 接收错误: {}", e)),
            None => break Ok(()),
            _ => {}
        }
    };

    // 无论成功或失败，都发送结束标记（带 stream_id），通知前端结束本次流
    let _ = app_handle.emit(
        "tts-audio-chunk",
        TtsChunk {
            stream_id,
            data: String::new(),
            format: "mp3".to_string(),
            is_last: true,
        },
    );

    // 连接处理：成功且来自连接池 → 归还复用；否则关闭/丢弃（坏连接不回收）
    match recv_result {
        Ok(()) => {
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
        Err(e) => {
            // 出错连接不回收，直接丢弃
            drop(write);
            drop(read);
            Err(e)
        }
    }
}

/// 返回前端需要的数据目录路径（characters、logs）
#[tauri::command]
fn get_data_dirs() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "characters": characters_dir().to_string_lossy(),
        "logs": log_dir().to_string_lossy(),
    }))
}

/// 仅扫描 data_dir 下的角色（不含预置列表），供前端判断哪些角色有本地文件
#[tauri::command]
fn list_data_dir_characters() -> Result<Vec<String>, String> {
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
fn read_character_file(id: String, filename: String) -> Result<String, String> {
    sanitize_path_component(&id)?;
    let path = safe_join(&characters_dir().join(&id), &filename)?;
    if !path.exists() {
        return Err(format!("文件不存在: {}", filename));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
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

/// 导出日志文件到指定路径（由前端 dialog 选择目标路径）
#[tauri::command]
fn export_log_file(source_filename: String, dest_path: String) -> Result<(), String> {
    if !source_filename.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("无效的文件名".to_string());
    }

    let src = log_dir().join(&source_filename);
    if !src.exists() {
        return Err("日志文件不存在".to_string());
    }

    // 防御性校验：拒绝含 path traversal 的目标路径（正常由前端 dialog 传入，不应出现）
    let dest = PathBuf::from(&dest_path);
    if dest.to_string_lossy().contains("..") {
        return Err("无效的导出路径".to_string());
    }

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
        .setup(|app| {
            // dev 模式检测：若项目 public/characters/ 存在（CARGO_MANIFEST_DIR 可达），
            // 直接读写项目目录（git 可追踪）；否则回退 app_data_dir（生产环境）
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let project_root = manifest_dir.parent().unwrap_or(&PathBuf::from(".")).to_path_buf();
            let dev_chars = project_root.join("public").join("characters");

            if dev_chars.exists() {
                // ── dev 模式 ──
                // characters → <project>/public/characters/  （git 可追踪）
                // logs       → <project>/logs/
                CHARACTERS_DIR.set(dev_chars).map_err(|_| "CHARACTERS_DIR already set")?;
                let logs = project_root.join("logs");
                fs::create_dir_all(&logs)?;
                LOGS_DIR.set(logs).map_err(|_| "LOGS_DIR already set")?;
            } else {
                // ── 生产模式 ──
                // characters → <app_data_dir>/characters/
                // logs       → <app_data_dir>/logs/
                let d = app.path().app_data_dir()?;
                fs::create_dir_all(d.join("characters"))?;
                fs::create_dir_all(d.join("logs"))?;
                CHARACTERS_DIR.set(d.join("characters")).map_err(|_| "CHARACTERS_DIR already set")?;
                LOGS_DIR.set(d.join("logs")).map_err(|_| "LOGS_DIR already set")?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_character_file,
            save_character_image,
            delete_character_image,
            delete_character,
            list_characters,
            list_data_dir_characters,
            get_data_dirs,
            read_character_file,
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
