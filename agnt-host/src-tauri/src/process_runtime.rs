use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::{
    add_log,
    app_types::{AppState, AppStatus},
    bridge_runtime::{start_bridge, stop_bridge},
    process_helpers::{
        ensure_deps, get_repo_root, hide_console, is_port_available, pipe_stderr_to_logs,
        pipe_stdout_to_logs, wait_for_port,
    },
};

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

#[tauri::command]
pub fn start_relay(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();

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

    fire_wall_warning(&app_handle, &selected_ip, port);

    let ah_watch = app_handle.clone();
    std::thread::spawn(move || loop {
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
                    return;
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
    });

    Ok(relay_url)
}

#[tauri::command]
pub fn stop_relay(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
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
pub fn stop_all(app_handle: tauri::AppHandle) -> Result<String, String> {
    add_log(&app_handle, "app", "info", "Stopping all processes...");
    let r1 = stop_bridge(app_handle.clone());
    let r2 = stop_relay(app_handle.clone());
    if r1.is_ok() && r2.is_ok() {
        add_log(&app_handle, "app", "info", "All processes stopped");
    }
    Ok("All processes stopped".to_string())
}

#[tauri::command]
pub fn start_all(app_handle: tauri::AppHandle) -> Result<String, String> {
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
