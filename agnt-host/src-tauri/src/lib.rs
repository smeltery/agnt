#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[cfg(test)]
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod app_types;
mod bridge_runtime;
mod diagnostics;
mod host_config;
mod network;
mod pet_window;
mod process_helpers;
mod process_runtime;
mod provider_bridge;
mod runtime_bundle;

use app_types::{AppState, AppStatus, DebugInfo, LogEntry, UpdateInfo};
use bridge_runtime::{start_bridge, stop_bridge};
use diagnostics::DiagnosticsSnapshot;
use host_config::{config_path, load_config, save_config, AppConfig};
use network::detect_network_interfaces;
pub use network::NetworkInterface;
use process_helpers::{find_available_port, get_repo_root, is_port_available};
use process_runtime::{start_all, start_relay, stop_all, stop_relay};
#[cfg(test)]
use runtime_bundle::{
    bundle_manifests_match, copy_fixture_runtime_from_bundle, read_bundle_manifest, BundleManifest,
    BUNDLE_MANIFEST,
};
use runtime_bundle::{refresh_runtime_from_bundle, RuntimeBundleStatus};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
// ─── Helpers ─────────────────────────────────────────────────

fn processes_are_running(app_handle: &tauri::AppHandle) -> bool {
    let state = app_handle.state::<AppState>();
    let relay_running = state
        .relay_process
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    let bridge_running = state
        .bridge_process
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    relay_running || bridge_running
}

fn current_app_status(app_handle: &tauri::AppHandle) -> Result<AppStatus, String> {
    let state = app_handle.state::<AppState>();

    let bridge = {
        state
            .bridge_process
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map_or("stopped", |_| "running")
            .to_string()
    };
    let network = state.selected_ip.lock().map_err(|e| e.to_string())?.clone();
    let relay_url = state.relay_url.lock().map_err(|e| e.to_string())?.clone();
    let pairing_payload = state
        .pairing_payload
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let pairing_code = state
        .pairing_code
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let phone_connected = *state.phone_connected.lock().map_err(|e| e.to_string())?;
    let relay_mode = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .relay_mode
        .clone();

    let relay_status = if relay_mode == "remote" {
        "external".to_string()
    } else {
        state
            .relay_process
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map_or("stopped", |_| "running")
            .to_string()
    };

    let state_str = if phone_connected && bridge == "running" {
        "connected"
    } else if relay_status == "running" && bridge == "running" && pairing_payload.is_some() {
        if relay_mode == "remote" {
            "remote_placeholder_ready"
        } else {
            "local_ready"
        }
    } else if bridge == "running" {
        "waiting_for_pairing"
    } else if relay_status == "running" {
        "relay_running"
    } else {
        "stopped"
    };

    Ok(AppStatus {
        state: state_str.to_string(),
        relay_mode,
        relay: relay_status,
        bridge,
        network,
        relay_url,
        pairing_payload,
        pairing_code,
        phone_connected,
    })
}

pub(crate) fn emit_current_status(app_handle: &tauri::AppHandle) {
    if let Ok(status) = current_app_status(app_handle) {
        let _ = app_handle.emit("status-changed", status);
    }
}

pub(crate) fn add_log(app_handle: &tauri::AppHandle, source: &str, level: &str, message: &str) {
    let state = app_handle.state::<AppState>();
    let entry = LogEntry {
        timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
        source: source.to_string(),
        level: level.to_string(),
        message: message.to_string(),
    };

    if let Ok(mut logs) = state.logs.lock() {
        logs.push(entry.clone());
        if logs.len() > 1000 {
            logs.remove(0);
        }
    }

    let _ = app_handle.emit("log-entry", entry);

    // Detect phone connection from relay logs
    if source == "relay" && message.contains("Mobile connected") {
        let _ = app_handle.emit("phone-connected", message.to_string());
        if let Ok(mut pc) = state.phone_connected.lock() {
            *pc = true;
        }
        emit_current_status(app_handle);
        show_notification("Agnt Host", "Phone connected!");
    }

    // Detect phone disconnect
    if source == "relay" && message.contains("Mobile disconnected") {
        let _ = app_handle.emit("phone-disconnected", message.to_string());
        if let Ok(mut pc) = state.phone_connected.lock() {
            *pc = false;
        }
        emit_current_status(app_handle);
    }
}

// ─── Registry helpers (Windows) ──────────────────────────────

fn set_launch_at_startup(enable: bool) {
    #[cfg(not(target_os = "windows"))]
    let _ = enable;

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let exe_path = std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let name = "AgntHost";
        if enable {
            let mut cmd = Command::new("reg");
            cmd.args([
                "add", key, "/v", name, "/t", "REG_SZ", "/d", &exe_path, "/f",
            ]);
            #[cfg(target_os = "windows")]
            {
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.output();
        } else {
            let mut cmd = Command::new("reg");
            cmd.args(["delete", key, "/v", name, "/f"]);
            #[cfg(target_os = "windows")]
            {
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.output();
        }
    }
}

fn show_notification(title: &str, body: &str) {
    #[cfg(target_os = "windows")]
    {
        let ps = format!(
            r#"Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipIcon = 'Info'; $n.BalloonTipTitle = '{}'; $n.BalloonTipText = '{}'; $n.Visible = $true; $n.ShowBalloonTip(3000); Start-Sleep -Seconds 3; $n.Dispose()"#,
            title, body
        );
        let _ = Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-Command", &ps])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!(r#"display notification "{}" with title "{}""#, body, title),
            ])
            .spawn();
    }
}

// ─── Tauri commands ─────────────────────────────────────────

#[tauri::command]
fn detect_networks() -> Result<Vec<NetworkInterface>, String> {
    Ok(detect_network_interfaces())
}

pub(crate) fn runtime_process_status(app_handle: &tauri::AppHandle) -> (bool, bool) {
    let state = app_handle.state::<AppState>();
    let relay_running = state
        .relay_process
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    let bridge_running = state
        .bridge_process
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    (relay_running, bridge_running)
}

#[tauri::command]
fn refresh_bundled_runtime(app_handle: tauri::AppHandle) -> Result<RuntimeBundleStatus, String> {
    let running = processes_are_running(&app_handle);
    let status = refresh_runtime_from_bundle(running)?;
    if status.runtime_current {
        add_log(
            &app_handle,
            "app",
            "info",
            "Runtime bridge and relay are current",
        );
    } else if status.refresh_deferred {
        add_log(
            &app_handle,
            "app",
            "warning",
            "Runtime refresh deferred until bridge and relay stop",
        );
    } else if status.refresh_available {
        add_log(&app_handle, "app", "warning", &status.message);
    }
    Ok(status)
}

#[tauri::command]
async fn get_diagnostics(app_handle: tauri::AppHandle) -> Result<DiagnosticsSnapshot, String> {
    diagnostics::build_diagnostics_snapshot(app_handle).await
}

#[tauri::command]
fn select_network(app_handle: tauri::AppHandle, ip: String) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    {
        let mut selected = state.selected_ip.lock().map_err(|e| e.to_string())?;
        *selected = ip.clone();
    }
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.selected_ip = ip.clone();
        save_config(&config);
    }
    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Selected network: {ip}"),
    );
    Ok(())
}

#[tauri::command]
fn get_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    let state = app_handle.state::<AppState>();
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
fn save_config_cmd(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    let old_startup = current.launch_at_startup;
    *current = config.clone();
    save_config(&config);
    // Update registry if launch_at_startup changed
    if config.launch_at_startup != old_startup {
        set_launch_at_startup(config.launch_at_startup);
    }
    Ok(())
}

#[tauri::command]
fn get_logs(app_handle: tauri::AppHandle) -> Result<Vec<LogEntry>, String> {
    let state = app_handle.state::<AppState>();
    let logs = state.logs.lock().map_err(|e| e.to_string())?;
    Ok(logs.clone())
}

#[tauri::command]
fn clear_logs(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut logs = state.logs.lock().map_err(|e| e.to_string())?;
    logs.clear();
    Ok(())
}

#[tauri::command]
fn get_status(app_handle: tauri::AppHandle) -> Result<AppStatus, String> {
    current_app_status(&app_handle)
}

#[tauri::command]
fn set_relay_mode(app_handle: tauri::AppHandle, mode: String) -> Result<(), String> {
    if mode != "local" && mode != "remote" {
        return Err("relay_mode must be 'local' or 'remote'".to_string());
    }
    let state = app_handle.state::<AppState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.relay_mode = mode.clone();
    save_config(&config);
    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Relay mode set to: {mode}"),
    );
    Ok(())
}

#[tauri::command]
fn set_remote_relay_url(app_handle: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err("Remote URL must start with ws:// or wss://".to_string());
    }
    let state = app_handle.state::<AppState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.remote_relay_url = url;
    save_config(&config);
    add_log(&app_handle, "app", "info", "Remote relay URL updated");
    Ok(())
}

#[tauri::command]
fn get_pairing_payload(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let state = app_handle.state::<AppState>();
    let payload = state.pairing_payload.lock().map_err(|e| e.to_string())?;
    Ok(payload.clone())
}

#[tauri::command]
fn check_port(port: u16) -> Result<serde_json::Value, String> {
    let available = is_port_available(port);
    let suggested = if !available {
        Some(find_available_port(port))
    } else {
        None
    };
    Ok(serde_json::json!({
        "available": available,
        "suggested": suggested,
    }))
}

#[tauri::command]
fn complete_setup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.setup_completed = true;
    save_config(&config);
    Ok(())
}

#[tauri::command]
fn show_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        let _ = app_handle.emit("show-qr", ());
        return Ok(());
    }
    Err("main window not found".to_string())
}

#[tauri::command]
fn notify(title: String, body: String) {
    show_notification(&title, &body);
}

#[tauri::command]
fn debug_paths() -> Result<DebugInfo, String> {
    build_debug_paths()
}

pub(crate) fn build_debug_paths() -> Result<DebugInfo, String> {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let repo_root = get_repo_root();
    let relay_dir = repo_root.join("relay");
    let bridge_dir = repo_root.join("agnt-bridge");

    let node_version = Command::new("node")
        .args(["-e", "console.log(process.version)"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(DebugInfo {
        cwd,
        repo_root: repo_root.display().to_string(),
        relay_dir: relay_dir.display().to_string(),
        relay_server_exists: relay_dir.join("server.js").exists(),
        bridge_dir: bridge_dir.display().to_string(),
        bridge_bin_exists: bridge_dir.join("bin").join("agnt.js").exists(),
        config_path: config_path().display().to_string(),
        config_exists: config_path().exists(),
        node_version,
    })
}

#[tauri::command]
async fn check_for_update(app_handle: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app_handle
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        current_version: update.current_version,
        date: update.date.map(|d| d.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
async fn install_update(app_handle: tauri::AppHandle) -> Result<(), String> {
    let update = app_handle
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    let Some(update) = update else {
        add_log(&app_handle, "app", "info", "No update available");
        return Ok(());
    };

    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Installing Agnt Host update {}", update.version),
    );

    update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
        .await
        .map_err(|e| format!("update install failed: {e}"))?;

    add_log(&app_handle, "app", "info", "Update installed; restarting");
    app_handle.restart();
}

// ─── Main ───────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_config = load_config();

    let state = AppState {
        relay_process: Mutex::new(None),
        bridge_process: Mutex::new(None),
        logs: Mutex::new(Vec::new()),
        config: Mutex::new(app_config.clone()),
        pairing_payload: Mutex::new(None),
        selected_ip: Mutex::new(app_config.selected_ip.clone()),
        relay_url: Mutex::new(String::new()),
        phone_connected: Mutex::new(false),
        pairing_code: Mutex::new(None),
        relay_intentional: Mutex::new(false),
        bridge_intentional: Mutex::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .manage(provider_bridge::state::ProviderBridgeRuntime::default())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            match refresh_runtime_from_bundle(false) {
                Ok(status) if status.runtime_current => {
                    add_log(
                        app.handle(),
                        "app",
                        "info",
                        "Runtime bridge and relay are current",
                    );
                }
                Ok(status) if status.refresh_available => {
                    add_log(app.handle(), "app", "warning", &status.message);
                }
                Ok(_) => {}
                Err(error) => {
                    add_log(
                        app.handle(),
                        "app",
                        "error",
                        &format!("Runtime refresh failed: {error}"),
                    );
                }
            }

            // Close to tray: intercept window close, hide instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // Start minimized if configured
            if app_config.start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            pet_window::create_pet_windows(app, app_config.relay_mode == "local")?;

            // Emit first-run flag to frontend
            if !app_config.setup_completed {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = h.emit("first-run", ());
                });
            }

            let show = MenuItemBuilder::with_id("show", "Show Agnt Host").build(app)?;
            let show_qr = MenuItemBuilder::with_id("show_qr", "Show QR").build(app)?;
            let start = MenuItemBuilder::with_id("start", "Start All").build(app)?;
            let stop = MenuItemBuilder::with_id("stop", "Stop All").build(app)?;
            let restart_bridge =
                MenuItemBuilder::with_id("restart_bridge", "Restart Bridge").build(app)?;
            let restart_relay =
                MenuItemBuilder::with_id("restart_relay", "Restart Relay").build(app)?;
            let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let logs = MenuItemBuilder::with_id("open_logs", "Open Logs").build(app)?;
            let sep2 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .item(&show_qr)
                .separator()
                .item(&start)
                .item(&stop)
                .item(&restart_bridge)
                .item(&restart_relay)
                .item(&sep1)
                .item(&logs)
                .item(&sep2)
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Agnt Host")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "show_qr" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = app.emit("show-qr", ());
                            }
                        }
                        "start" => {
                            let handle = app.app_handle().clone();
                            let _ = start_all(handle);
                        }
                        "stop" => {
                            let handle = app.app_handle().clone();
                            let _ = stop_all(handle);
                        }
                        "restart_bridge" => {
                            let handle = app.app_handle().clone();
                            let _ = stop_bridge(handle.clone());
                            std::thread::sleep(Duration::from_millis(500));
                            let _ = start_bridge(handle);
                        }
                        "restart_relay" => {
                            let handle = app.app_handle().clone();
                            let _ = stop_relay(handle.clone());
                            std::thread::sleep(Duration::from_millis(500));
                            let _ = start_relay(handle);
                        }
                        "open_logs" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            // Kill child processes before exit
                            let handle = app.app_handle().clone();
                            let _ = stop_all(handle);
                            std::thread::sleep(Duration::from_millis(500));
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_networks,
            select_network,
            get_config,
            save_config_cmd,
            process_runtime::start_relay,
            process_runtime::stop_relay,
            bridge_runtime::start_bridge,
            bridge_runtime::stop_bridge,
            process_runtime::start_all,
            process_runtime::stop_all,
            get_logs,
            clear_logs,
            get_status,
            get_pairing_payload,
            debug_paths,
            check_port,
            complete_setup,
            show_main_window,
            pet_window::move_pet_window,
            pet_window::get_pet_window_position,
            pet_window::show_pet_popup,
            pet_window::hide_pet_popup,
            notify,
            set_relay_mode,
            set_remote_relay_url,
            refresh_bundled_runtime,
            get_diagnostics,
            check_for_update,
            install_update,
            provider_bridge::commands::start_provider_bridge,
            provider_bridge::commands::stop_provider_bridge,
            provider_bridge::commands::get_provider_bridge_status,
            provider_bridge::commands::get_provider_bridge_codex_config,
            provider_bridge::commands::get_provider_bridge_key_status,
            provider_bridge::commands::set_provider_bridge_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::relay_url_policy;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("agnt-host-{name}-{}-{nanos}", std::process::id()))
    }

    fn write_file(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn fixture_manifest(bridge_hash: &str, relay_hash: &str) -> String {
        format!(
            r#"{{
  "schemaVersion": 1,
  "generatedAt": "2026-05-13T00:00:00.000Z",
  "relay": {{"package": {{"name": "agnt-relay", "version": null}}, "hash": "{relay_hash}"}},
  "bridge": {{"package": {{"name": "agnt", "version": "1.0.0"}}, "hash": "{bridge_hash}"}}
}}"#,
        )
    }

    fn create_bundle(root: &Path, bridge_hash: &str, relay_hash: &str) {
        write_file(&root.join("relay").join("server.js"), "relay");
        write_file(
            &root.join("agnt-bridge").join("bin").join("agnt.js"),
            "bridge",
        );
        write_file(
            &root.join(BUNDLE_MANIFEST),
            &fixture_manifest(bridge_hash, relay_hash),
        );
    }

    #[test]
    fn relay_url_policy_accepts_lan_tailscale_and_secure_public() {
        assert_eq!(relay_url_policy("ws://192.168.1.5:9000/relay").0, "pass");
        assert_eq!(
            relay_url_policy("ws://100.100.100.100:9000/relay").0,
            "pass"
        );
        assert_eq!(
            relay_url_policy("ws://macbook.tailnet.ts.net:9000/relay").0,
            "pass"
        );
        assert_eq!(relay_url_policy("wss://relay.example.com/relay").0, "pass");
    }

    #[test]
    fn relay_url_policy_rejects_public_cleartext_and_credentials() {
        assert_eq!(relay_url_policy("ws://relay.example.com/relay").0, "fail");
        assert_eq!(
            relay_url_policy("wss://user:pass@relay.example.com/relay").0,
            "fail"
        );
    }

    #[test]
    fn bundle_manifests_match_when_hashes_and_versions_match() {
        let a = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-a", "relay-a"))
            .unwrap();
        let b = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-a", "relay-a"))
            .unwrap();
        let c = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-b", "relay-a"))
            .unwrap();
        assert!(bundle_manifests_match(&a, &b));
        assert!(!bundle_manifests_match(&a, &c));
    }

    #[test]
    fn runtime_refresh_copies_missing_runtime() {
        let root = temp_dir("missing-runtime");
        let bundle = root.join("bundle");
        let runtime = root.join("runtime");
        create_bundle(&bundle, "bridge-a", "relay-a");

        copy_fixture_runtime_from_bundle(&bundle, &runtime).unwrap();

        assert!(runtime.join("relay").join("server.js").exists());
        assert!(runtime
            .join("agnt-bridge")
            .join("bin")
            .join("agnt.js")
            .exists());
        assert_eq!(
            read_bundle_manifest(&runtime).unwrap().bridge.hash,
            "bridge-a",
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_refresh_replaces_stale_runtime_after_temp_copy_succeeds() {
        let root = temp_dir("stale-runtime");
        let bundle = root.join("bundle");
        let runtime = root.join("runtime");
        create_bundle(&bundle, "bridge-new", "relay-new");
        create_bundle(&runtime, "bridge-old", "relay-old");

        copy_fixture_runtime_from_bundle(&bundle, &runtime).unwrap();

        let manifest = read_bundle_manifest(&runtime).unwrap();
        assert_eq!(manifest.bridge.hash, "bridge-new");
        assert_eq!(manifest.relay.hash, "relay-new");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_refresh_failure_keeps_existing_runtime() {
        let root = temp_dir("failed-runtime");
        let bundle = root.join("bundle");
        let runtime = root.join("runtime");
        write_file(&bundle.join("relay").join("server.js"), "relay");
        create_bundle(&runtime, "bridge-old", "relay-old");

        assert!(copy_fixture_runtime_from_bundle(&bundle, &runtime).is_err());
        let manifest = read_bundle_manifest(&runtime).unwrap();
        assert_eq!(manifest.bridge.hash, "bridge-old");
        let _ = fs::remove_dir_all(root);
    }
}
