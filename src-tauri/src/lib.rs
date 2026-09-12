mod app_paths;
mod backup;
mod character;
mod command;
mod composition_root;
mod cursor;
mod data;
mod fileio;
mod log;
mod pack;
mod path;
mod screenshot;
mod secure;
mod sessions;
mod tray;
mod tts;
mod websearch;
mod workspace_grants;

#[cfg(test)]
mod test_support;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 单实例：二次启动只唤回已存在的主窗口，避免多进程争抢同一份数据
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        // 开机自启（前端设置开关控制；macOS 走 LaunchAgent）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 全局快捷键（setup 内注册 Alt+K 唤出/隐藏）
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 桌面通知
        .plugin(tauri_plugin_notification::init())
        // 自动更新（pubkey / endpoints 由 tauri.conf.json 的 plugins.updater 提供；
        // 未配置时前端「检查更新」会优雅降级为提示，不会崩溃）
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 进程控制（更新安装完成后自动重启）
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let paths = composition_root::setup(app)?;
            log::install_panic_hook();
            // asset:// 仅允许读取角色目录。静态配置保持空 scope，运行时加入实际目录，
            // 兼容 dev 的仓库 characters/ 与生产 app_data_dir，同时避免暴露全盘文件。
            app.asset_protocol_scope()
                .allow_directory(paths.characters_dir(), true)?;

            // ─── 全局光标轮询（主窗口鼠标穿透命中测试） ───
            // 主窗口透明，透明区域需让鼠标穿透到下方窗口。穿透开启后 WebView
            // 收不到 mousemove，无法判断何时切回，故独立轮询全局光标位置 emit
            // 给前端，由前端命中测试后切换 set_ignore_cursor_events。仅 Windows。
            cursor::start_polling(app.handle().clone());

            // ─── 系统托盘（无边框窗口的跨平台唤回 / 退出入口） ───
            tray::setup_tray(app.handle())?;

            // ─── 全局快捷键：Alt+K 唤出 / 隐藏主窗口 ───
            // 无边框桌宠在「鼠标穿透态」下无法点击，快捷键作为稳定的唤回入口。
            // 注册失败（被其它应用占用）仅告警，不阻断启动。
            {
                let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyK);
                if let Err(e) =
                    app.global_shortcut()
                        .on_shortcut(shortcut, |app, _shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                tray::toggle_main_window(app);
                            }
                        })
                {
                    log::write_native_log(
                        "warn",
                        "Shortcut",
                        format!("注册全局快捷键 Alt+K 失败: {e}"),
                    );
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            character::write_character_file,
            character::save_character_image,
            character::delete_character_image,
            character::delete_character,
            character::list_characters,
            character::list_character_summaries,
            character::list_data_dir_characters,
            character::get_data_dirs,
            character::read_character_file,
            character::import_live2d_model,
            pack::export_character_pack,
            pack::import_character_pack,
            tts::cosyvoice_tts,
            tts::cosyvoice_tts_stream,
            tts::gptsovits_tts,
            tts::gptsovits_tts_stream,
            log::append_log_entries,
            log::read_log_file,
            log::read_log_file_page,
            log::export_log_file,
            log::list_log_files,
            log::prune_log_files,
            fileio::agent_pick_workspace,
            fileio::agent_resolve_workspace,
            fileio::agent_revoke_workspace,
            fileio::agent_read_file,
            fileio::agent_read_image,
            fileio::agent_write_file,
            fileio::agent_append_file,
            fileio::agent_list_dir,
            fileio::agent_delete_file,
            fileio::agent_read_lines,
            fileio::agent_edit_lines,
            fileio::agent_find_files,
            fileio::agent_search_in_files,
            screenshot::agent_capture_screen,
            command::agent_prepare_execution,
            command::agent_approve_execution,
            command::agent_execute_plan,
            command::agent_cancel_execution,
            backup::agent_checkpoint_backup,
            backup::agent_checkpoint_rollback,
            backup::agent_checkpoint_clear_session,
            websearch::web_search_fetch,
            secure::secure_store_set,
            secure::secure_store_get,
            secure::secure_store_delete,
            sessions::sessions_v2_load,
            sessions::sessions_v2_save,
            sessions::sessions_v2_clear,
            data::export_data_backup,
            data::import_data_backup,
            data::reset_all_local_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
