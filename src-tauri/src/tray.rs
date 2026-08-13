//! 系统托盘 —— 无边框透明窗口的跨平台唤回 / 退出入口。
//!
//! 主窗口 `decorations:false` 且常态开启鼠标穿透，没有标题栏可供操作；一旦隐藏、
//! 最小化或被其他窗口遮挡，用户在三个平台上都缺乏统一的找回方式。托盘补上这一入口：
//!   - 左键单击托盘图标：切换主窗口显示 / 隐藏；
//!   - 右键菜单：「显示 / 隐藏」「退出」。
//!
//! 平台说明：Linux 托盘基于 StatusNotifierItem，需运行时存在
//! libayatana-appindicator（或 libappindicator）及构建期 libxdo；缺少该环境的部分
//! 精简桌面 / 合成器可能不显示托盘图标（菜单功能仍可经其他入口触发）。

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const MENU_TOGGLE: &str = "toggle";
const MENU_QUIT: &str = "quit";

/// 切换主窗口显示 / 隐藏；显示时一并聚焦。
pub(crate) fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// 在 tauri setup 阶段创建系统托盘。
pub(crate) fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id(MENU_TOGGLE, "显示 / 隐藏").build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&toggle, &quit]).build()?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Kisaki")
        .menu(&menu)
        // 左键留给「显示/隐藏」切换，菜单仅右键弹出。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_TOGGLE => toggle_main_window(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // 复用打包配置里的应用图标作为托盘图标。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
