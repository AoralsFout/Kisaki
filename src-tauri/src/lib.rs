use std::path::PathBuf;
use std::path::Path;
use std::fs;
use std::io::{Read, Seek, Write};
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
//   dev  模式 → characters: <项目>/characters/（git 可追踪）, logs: 项目根/logs/
//   生产模式 → characters: app_data_dir/characters/,         logs: app_data_dir/logs/
// 不内置预置角色：生产模式首次启动 characters 为空，由用户通过「导入角色包」填充。
// setup() 阶段初始化两个 OnceLock。

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

/// 扫描 characters 目录，返回所有有效角色 ID（含 character.json 的子目录）。
/// dev 模式指向 <项目>/characters/；生产模式指向 app_data_dir/characters/。
/// 不再有预置 fallback：目录为空即返回空列表。
#[tauri::command]
fn list_characters() -> Result<Vec<String>, String> {
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

// ---- 角色包导入 / 导出 ----

/// 角色包导入结果
#[derive(Serialize)]
struct ImportResult {
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
            zip.add_directory(format!("{}/", name), options).map_err(|e| e.to_string())?;
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
fn export_character_pack(id: String, dest_path: String) -> Result<(), String> {
    sanitize_path_component(&id)?;
    let base = characters_dir();
    let char_dir = base.join(&id);
    if !char_dir.exists() {
        return Err(format!("角色目录不存在: {}", id));
    }

    // 防御性校验目标路径（正常由前端 dialog 传入）
    let dest = PathBuf::from(&dest_path);
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

    zip.add_directory(format!("{}/", id), options).map_err(|e| e.to_string())?;
    zip_dir_recursive(&mut zip, &base, &char_dir, options)?;
    zip.finish().map_err(|e| format!("完成角色包写入失败: {}", e))?;
    Ok(())
}

/// 从 zip 角色包导入角色到 characters_dir。
/// 冲突策略：跳过已存在的角色 id（保护用户已改过的角色）。
/// 角色 id 取自每个 character.json 的 `id` 字段（回退到所在目录名）；
/// 兼容 `character.json` 在包根、`<id>/character.json`、`<前缀>/<id>/character.json` 等结构，
/// 以 character.json 所在目录为前缀重映射解压到 characters_dir/<id>。
/// 安全：enclosed_name 防 zip-slip；id 过 sanitize 校验；解压目标须在 characters_dir 内。
#[tauri::command]
fn import_character_pack(src_path: String) -> Result<ImportResult, String> {
    use std::collections::BTreeMap;

    let base = characters_dir();
    fs::create_dir_all(&base).map_err(|e| format!("创建角色目录失败: {}", e))?;
    let canonical_base = base.canonicalize().map_err(|e| format!("解析角色目录失败: {}", e))?;

    let file = fs::File::open(&src_path).map_err(|e| format!("打开角色包失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析角色包失败: {}", e))?;

    eprintln!("[kisaki] 导入角色包: {}（{} 个条目）", src_path, archive.len());

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
                eprintln!("[kisaki]   跳过不安全条目: {}", raw_name);
                continue;
            }
        };
        if sample_names.len() < 20 {
            sample_names.push(enclosed.to_string_lossy().replace('\\', "/"));
        }
        if !enclosed.file_name().map(|f| f == "character.json").unwrap_or(false) {
            continue;
        }
        // 角色根前缀 = character.json 所在目录（根级则为空路径）
        let prefix = enclosed.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        // 优先取 character.json 内的 id 字段；回退到所在目录名
        let mut content = String::new();
        let _ = entry.read_to_string(&mut content);
        let id_from_json = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| v.get("id").and_then(|x| x.as_str()).map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty());
        let id = match id_from_json.or_else(|| {
            enclosed.parent()
                .and_then(|p| p.file_name())
                .map(|os| os.to_string_lossy().to_string())
        }) {
            Some(id) => id,
            None => {
                eprintln!("[kisaki]   {} 无 id 字段且位于包根，跳过", raw_name);
                continue;
            }
        };
        eprintln!("[kisaki]   发现角色: id={} 前缀=\"{}\"", id, prefix.display());
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
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        // 找到此条目所属的待导入角色根（按 zip 内前缀匹配）
        let mut mapped: Option<(String, PathBuf)> = None;
        for (id, prefix) in &to_import {
            if let Ok(rel) = enclosed.strip_prefix(prefix) {
                mapped = Some((id.clone(), rel.to_path_buf()));
                break;
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
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            fs::write(&target, &buf).map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }

    for id in to_import.keys() {
        imported.push(id.clone());
    }
    imported.sort();
    skipped.sort();
    eprintln!("[kisaki] 导入完成: imported={:?} skipped={:?}", imported, skipped);
    Ok(ImportResult { imported, skipped })
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

/// 全局光标位置事件 payload（物理屏幕坐标）——前端鼠标穿透命中测试用
#[cfg(windows)]
#[derive(Clone, Serialize)]
struct CursorPos {
    x: i32,
    y: i32,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TtsConnectionPool::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
.setup(|app| {
            // 区分 dev / 生产模式：
            //   cfg!(debug_assertions) = true  → tauri dev（debug 编译）→ dev 路径，git 可追踪
            //   cfg!(debug_assertions) = false → tauri build（release） → 生产路径（app_data_dir，首次为空）
            // 注意：不能用 CARGO_MANIFEST_DIR 判断，因为生产 exe 仍包含开发机上的路径，只需在 debug 块内使用。
            if cfg!(debug_assertions) {
                // ── dev 模式 ──
                // characters → <project>/characters/  （git 可追踪）
                // logs       → <project>/logs/
                let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                let project_root = manifest_dir.parent().unwrap_or(&PathBuf::from(".")).to_path_buf();
                let dev_chars = project_root.join("characters");
                fs::create_dir_all(&dev_chars)?;
                CHARACTERS_DIR.set(dev_chars).map_err(|_| "CHARACTERS_DIR already set")?;
                let logs = project_root.join("logs");
                fs::create_dir_all(&logs)?;
                LOGS_DIR.set(logs).map_err(|_| "LOGS_DIR already set")?;
            } else {
                // ── 生产模式 ──
                // characters → <app_data_dir>/characters/（首次为空，由用户导入角色包填充）
                // logs       → <app_data_dir>/logs/
                // 不再随程序分发预置角色，也不做首次拷贝。
                let d = app.path().app_data_dir()?;
                let chars_dir = d.join("characters");
                let logs_dir = d.join("logs");
                fs::create_dir_all(&chars_dir)?;
                fs::create_dir_all(&logs_dir)?;

                CHARACTERS_DIR.set(chars_dir).map_err(|_| "CHARACTERS_DIR already set")?;
                LOGS_DIR.set(logs_dir).map_err(|_| "LOGS_DIR already set")?;
            }

            // ─── 全局光标轮询（主窗口鼠标穿透命中测试） ───
            // 主窗口透明，透明区域需让鼠标穿透到下方窗口。穿透开启后 WebView
            // 收不到 mousemove，无法判断何时切回，故独立轮询全局光标位置 emit
            // 给前端，由前端命中测试后切换 set_ignore_cursor_events。仅 Windows。
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use windows_sys::Win32::Foundation::POINT;
                    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
                    let mut last = (i32::MIN, i32::MIN);
                    loop {
                        let mut p = POINT { x: 0, y: 0 };
                        // SAFETY: GetCursorPos 仅写入 p，无其他副作用
                        if unsafe { GetCursorPos(&mut p) } != 0 && (p.x, p.y) != last {
                            last = (p.x, p.y);
                            let _ = handle.emit_to("main", "cursor-pos", CursorPos { x: p.x, y: p.y });
                        }
                        std::thread::sleep(std::time::Duration::from_millis(32));
                    }
                });
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
            export_character_pack,
            import_character_pack,
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
