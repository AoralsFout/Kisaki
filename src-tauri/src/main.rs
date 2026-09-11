// 避免 release 模式下在 Windows 额外弹出控制台窗口，请勿删除！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kisaki_lib::run()
}
