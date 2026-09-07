//! AI 屏幕截图命令。
//!
//! 截图仅在内存中编码为 PNG 并返回给前端，不写入临时文件或日志。
//! 前端负责逐次向用户确认，并在默认模式下短暂隐藏 Kisaki 主窗口。

use std::io::Cursor;

use base64::Engine;
use serde::Serialize;
use xcap::image::{imageops::FilterType, DynamicImage, ImageFormat};
use xcap::Monitor;

/// 模型单张图片输入上限，与前端附件限制保持一致。
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// 首次缩放时允许的最长边，避免超高分辨率桌面占用过多上下文。
const MAX_LONG_EDGE: u32 = 2560;
/// 超限后逐步缩小的最短边界，避免无限重试。
const MIN_LONG_EDGE: u32 = 640;

#[derive(Serialize)]
pub(crate) struct ScreenCaptureResult {
    data_url: String,
    mime_type: &'static str,
    size: u64,
    name: String,
    width: u32,
    height: u32,
    monitor_name: String,
}

fn select_monitor(target: &str, cursor: Option<(i32, i32)>) -> Result<Monitor, String> {
    if target == "cursor_monitor" {
        if let Some((x, y)) = cursor {
            if let Ok(monitor) = Monitor::from_point(x, y) {
                return Ok(monitor);
            }
        }
    } else if target != "primary_monitor" {
        return Err(format!(
            "未知截图目标: {target}（仅支持 cursor_monitor / primary_monitor）"
        ));
    }

    let monitors = Monitor::all().map_err(|e| format!("无法枚举显示器: {e}"))?;
    if monitors.is_empty() {
        return Err("未检测到可截图的显示器".to_string());
    }
    let primary_index = monitors
        .iter()
        .position(|monitor| monitor.is_primary().unwrap_or(false))
        .unwrap_or(0);
    monitors
        .into_iter()
        .nth(primary_index)
        .ok_or_else(|| "未检测到主显示器".to_string())
}

fn fit_dimensions(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_long_edge {
        return (width, height);
    }
    let scale = max_long_edge as f64 / longest as f64;
    (
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    )
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| format!("截图 PNG 编码失败: {e}"))?;
    Ok(cursor.into_inner())
}

fn capture(target: String, cursor: Option<(i32, i32)>) -> Result<ScreenCaptureResult, String> {
    let monitor = select_monitor(&target, cursor)?;
    let monitor_name = monitor
        .friendly_name()
        .unwrap_or_else(|_| "display".to_string());
    let captured = monitor.capture_image().map_err(|e| {
        format!(
            "截屏失败: {e}。macOS 可能需要在系统设置中授予屏幕录制权限；Linux Wayland 环境可能不受支持。"
        )
    })?;

    let (fitted_width, fitted_height) =
        fit_dimensions(captured.width(), captured.height(), MAX_LONG_EDGE);
    let mut image = DynamicImage::ImageRgba8(captured);
    if image.width() != fitted_width || image.height() != fitted_height {
        image = image.resize_exact(fitted_width, fitted_height, FilterType::Lanczos3);
    }

    let mut png = encode_png(&image)?;
    while png.len() > MAX_IMAGE_BYTES && image.width().max(image.height()) > MIN_LONG_EDGE {
        let next_long_edge =
            ((image.width().max(image.height()) as f64 * 0.8).floor() as u32).max(MIN_LONG_EDGE);
        let (width, height) = fit_dimensions(image.width(), image.height(), next_long_edge);
        image = image.resize_exact(width, height, FilterType::Lanczos3);
        png = encode_png(&image)?;
    }
    if png.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "截图编码后仍过大（{} 字节，上限 {} 字节）",
            png.len(),
            MAX_IMAGE_BYTES
        ));
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(ScreenCaptureResult {
        data_url: format!("data:image/png;base64,{encoded}"),
        mime_type: "image/png",
        size: png.len() as u64,
        name: "screen-capture.png".to_string(),
        width: image.width(),
        height: image.height(),
        monitor_name,
    })
}

/// 截取鼠标所在显示器（失败时回退主显示器）或主显示器。
#[tauri::command]
pub(crate) async fn agent_capture_screen(
    app: tauri::AppHandle,
    target: Option<String>,
) -> Result<ScreenCaptureResult, String> {
    let target = target.unwrap_or_else(|| "cursor_monitor".to_string());
    let cursor = if target == "cursor_monitor" {
        app.cursor_position()
            .ok()
            .map(|position| (position.x as i32, position.y as i32))
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || capture(target, cursor))
        .await
        .map_err(|e| format!("截屏任务异常结束: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::fit_dimensions;

    #[test]
    fn keeps_small_images_unchanged() {
        assert_eq!(fit_dimensions(1920, 1080, 2560), (1920, 1080));
    }

    #[test]
    fn scales_landscape_and_portrait_images_proportionally() {
        assert_eq!(fit_dimensions(5120, 2880, 2560), (2560, 1440));
        assert_eq!(fit_dimensions(2160, 3840, 2560), (1440, 2560));
    }
}
