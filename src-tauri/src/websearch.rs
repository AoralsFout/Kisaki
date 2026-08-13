//! 联网搜索 HTTP 转发
//!
//! WebView 的 `fetch` 受 CORS 限制，多数搜索 API（Brave / SearXNG 实例）不放开
//! 浏览器跨域。此命令用 reqwest 在 Rust 侧转发请求，避开 CORS，同时让 API Key
//! 不经过 WebView 网络栈。前端 `searchHttp.ts` 优先调用本命令。

use std::collections::HashMap;
use std::time::Duration;

/// 搜索响应体大小上限（10 MiB），防超大响应撑爆内存
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// 把错误的 source 链拼成单行文本，便于前端/日志一眼定位根因
/// （如 "error sending request <- tcp connect error <- 由于目标计算机积极拒绝…"）。
fn err_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(inner) = src {
        s.push_str(" <- ");
        s.push_str(&inner.to_string());
        src = inner.source();
    }
    s
}

/// 转发一次搜索 HTTP 请求，返回响应体文本（JSON 字符串）。
///
/// - `method`：GET / POST（大小写不敏感，默认 GET）
/// - `headers`：附加请求头（如 Authorization、X-Subscription-Token）
/// - `body`：POST 的 JSON 字符串
#[tauri::command]
pub(crate) async fn web_search_fetch(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<String, String> {
    // SSRF 缓解：只允许 http/https，阻断 file:// 等本地协议
    let parsed = reqwest::Url::parse(&url).map_err(|_| "无效的 URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("仅允许 http/https 协议".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {}", err_chain(&e)))?;

    let method = method.unwrap_or_else(|| "GET".to_string());
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };

    if let Some(h) = headers {
        for (k, v) in &h {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(b);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", err_chain(&e)))?;

    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", err_chain(&e)))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "搜索响应过大（{} 字节，上限 {} 字节）",
            bytes.len(),
            MAX_RESPONSE_BYTES
        ));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();

    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("HTTP {}: {}", status.as_u16(), snippet));
    }

    Ok(text)
}
