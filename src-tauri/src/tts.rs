use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

// ---- CosyVoice TTS ----

/// TTS 返回结果（批处理模式）
#[derive(Serialize)]
pub(crate) struct TtsResult {
    audio_base64: String,
    format: String,
}

/// TTS 流式音频帧事件
#[derive(Clone, Serialize)]
pub(crate) struct TtsChunk {
    /// 所属流的唯一标识，前端据此过滤掉已被取代的旧流的音频帧
    pub(crate) stream_id: String,
    pub(crate) data: String,
    pub(crate) format: String,
    pub(crate) is_last: bool,
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
        match tokio::time::timeout(Duration::from_millis(200), read.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }
}

/// 带超时的 WebSocket 连接
async fn connect_ws_with_timeout<R>(request: R, timeout_duration: Duration) -> Result<WsStream, String>
where
    R: IntoClientRequest + Unpin,
{
    let ws_result = tokio::time::timeout(timeout_duration, connect_async(request))
        .await
        .map_err(|_| format!("WebSocket 连接超时（{}秒）", timeout_duration.as_secs()))?;
    ws_result
        .map(|(ws_stream, _)| ws_stream)
        .map_err(|e| format!("WebSocket 连接失败: {}", e))
}

// ─── WebSocket 连接池（复用 TCP+TLS 连接，减少握手开销） ─────

/// 缓存的 WebSocket 连接（与连接时间戳、端点/凭据指纹）
struct CachedWsConnection {
    write: WsWriteHalf,
    read: WsReadHalf,
    created_at: std::time::Instant,
    ws_url: String,
    api_key: String,
}

/// TTS WebSocket 连接池（最多缓存 1 个连接，30 秒过期）
pub(crate) struct TtsConnectionPool {
    inner: Mutex<Option<CachedWsConnection>>,
}

impl TtsConnectionPool {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 获取缓存的连接（过期、端点/凭据变化或不可用时返回 None）
    pub(crate) async fn take_connection(
        &self,
        ws_url: &str,
        api_key: &str,
        max_age_secs: u64,
    ) -> Option<(WsWriteHalf, WsReadHalf)> {
        let mut guard = self.inner.lock().await;
        let cached = guard.take()?;
        let fresh = cached.created_at.elapsed().as_secs() < max_age_secs;
        let same_endpoint = cached.ws_url == ws_url && cached.api_key == api_key;
        if fresh && same_endpoint {
            Some((cached.write, cached.read))
        } else {
            // 过期或端点/凭据变化：丢弃，避免把旧凭据的连接用于新配置
            drop(cached);
            None
        }
    }

    /// 归还连接供后续复用（记录其端点/凭据指纹）
    pub(crate) async fn put_connection(
        &self,
        write: WsWriteHalf,
        read: WsReadHalf,
        ws_url: String,
        api_key: String,
    ) {
        let mut guard = self.inner.lock().await;
        // 替换旧连接，旧的会被 drop（触发 close frame）
        *guard = Some(CachedWsConnection {
            write,
            read,
            created_at: std::time::Instant::now(),
            ws_url,
            api_key,
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

    let ws_stream = connect_ws_with_timeout(request, Duration::from_secs(15)).await?;

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
        // 读取 task-started 最多等 30 秒，避免半开连接永久挂起
        let msg = match timeout(Duration::from_secs(30), read.next()).await {
            Ok(m) => m,
            Err(_) => return Err("等待 task-started 超时（30 秒无响应）".to_string()),
        };
        match msg {
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
                    write
                        .send(Message::Text(continue_task.to_string()))
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
                        .send(Message::Text(finish_task.to_string()))
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

/// 获取连接（优先从池中取，取不到则新建）
/// 返回 (write, read, task_id, from_pool) — from_pool 表示完成后应归还
async fn acquire_or_connect(
    pool: &TtsConnectionPool,
    ws_url: &str,
    api_key: &str,
    model: &str,
    voice: &str,
) -> Result<(WsWriteHalf, WsReadHalf, String, bool), String> {
    // 尝试从连接池获取（5 秒内且端点/凭据一致才可复用 TCP 连接）
    if let Some((mut write, read)) = pool.take_connection(ws_url, api_key, 5).await {
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

/// 收集音频数据至 Vec（批处理模式的接收循环）
async fn audio_receive_batch(
    write: &mut WsWriteHalf,
    read: &mut WsReadHalf,
    task_id: &str,
    text: &str,
) -> Result<TtsResult, String> {
    cosyvoice_send_text(write, read, task_id, text).await?;

    let mut audio_data: Vec<u8> = Vec::new();
    loop {
        // 读取每帧最多等待 30 秒，避免服务端停滞导致命令永久挂起
        let msg = match timeout(Duration::from_secs(30), read.next()).await {
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
                        return Err(format!(
                            "TTS 任务失败: {}",
                            error.unwrap_or_else(|| "未知错误".to_string())
                        ));
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

/// 通过 CosyVoice WebSocket API 合成语音并返回音频数据（base64，批处理）
#[tauri::command]
pub(crate) async fn cosyvoice_tts(
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
    let result = audio_receive_batch(&mut write, &mut read, &task_id, &text).await;
    match &result {
        // 仅在成功且来自连接池时归还连接；出错的连接可能已失效，丢弃而非污染连接池
        Ok(_) if from_pool => pool.put_connection(write, read, ws_url, api_key).await,
        _ => ws_graceful_close(&mut write, &mut read).await,
    }
    result
}

/// 通过 CosyVoice WebSocket API 流式合成语音，逐帧 emit 给前端
#[tauri::command]
pub(crate) async fn cosyvoice_tts_stream(
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
        let msg = match timeout(Duration::from_secs(30), read.next()).await {
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
                        "task-failed" => {
                            break Err(format!(
                                "TTS 任务失败: {}",
                                error.unwrap_or_else(|| "未知错误".to_string())
                            ))
                        }
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
                pool.put_connection(write, read, ws_url, api_key).await;
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

// ---- GPT-SoVITS TTS（通过 Rust 代理请求以绕过 CORS） ----

/// GPT-SoVITS 专用 HTTP 客户端：禁用系统代理，避免本地回环请求（127.0.0.1）被系统 HTTP 代理拦截
fn gptsovits_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))
}

/// GPT-SoVITS 合成结果
#[derive(Serialize)]
pub(crate) struct GptSoVitsResult {
    pub(crate) audio_base64: String,
    pub(crate) format: String,
}

/// 通过 Rust 后端请求 GPT-SoVITS API（解决 webview CORS 限制）
#[tauri::command]
pub(crate) async fn gptsovits_tts(url: String) -> Result<GptSoVitsResult, String> {
    let response = gptsovits_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GPT-SoVITS 请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT-SoVITS API 错误 ({}): {}", status, body));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/wav")
        .to_string();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if bytes.is_empty() {
        return Err("GPT-SoVITS 返回空音频".to_string());
    }

    let engine = base64::engine::general_purpose::STANDARD;
    let audio_base64 = engine.encode(&bytes);

    let format = if content_type.contains("ogg") {
        "ogg"
    } else if content_type.contains("aac") {
        "aac"
    } else if content_type.contains("raw") || content_type.contains("L16") {
        "raw"
    } else {
        "wav"
    }.to_string();

    eprintln!("GPT-SoVITS 合成完成: {} bytes ({})", bytes.len(), format);

    Ok(GptSoVitsResult { audio_base64, format })
}

/// GPT-SoVITS 流式合成 — 逐 chunk emit 给前端，前端边收边播
#[tauri::command]
pub(crate) async fn gptsovits_tts_stream(
    app_handle: tauri::AppHandle,
    stream_id: String,
    url: String,
) -> Result<(), String> {
    eprintln!("GPT-SoVITS 流式请求: stream_id={}", stream_id);

    let response = gptsovits_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GPT-SoVITS 请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GPT-SoVITS API 错误 ({}): {}", status, body));
    }

    let engine = base64::engine::general_purpose::STANDARD;
    let mut chunk_count = 0u32;

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("读取流失败: {}", e))?;
        if chunk.is_empty() {
            continue;
        }
        chunk_count += 1;
        let data = engine.encode(&chunk);
        let is_last = false; // 还不知道是否最后，最后单独发结束信号
        let _ = app_handle.emit("tts-audio-chunk", TtsChunk {
            stream_id: stream_id.clone(),
            data,
            format: "wav".to_string(),
            is_last,
        });
    }

    // 发送结束标记
    let _ = app_handle.emit("tts-audio-chunk", TtsChunk {
        stream_id: stream_id.clone(),
        data: String::new(),
        format: "wav".to_string(),
        is_last: true,
    });

    eprintln!("GPT-SoVITS 流式完成: stream_id={}, {} chunks", stream_id, chunk_count);
    Ok(())
}
