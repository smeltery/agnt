use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{
    add_log,
    app_types::{AppState, AppStatus, DebugInfo, LogEntry, UpdateInfo},
    build_debug_paths, current_app_status,
    diagnostics::{self, DiagnosticsSnapshot},
    host_config::{save_config, AppConfig},
    network::{detect_network_interfaces, NetworkInterface},
    process_helpers::{find_available_port, is_port_available},
    runtime_bundle::{refresh_runtime_from_bundle, RuntimeBundleStatus},
    set_launch_at_startup, show_notification,
};

#[tauri::command]
pub fn detect_networks() -> Result<Vec<NetworkInterface>, String> {
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
pub fn refresh_bundled_runtime(
    app_handle: tauri::AppHandle,
) -> Result<RuntimeBundleStatus, String> {
    let running = crate::processes_are_running(&app_handle);
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
pub async fn get_diagnostics(app_handle: tauri::AppHandle) -> Result<DiagnosticsSnapshot, String> {
    diagnostics::build_diagnostics_snapshot(app_handle).await
}

#[tauri::command]
pub fn select_network(app_handle: tauri::AppHandle, ip: String) -> Result<(), String> {
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
pub fn get_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    let state = app_handle.state::<AppState>();
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
pub fn save_config_cmd(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    let old_startup = current.launch_at_startup;
    *current = config.clone();
    save_config(&config);
    if config.launch_at_startup != old_startup {
        set_launch_at_startup(config.launch_at_startup);
    }
    Ok(())
}

#[tauri::command]
pub fn get_logs(app_handle: tauri::AppHandle) -> Result<Vec<LogEntry>, String> {
    let state = app_handle.state::<AppState>();
    let logs = state.logs.lock().map_err(|e| e.to_string())?;
    Ok(logs.clone())
}

#[tauri::command]
pub fn clear_logs(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut logs = state.logs.lock().map_err(|e| e.to_string())?;
    logs.clear();
    Ok(())
}

#[tauri::command]
pub fn get_status(app_handle: tauri::AppHandle) -> Result<AppStatus, String> {
    current_app_status(&app_handle)
}

#[tauri::command]
pub fn set_relay_mode(app_handle: tauri::AppHandle, mode: String) -> Result<(), String> {
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
pub fn set_remote_relay_url(app_handle: tauri::AppHandle, url: String) -> Result<(), String> {
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
pub fn get_pairing_payload(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let state = app_handle.state::<AppState>();
    let payload = state.pairing_payload.lock().map_err(|e| e.to_string())?;
    Ok(payload.clone())
}

#[tauri::command]
pub fn check_port(port: u16) -> Result<serde_json::Value, String> {
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
pub fn complete_setup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.setup_completed = true;
    save_config(&config);
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        let _ = app_handle.emit("show-qr", ());
        return Ok(());
    }
    Err("main window not found".to_string())
}

#[tauri::command]
pub fn notify(title: String, body: String) {
    show_notification(&title, &body);
}

#[tauri::command]
pub fn debug_paths() -> Result<DebugInfo, String> {
    build_debug_paths()
}

#[tauri::command]
pub async fn check_for_update(app_handle: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
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
pub async fn install_update(app_handle: tauri::AppHandle) -> Result<(), String> {
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
