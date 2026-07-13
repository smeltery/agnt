#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
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
mod diagnostics;
mod host_config;
mod network;
mod process_helpers;
mod provider_bridge;
mod runtime_bundle;

use app_types::{AppState, AppStatus, DebugInfo, LogEntry, UpdateInfo};
use diagnostics::DiagnosticsSnapshot;
use host_config::{
    config_path, load_config, provider_bridge_key_status, resolve_provider_bridge_api_key,
    save_config, store_provider_bridge_api_key, AppConfig,
};
use network::detect_network_interfaces;
pub use network::NetworkInterface;
use process_helpers::{
    ensure_deps, find_available_port, get_repo_root, hide_console, is_port_available,
    pipe_stderr_to_logs, pipe_stdout_to_logs, wait_for_port,
};
#[cfg(test)]
use runtime_bundle::{
    bundle_manifests_match, copy_fixture_runtime_from_bundle, read_bundle_manifest, BundleManifest,
    BUNDLE_MANIFEST,
};
use runtime_bundle::{refresh_runtime_from_bundle, RuntimeBundleStatus};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const PET_WINDOW_SIZE: f64 = 80.0;

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

fn emit_current_status(app_handle: &tauri::AppHandle) {
    if let Ok(status) = current_app_status(app_handle) {
        let _ = app_handle.emit("status-changed", status);
    }
}

fn add_log(app_handle: &tauri::AppHandle, source: &str, level: &str, message: &str) {
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

fn fire_wall_warning(app_handle: &tauri::AppHandle, ip: &str, port: u16) {
    if ip == "127.0.0.1" || ip == "localhost" || ip.is_empty() {
        return;
    }
    add_log(
        app_handle,
        "app",
        "warning",
        &format!(
        "Relay is on {ip}:{port}. Windows Firewall may block incoming connections from your phone."
    ),
    );
    let _ = app_handle.emit("firewall-warning", serde_json::json!({
        "ip": ip,
        "port": port,
        "message": "Windows Firewall could be blocking the port. Make sure your phone can reach this PC.",
    }));
    let _ = app_handle.emit(
        "status-changed",
        AppStatus {
            state: "warning".to_string(),
            relay_mode: "local".to_string(),
            relay: "running".to_string(),
            bridge: "stopped".to_string(),
            network: ip.to_string(),
            relay_url: format!("ws://{ip}:{port}/relay"),
            pairing_payload: None,
            pairing_code: None,
            phone_connected: false,
        },
    );
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
fn start_relay(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();

    // Check if already running
    {
        let guard = state.relay_process.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Relay already running".to_string());
        }
    }

    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let port = config.relay_port;

    if !is_port_available(port) {
        return Err(format!("Port {port} is already in use"));
    }

    let repo_root = get_repo_root();
    let relay_dir = repo_root.join("relay");
    let server_js = relay_dir.join("server.js");

    if !server_js.exists() {
        return Err(format!(
            "relay/server.js not found at {}\nRepo root: {}\nCWD: {}",
            server_js.display(),
            repo_root.display(),
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "?".to_string())
        ));
    }

    // Ensure npm dependencies are installed
    if !ensure_deps(&relay_dir, &app_handle) {
        return Err("Failed to install relay dependencies. Check logs for details.".to_string());
    }

    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Starting relay on port {port}..."),
    );

    let mut relay_cmd = Command::new("node");
    relay_cmd
        .arg(&server_js)
        .current_dir(&relay_dir)
        .env("PORT", port.to_string())
        .env("RELAY_PORT", port.to_string())
        .env("RELAY_BIND_HOST", "0.0.0.0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut relay_cmd);
    let mut child = relay_cmd
        .spawn()
        .map_err(|e| format!("Failed to start relay: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let pid = child.id();
    let ah_s = app_handle.clone();
    let ah_e = app_handle.clone();

    pipe_stdout_to_logs(stdout, ah_s, "relay".to_string());
    pipe_stderr_to_logs(stderr, ah_e, "relay".to_string());

    {
        let mut guard = state.relay_process.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }
    let _ = app_handle.emit(
        "status-changed",
        AppStatus {
            state: "starting".to_string(),
            relay_mode: "local".to_string(),
            relay: "starting".to_string(),
            bridge: "stopped".to_string(),
            network: state
                .selected_ip
                .lock()
                .ok()
                .map(|s| s.clone())
                .unwrap_or_default(),
            relay_url: state
                .relay_url
                .lock()
                .ok()
                .map(|s| s.clone())
                .unwrap_or_default(),
            pairing_payload: None,
            pairing_code: None,
            phone_connected: false,
        },
    );

    // Wait for relay to be ready
    let ah_wait = app_handle.clone();
    let wait_port = port;
    std::thread::spawn(move || {
        let ready = wait_for_port(wait_port, 15);
        let state = ah_wait.state::<AppState>();
        if ready {
            add_log(
                &ah_wait,
                "app",
                "info",
                &format!("Relay ready on port {wait_port}"),
            );
        } else {
            add_log(
                &ah_wait,
                "app",
                "error",
                "Relay did not become ready in time",
            );
        }
        // Emit status update
        let _ = ah_wait.emit(
            "status-changed",
            AppStatus {
                state: if ready {
                    "relay_running".to_string()
                } else {
                    "error".to_string()
                },
                relay_mode: "local".to_string(),
                relay: if ready {
                    "running".to_string()
                } else {
                    "error".to_string()
                },
                bridge: "stopped".to_string(),
                network: state
                    .selected_ip
                    .lock()
                    .ok()
                    .map(|s| s.clone())
                    .unwrap_or_default(),
                relay_url: state
                    .relay_url
                    .lock()
                    .ok()
                    .map(|s| s.clone())
                    .unwrap_or_default(),
                pairing_payload: None,
                pairing_code: None,
                phone_connected: false,
            },
        );
    });

    // Build relay URL
    let selected_ip = state.selected_ip.lock().map_err(|e| e.to_string())?.clone();
    let relay_url = if selected_ip.is_empty() {
        format!("ws://127.0.0.1:{port}/relay")
    } else {
        format!("ws://{selected_ip}:{port}/relay")
    };
    {
        let mut url_guard = state.relay_url.lock().map_err(|e| e.to_string())?;
        *url_guard = relay_url.clone();
    }

    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Relay started (PID: {pid})"),
    );
    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Relay URL: {relay_url}"),
    );

    // Firewall warning for LAN IPs
    fire_wall_warning(&app_handle, &selected_ip, port);

    // Crash watcher
    let ah_watch = app_handle.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let state = ah_watch.state::<AppState>();
            let exited = {
                if let Ok(mut guard) = state.relay_process.lock() {
                    if let Some(ref mut child) = *guard {
                        match child.try_wait() {
                            Ok(Some(status)) => Some(status),
                            _ => None,
                        }
                    } else {
                        return; // already stopped
                    }
                } else {
                    return;
                }
            };

            if let Some(status) = exited {
                let intentional = state
                    .relay_intentional
                    .lock()
                    .ok()
                    .map(|i| *i)
                    .unwrap_or(true);
                if let Ok(mut guard) = state.relay_process.lock() {
                    *guard = None;
                }
                if intentional {
                    // reset flag
                    if let Ok(mut i) = state.relay_intentional.lock() {
                        *i = false;
                    }
                    return;
                }
                let code = status.code().unwrap_or(-1);
                add_log(
                    &ah_watch,
                    "app",
                    "error",
                    &format!("Relay crashed (exit code: {code})"),
                );
                let _ = ah_watch.emit(
                    "process-crashed",
                    serde_json::json!({
                        "process": "relay",
                        "exit_code": code,
                    }),
                );
                let _ = ah_watch.emit(
                    "status-changed",
                    AppStatus {
                        state: "error".to_string(),
                        relay_mode: "local".to_string(),
                        relay: "error".to_string(),
                        bridge: "stopped".to_string(),
                        network: state
                            .selected_ip
                            .lock()
                            .ok()
                            .map(|s| s.clone())
                            .unwrap_or_default(),
                        relay_url: state
                            .relay_url
                            .lock()
                            .ok()
                            .map(|s| s.clone())
                            .unwrap_or_default(),
                        pairing_payload: None,
                        pairing_code: None,
                        phone_connected: false,
                    },
                );

                // Auto-restart
                let auto_restart = state
                    .config
                    .lock()
                    .ok()
                    .map(|c| c.auto_restart)
                    .unwrap_or(false);
                if auto_restart {
                    add_log(&ah_watch, "app", "info", "Auto-restarting relay...");
                    let _ = start_relay(ah_watch.clone());
                }
                return;
            }
        }
    });

    Ok(relay_url)
}

#[tauri::command]
fn stop_relay(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    // Mark as intentional stop so crash watcher doesn't report
    if let Ok(mut i) = state.relay_intentional.lock() {
        *i = true;
    }
    let mut guard = state.relay_process.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        add_log(&app_handle, "app", "info", "Stopping relay...");
        child
            .kill()
            .map_err(|e| format!("Failed to kill relay: {e}"))?;
        child
            .wait()
            .map_err(|e| format!("Failed to wait relay: {e}"))?;
        *guard = None;
        add_log(&app_handle, "app", "info", "Relay stopped");
        Ok("Relay stopped".to_string())
    } else {
        Err("Relay not running".to_string())
    }
}

#[tauri::command]
fn start_bridge(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();

    {
        let guard = state.bridge_process.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Bridge already running".to_string());
        }
    }

    let relay_url = state.relay_url.lock().map_err(|e| e.to_string())?.clone();
    if relay_url.is_empty() {
        return Err("Relay URL not set. Start relay first.".to_string());
    }

    let repo_root = get_repo_root();
    let bridge_dir = repo_root.join("agnt-bridge");
    let bridge_bin = bridge_dir.join("bin").join("agnt.js");

    if !bridge_bin.exists() {
        return Err(format!(
            "agnt-bridge/bin/agnt.js not found at {}\nRepo root: {}\nCWD: {}",
            bridge_bin.display(),
            repo_root.display(),
            std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "?".to_string())
        ));
    }

    // Ensure npm dependencies are installed
    if !ensure_deps(&bridge_dir, &app_handle) {
        return Err("Failed to install bridge dependencies. Check logs for details.".to_string());
    }

    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Starting bridge with relay: {relay_url}"),
    );
    {
        if let Ok(mut pp) = state.pairing_payload.lock() {
            *pp = None;
        }
        if let Ok(mut pc) = state.pairing_code.lock() {
            *pc = None;
        }
    }

    let mut bridge_cmd = Command::new("node");
    bridge_cmd
        .arg(&bridge_bin)
        .arg("run")
        .current_dir(&bridge_dir)
        .env("AGNT_RELAY", &relay_url)
        .env("AGNT_PRINT_PAIRING_JSON", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut bridge_cmd);
    let mut child = bridge_cmd
        .spawn()
        .map_err(|e| format!("Failed to start bridge: {e}"))?;

    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Pipe stdout to logs AND detect pairing JSON
    let ah_pairing = app_handle.clone();
    let ah_stdout = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut capturing_pairing_json = false;
        let mut capturing_pairing_code = false;

        for line in reader.lines() {
            if let Ok(text) = line {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if trimmed.contains("Or paste this pairing code") {
                        capturing_pairing_code = true;
                        add_log(&ah_stdout, "bridge", "info", "Manual pairing code ready");
                        continue;
                    }

                    if trimmed.contains("Pairing JSON") {
                        capturing_pairing_json = true;
                        add_log(&ah_stdout, "bridge", "info", "Pairing QR payload ready");
                        continue;
                    }

                    if capturing_pairing_code {
                        let state = ah_pairing.state::<AppState>();
                        if let Ok(mut pc) = state.pairing_code.lock() {
                            *pc = Some(trimmed.to_string());
                        }
                        let _ = ah_pairing.emit("pairing-code-ready", trimmed);
                        add_log(&ah_pairing, "app", "info", "Pairing code captured");
                        capturing_pairing_code = false;
                        continue;
                    }

                    if capturing_pairing_json {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(trimmed) {
                            if payload.get("relay").is_some() && payload.get("sessionId").is_some()
                            {
                                let state = ah_pairing.state::<AppState>();
                                if let Ok(mut pp) = state.pairing_payload.lock() {
                                    *pp = Some(trimmed.to_string());
                                }
                                let _ = ah_pairing.emit("pairing-ready", trimmed);
                                add_log(&ah_pairing, "app", "info", "Pairing payload captured");
                                emit_current_status(&ah_pairing);
                                capturing_pairing_json = false;
                                continue;
                            }
                        }
                        add_log(
                            &ah_pairing,
                            "app",
                            "warning",
                            "Failed to parse pairing payload",
                        );
                        capturing_pairing_json = false;
                        continue;
                    }

                    add_log(&ah_stdout, "bridge", "info", trimmed);
                }
            }
        }
    });

    pipe_stderr_to_logs(stderr, app_handle.clone(), "bridge".to_string());

    {
        let mut guard = state.bridge_process.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    // Emit status update
    let ah_status = app_handle.clone();
    let relay_mode = app_handle
        .state::<AppState>()
        .config
        .lock()
        .ok()
        .map(|c| c.relay_mode.clone())
        .unwrap_or_else(|| "local".to_string());
    let _ = ah_status.emit(
        "status-changed",
        AppStatus {
            state: "starting".to_string(),
            relay_mode,
            relay: "running".to_string(),
            bridge: "starting".to_string(),
            network: app_handle
                .state::<AppState>()
                .selected_ip
                .lock()
                .ok()
                .map(|s| s.clone())
                .unwrap_or_default(),
            relay_url: relay_url.clone(),
            pairing_payload: None,
            pairing_code: None,
            phone_connected: false,
        },
    );

    add_log(
        &app_handle,
        "app",
        "info",
        &format!("Bridge started (PID: {pid})"),
    );

    // Crash watcher
    let ah_watch = app_handle.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let state = ah_watch.state::<AppState>();
        let exited = {
            if let Ok(mut guard) = state.bridge_process.lock() {
                if let Some(ref mut child) = *guard {
                    match child.try_wait() {
                        Ok(Some(status)) => Some(status),
                        _ => None,
                    }
                } else {
                    return;
                }
            } else {
                return;
            }
        };

        if let Some(status) = exited {
            let intentional = state
                .bridge_intentional
                .lock()
                .ok()
                .map(|i| *i)
                .unwrap_or(true);
            if let Ok(mut guard) = state.bridge_process.lock() {
                *guard = None;
            }
            if intentional {
                if let Ok(mut i) = state.bridge_intentional.lock() {
                    *i = false;
                }
                return;
            }
            let code = status.code().unwrap_or(-1);
            add_log(
                &ah_watch,
                "app",
                "error",
                &format!("Bridge crashed (exit code: {code})"),
            );
            let _ = ah_watch.emit(
                "process-crashed",
                serde_json::json!({
                    "process": "bridge",
                    "exit_code": code,
                }),
            );
            let _ = ah_watch.emit(
                "status-changed",
                AppStatus {
                    state: "error".to_string(),
                    relay_mode: state
                        .config
                        .lock()
                        .ok()
                        .map(|c| c.relay_mode.clone())
                        .unwrap_or_else(|| "local".to_string()),
                    relay: state
                        .relay_process
                        .lock()
                        .ok()
                        .and_then(|p| p.as_ref().map(|_| "running".to_string()))
                        .unwrap_or_else(|| "stopped".to_string()),
                    bridge: "error".to_string(),
                    network: state
                        .selected_ip
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .unwrap_or_default(),
                    relay_url: state
                        .relay_url
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .unwrap_or_default(),
                    pairing_payload: None,
                    pairing_code: None,
                    phone_connected: false,
                },
            );

            let auto_restart = state
                .config
                .lock()
                .ok()
                .map(|c| c.auto_restart)
                .unwrap_or(false);
            if auto_restart {
                add_log(&ah_watch, "app", "info", "Auto-restarting bridge...");
                let _ = start_bridge(ah_watch.clone());
            }
            return;
        }
    });

    Ok(format!("Bridge started, PID: {pid}"))
}

#[tauri::command]
fn stop_bridge(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    if let Ok(mut i) = state.bridge_intentional.lock() {
        *i = true;
    }
    let mut guard = state.bridge_process.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        add_log(&app_handle, "app", "info", "Stopping bridge...");
        child
            .kill()
            .map_err(|e| format!("Failed to kill bridge: {e}"))?;
        child
            .wait()
            .map_err(|e| format!("Failed to wait bridge: {e}"))?;
        *guard = None;
        add_log(&app_handle, "app", "info", "Bridge stopped");
        Ok("Bridge stopped".to_string())
    } else {
        Err("Bridge not running".to_string())
    }
}

#[tauri::command]
fn stop_all(app_handle: tauri::AppHandle) -> Result<String, String> {
    add_log(&app_handle, "app", "info", "Stopping all processes...");
    let r1 = stop_bridge(app_handle.clone());
    let r2 = stop_relay(app_handle.clone());
    if r1.is_ok() && r2.is_ok() {
        add_log(&app_handle, "app", "info", "All processes stopped");
    }
    Ok("All processes stopped".to_string())
}

#[tauri::command]
fn start_all(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let is_remote = state.config.lock().map_err(|e| e.to_string())?.relay_mode == "remote";
    drop(state);

    add_log(&app_handle, "app", "info", "Starting all processes...");

    if is_remote {
        add_log(
            &app_handle,
            "app",
            "info",
            "Remote mode: skipping local relay",
        );
        let remote_url = {
            let state = app_handle.state::<AppState>();
            let config = state.config.lock().map_err(|e| e.to_string())?;
            config.remote_relay_url.clone()
        };
        {
            let state = app_handle.state::<AppState>();
            let mut url = state.relay_url.lock().map_err(|e| e.to_string())?;
            *url = remote_url.clone();
        }
        start_bridge(app_handle.clone())?;
        Ok(remote_url)
    } else {
        let relay_url = start_relay(app_handle.clone())?;
        std::thread::sleep(Duration::from_millis(500));
        let _ = start_bridge(app_handle.clone())?;
        Ok(relay_url)
    }
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
fn show_pet_popup(app_handle: tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let pairing_payload = state
        .pairing_payload
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if pairing_payload.is_none() {
        if let Some(w) = app_handle.get_webview_window("pet-popup") {
            let _ = w.hide();
        }
        return Ok(());
    }

    let pet_pos = app_handle
        .get_webview_window("pet")
        .and_then(|pet| pet.outer_position().ok());
    let popup_x = pet_pos.map(|pos| (pos.x - 90).max(0)).unwrap_or(0);
    let popup_y = pet_pos.map(|pos| (pos.y - 222).max(0)).unwrap_or(0);

    if let Some(w) = app_handle.get_webview_window("pet-popup") {
        w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            popup_x, popup_y,
        )))
        .map_err(|e| format!("popup position failed: {e}"))?;
        w.show().map_err(|e| format!("popup show failed: {e}"))?;
        return Ok(());
    }

    let _popup = tauri::WebviewWindowBuilder::new(
        &app_handle,
        "pet-popup",
        tauri::WebviewUrl::App("popup.html".into()),
    )
    .title("")
    .inner_size(260.0, 220.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .visible(true)
    .position(popup_x as f64, popup_y as f64)
    .build()
    .map_err(|e| format!("popup build failed: {e}"))?;

    Ok(())
}

#[tauri::command]
fn hide_pet_popup(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("pet-popup") {
        w.hide().map_err(|e| format!("popup hide failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn move_pet_window(app_handle: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("pet") {
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                x as i32, y as i32,
            )))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("pet window not found".to_string())
}

#[tauri::command]
fn get_pet_window_position(app_handle: tauri::AppHandle) -> Result<Option<(f64, f64)>, String> {
    if let Some(window) = app_handle.get_webview_window("pet") {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        return Ok(Some((pos.x as f64, pos.y as f64)));
    }
    Ok(None)
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
#[tauri::command]
async fn start_provider_bridge(
    app_handle: tauri::AppHandle,
    runtime: tauri::State<'_, provider_bridge::state::ProviderBridgeRuntime>,
) -> Result<provider_bridge::state::ProviderBridgeStatus, String> {
    let config = app_handle
        .state::<AppState>()
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .provider_bridge
        .clone();

    let api_key = resolve_provider_bridge_api_key()
        .ok_or(provider_bridge::errors::ProviderBridgeError::MissingApiKey)
        .map_err(|e| e.to_string())?;

    let status = match runtime.start(config, api_key).await {
        Ok(status) => status,
        Err(error) => {
            add_log(
                &app_handle,
                "provider_bridge",
                "error",
                &format!("Failed to start provider bridge: {error}"),
            );
            return Err(error.to_string());
        }
    };

    add_log(
        &app_handle,
        "provider_bridge",
        "info",
        &format!("Provider bridge listening at {}", status.base_url),
    );
    Ok(status)
}

#[tauri::command]
async fn stop_provider_bridge(
    app_handle: tauri::AppHandle,
    runtime: tauri::State<'_, provider_bridge::state::ProviderBridgeRuntime>,
) -> Result<provider_bridge::state::ProviderBridgeStatus, String> {
    let status = match runtime.stop().await {
        Ok(status) => status,
        Err(error) => {
            add_log(
                &app_handle,
                "provider_bridge",
                "error",
                &format!("Failed to stop provider bridge: {error}"),
            );
            return Err(error.to_string());
        }
    };
    add_log(
        &app_handle,
        "provider_bridge",
        "info",
        "Provider bridge stopped",
    );
    Ok(status)
}

#[tauri::command]
fn get_provider_bridge_status(
    runtime: tauri::State<'_, provider_bridge::state::ProviderBridgeRuntime>,
    app_handle: tauri::AppHandle,
) -> Result<provider_bridge::state::ProviderBridgeStatus, String> {
    let config = app_handle
        .state::<AppState>()
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .provider_bridge
        .clone();
    runtime.status(&config).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_provider_bridge_codex_config(
    app_handle: tauri::AppHandle,
) -> Result<provider_bridge::config::ProviderBridgeCodexConfig, String> {
    let config = app_handle
        .state::<AppState>()
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .provider_bridge
        .clone();
    config.codex_config().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_provider_bridge_key_status() -> provider_bridge::config::ProviderKeyStatus {
    provider_bridge_key_status()
}

#[tauri::command]
fn set_provider_bridge_api_key(
    app_handle: tauri::AppHandle,
    key: Option<String>,
) -> provider_bridge::config::ProviderKeyStatus {
    let normalized = key.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let has_key = normalized.is_some();
    store_provider_bridge_api_key(normalized);
    add_log(
        &app_handle,
        "provider_bridge",
        "info",
        if has_key {
            "Stored provider bridge API key updated"
        } else {
            "Stored provider bridge API key cleared"
        },
    );
    provider_bridge_key_status()
}

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

            // Pet overlay window
            let screen_width = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| m.size().width as f64)
                .unwrap_or(1920.0);
            let _pet = tauri::WebviewWindowBuilder::new(
                app,
                "pet",
                tauri::WebviewUrl::App("pet.html".into()),
            )
            .title("Agnt Pet")
            .inner_size(PET_WINDOW_SIZE, PET_WINDOW_SIZE)
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .visible(app_config.relay_mode == "local")
            .position(screen_width - 120.0, 200.0)
            .build()?;

            let _pet_popup = tauri::WebviewWindowBuilder::new(
                app,
                "pet-popup",
                tauri::WebviewUrl::App("popup.html".into()),
            )
            .title("Agnt")
            .inner_size(260.0, 220.0)
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .shadow(false)
            .transparent(true)
            .skip_taskbar(true)
            .visible(false)
            .center()
            .build()?;

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
            start_relay,
            stop_relay,
            start_bridge,
            stop_bridge,
            start_all,
            stop_all,
            get_logs,
            clear_logs,
            get_status,
            get_pairing_payload,
            debug_paths,
            check_port,
            complete_setup,
            show_main_window,
            move_pet_window,
            get_pet_window_position,
            show_pet_popup,
            hide_pet_popup,
            notify,
            set_relay_mode,
            set_remote_relay_url,
            refresh_bundled_runtime,
            get_diagnostics,
            check_for_update,
            install_update,
            start_provider_bridge,
            stop_provider_bridge,
            get_provider_bridge_status,
            get_provider_bridge_codex_config,
            get_provider_bridge_key_status,
            set_provider_bridge_api_key,
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
