use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::{
    add_log,
    app_types::{AppState, AppStatus},
    emit_current_status,
    process_helpers::{ensure_deps, get_repo_root, hide_console, pipe_stderr_to_logs},
};

#[tauri::command]
pub fn start_bridge(app_handle: tauri::AppHandle) -> Result<String, String> {
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
pub fn stop_bridge(app_handle: tauri::AppHandle) -> Result<String, String> {
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
