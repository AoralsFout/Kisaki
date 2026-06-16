/// 全局光标位置事件 payload（物理屏幕坐标）——前端鼠标穿透命中测试用
#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
pub(crate) struct CursorPos {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

/// 启动全局光标轮询线程（Windows 专用，用于透明窗口鼠标穿透命中测试）。
/// 非 Windows 平台为空操作。
pub(crate) fn start_polling(app_handle: tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let handle = app_handle.clone();
        std::thread::spawn(move || {
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

    #[cfg(not(windows))]
    let _ = app_handle;
}
