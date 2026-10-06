// 发布版不弹控制台窗口。开发版（`tauri dev`）保留 console，
// 否则 Vite 的 HMR 日志和 panic 栈都没有去处。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("188号礼物 启动失败");
}
