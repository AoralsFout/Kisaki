/// 全局光标位置事件 payload（物理屏幕坐标）——前端鼠标穿透命中测试用
#[derive(Clone, serde::Serialize)]
pub(crate) struct CursorPos {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

/// 启动全局光标轮询线程，用于透明窗口的鼠标穿透命中测试。
///
/// 主窗口透明，透明区域需让鼠标穿透到下方窗口。穿透开启后 WebView 收不到
/// mousemove，无法判断何时切回，故独立轮询全局光标位置 emit 给前端，由前端
/// 命中测试后切换 set_ignore_cursor_events。
///
/// 光标位置通过 Tauri 的 `AppHandle::cursor_position()` 获取，该 API 内部会把
/// 查询调度到事件循环主线程执行（跨线程安全），因此可在后台线程轮询，且在
/// Windows / macOS / Linux(X11) 上均返回真实桌面坐标。
///
/// 平台限制：
///   - Linux(Wayland)：底层（tao）受 Wayland 协议限制无法获取全局光标坐标，
///     恒返回 (0,0)，故鼠标穿透在 Wayland 下不可用（已知限制，无法绕过）。
pub(crate) fn start_polling(app_handle: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        // 稍等事件循环 / 窗口就绪，避免启动早期查询失败。
        std::thread::sleep(std::time::Duration::from_millis(500));

        let mut last = (i32::MIN, i32::MIN);
        loop {
            // cursor_position 失败（如窗口尚未就绪）时跳过本次轮询。
            if let Ok(p) = app_handle.cursor_position() {
                let pos = (p.x as i32, p.y as i32);
                if pos != last {
                    last = pos;
                    let _ = app_handle.emit_to(
                        "main",
                        "cursor-pos",
                        CursorPos { x: pos.0, y: pos.1 },
                    );
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(32));
        }
    });
}
