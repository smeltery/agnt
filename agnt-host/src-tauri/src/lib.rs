#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;

#[cfg(test)]
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod app_commands;
mod app_runtime;
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

pub(crate) use app_commands::runtime_process_status;
use app_types::{AppState, AppStatus, DebugInfo, LogEntry};
use host_config::{config_path, load_config};
pub use network::NetworkInterface;
use process_helpers::get_repo_root;
pub(crate) use process_helpers::{find_available_port, is_port_available};
#[cfg(test)]
use runtime_bundle::{
    bundle_manifests_match, copy_fixture_runtime_from_bundle, read_bundle_manifest, BundleManifest,
    BUNDLE_MANIFEST,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
// ─── Helpers ─────────────────────────────────────────────────

pub(crate) fn processes_are_running(app_handle: &tauri::AppHandle) -> bool {
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

pub(crate) fn current_app_status(app_handle: &tauri::AppHandle) -> Result<AppStatus, String> {
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

pub(crate) fn set_launch_at_startup(enable: bool) {
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

pub(crate) fn show_notification(title: &str, body: &str) {
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
        .setup(move |app| app_runtime::setup(app, app_config.clone()))
        .invoke_handler(tauri::generate_handler![
            app_commands::detect_networks,
            app_commands::select_network,
            app_commands::get_config,
            app_commands::save_config_cmd,
            process_runtime::start_relay,
            process_runtime::stop_relay,
            bridge_runtime::start_bridge,
            bridge_runtime::stop_bridge,
            process_runtime::start_all,
            process_runtime::stop_all,
            app_commands::get_logs,
            app_commands::clear_logs,
            app_commands::get_status,
            app_commands::get_pairing_payload,
            app_commands::debug_paths,
            app_commands::check_port,
            app_commands::complete_setup,
            app_commands::show_main_window,
            pet_window::move_pet_window,
            pet_window::get_pet_window_position,
            pet_window::show_pet_popup,
            pet_window::hide_pet_popup,
            app_commands::notify,
            app_commands::set_relay_mode,
            app_commands::set_remote_relay_url,
            app_commands::refresh_bundled_runtime,
            app_commands::get_diagnostics,
            app_commands::check_for_update,
            app_commands::install_update,
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
