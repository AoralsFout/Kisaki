mod backup;
mod character;
mod command;
mod cursor;
mod fileio;
mod log;
mod pack;
mod path;
mod tts;

use std::path::PathBuf;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(tts::TtsConnectionPool::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 区分 dev / 生产模式：
            //   cfg!(debug_assertions) = true  → tauri dev（debug 编译）→ dev 路径，git 可追踪
            //   cfg!(debug_assertions) = false → tauri build（release） → 生产路径（app_data_dir，首次为空）
            // 注意：不能用 CARGO_MANIFEST_DIR 判断，因为生产 exe 仍包含开发机上的路径，只需在 debug 块内使用。
            let (chars_dir, logs_dir) = if cfg!(debug_assertions) {
                // ── dev 模式 ──
                // characters → <project>/characters/  （git 可追踪）
                // logs       → <project>/logs/
                let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                let project_root = manifest_dir
                    .parent()
                    .unwrap_or(&PathBuf::from("."))
                    .to_path_buf();
                (
                    project_root.join("characters"),
                    project_root.join("logs"),
                )
            } else {
                // ── 生产模式 ──
                // characters → <app_data_dir>/characters/（首次为空，由用户导入角色包填充）
                // logs       → <app_data_dir>/logs/
                // 不再随程序分发预置角色，也不做首次拷贝。
                let d = app.path().app_data_dir()?;
                (d.join("characters"), d.join("logs"))
            };
            path::init_dirs(chars_dir, logs_dir, app.path().app_cache_dir()?.join("backups"))?;

            // ─── 全局光标轮询（主窗口鼠标穿透命中测试） ───
            // 主窗口透明，透明区域需让鼠标穿透到下方窗口。穿透开启后 WebView
            // 收不到 mousemove，无法判断何时切回，故独立轮询全局光标位置 emit
            // 给前端，由前端命中测试后切换 set_ignore_cursor_events。仅 Windows。
            cursor::start_polling(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            character::write_character_file,
            character::save_character_image,
            character::delete_character_image,
            character::delete_character,
            character::list_characters,
            character::list_data_dir_characters,
            character::get_data_dirs,
            character::read_character_file,
            pack::export_character_pack,
            pack::import_character_pack,
            tts::cosyvoice_tts,
            tts::cosyvoice_tts_stream,
            log::append_log_entries,
            log::read_log_file,
            log::export_log_file,
            log::list_log_files,
            fileio::agent_read_file,
            fileio::agent_write_file,
            fileio::agent_append_file,
            fileio::agent_list_dir,
            fileio::agent_delete_file,
            fileio::agent_read_lines,
            fileio::agent_edit_lines,
            fileio::agent_find_files,
            fileio::agent_search_in_files,
            command::agent_execute_command,
            backup::agent_checkpoint_backup,
            backup::agent_checkpoint_rollback,
            backup::agent_checkpoint_clear_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
