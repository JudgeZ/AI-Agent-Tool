#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use glib::MainContext;

fn main() {
    // Ensure we eagerly initialize the GLib main context so that async helpers can
    // reuse the shared context across platform builds.
    #[cfg(target_os = "linux")]
    let _default_context = MainContext::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
