#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::process::{Child, Command, Stdio};
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod provider_bridge;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const PET_WINDOW_SIZE: f64 = 80.0;
const BUNDLE_MANIFEST: &str = "agnt-bundle.json";

// ─── Data types ──────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct LogEntry {
    pub timestamp: String,
    pub source: String,
    pub level: String,
    pub message: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct NetworkInterface {
    pub name: String,
    pub address: String,
    pub kind: String,
    pub is_private: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DebugInfo {
    pub cwd: String,
    pub repo_root: String,
    pub relay_dir: String,
    pub relay_server_exists: bool,
    pub bridge_dir: String,
    pub bridge_bin_exists: bool,
    pub config_path: String,
    pub config_exists: bool,
    pub node_version: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundlePackageMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundleComponentManifest {
    pub package: Option<BundlePackageMetadata>,
    pub hash: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BundleManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub relay: BundleComponentManifest,
    pub bridge: BundleComponentManifest,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RuntimeBundleStatus {
    pub bundled_manifest: Option<BundleManifest>,
    pub runtime_manifest: Option<BundleManifest>,
    pub runtime_current: bool,
    pub refresh_available: bool,
    pub refresh_deferred: bool,
    pub bundled_path: String,
    pub runtime_path: String,
    pub message: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticAction {
    pub kind: String,
    pub label: String,
    pub value: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticCheck {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: String,
    pub action: Option<DiagnosticAction>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct SetupPreset {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub action: Option<DiagnosticAction>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DiagnosticsSnapshot {
    pub generated_at: String,
    pub summary: String,
    pub checks: Vec<DiagnosticCheck>,
    pub presets: Vec<SetupPreset>,
    pub recommended_actions: Vec<DiagnosticAction>,
    pub runtime: RuntimeBundleStatus,
    pub debug: DebugInfo,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct AppStatus {
    pub state: String,
    pub relay_mode: String,
    pub relay: String,
    pub bridge: String,
    pub network: String,
    pub relay_url: String,
    pub pairing_payload: Option<String>,
    pub pairing_code: Option<String>,
    pub phone_connected: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AppConfig {
    #[serde(default = "default_relay_mode")]
    pub relay_mode: String, // "local" | "remote"
    pub selected_ip: String,
    pub relay_port: u16,
    #[serde(default)]
    pub remote_relay_url: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub auto_restart: bool,
    #[serde(default)]
    pub start_minimized: bool,
    #[serde(default)]
    pub launch_at_startup: bool,
    #[serde(default)]
    pub setup_completed: bool,
    #[serde(default)]
    pub requires_entitlement: bool,
    #[serde(default = "default_free_message_limit")]
    pub free_message_limit: u32,
    pub relay_path: Option<String>,
    pub bridge_path: Option<String>,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub provider_bridge: provider_bridge::config::ProviderBridgeConfig,
}

fn default_relay_mode() -> String { "local".to_string() }
fn default_free_message_limit() -> u32 { 5 }
fn default_log_level() -> String { "info".to_string() }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            relay_mode: "local".to_string(),
            selected_ip: String::new(),
            relay_port: 9000,
            remote_relay_url: "ws://127.0.0.1:9000".to_string(),
            auto_start: false,
            auto_restart: false,
            start_minimized: false,
            launch_at_startup: false,
            setup_completed: false,
            requires_entitlement: true,
            free_message_limit: 5,
            relay_path: None,
            bridge_path: None,
            log_level: "info".to_string(),
            provider_bridge: provider_bridge::config::ProviderBridgeConfig::default(),
        }
    }
}

// ─── State ───────────────────────────────────────────────────

pub struct AppState {
    pub relay_process: Mutex<Option<Child>>,
    pub bridge_process: Mutex<Option<Child>>,
    pub logs: Mutex<Vec<LogEntry>>,
    pub config: Mutex<AppConfig>,
    pub pairing_payload: Mutex<Option<String>>,
    pub selected_ip: Mutex<String>,
    pub relay_url: Mutex<String>,
    pub phone_connected: Mutex<bool>,
    pub pairing_code: Mutex<Option<String>>,
    pub relay_intentional: Mutex<bool>,
    pub bridge_intentional: Mutex<bool>,
}

// ─── Helpers ─────────────────────────────────────────────────

fn runtime_root() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("agnt-host")
        .join("runtime")
}

fn bundled_root_from_exe() -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;
    let bundled_root = exe_dir.join("bundled");
    let bundled_relay = bundled_root.join("relay").join("server.js");
    let bundled_bridge = bundled_root.join("agnt-bridge").join("bin").join("agnt.js");
    if bundled_relay.exists() && bundled_bridge.exists() {
        Some(bundled_root)
    } else {
        None
    }
}

fn read_bundle_manifest(path: &Path) -> Option<BundleManifest> {
    let raw = fs::read_to_string(path.join(BUNDLE_MANIFEST)).ok()?;
    serde_json::from_str::<BundleManifest>(&raw).ok()
}

fn bundle_manifests_match(bundled: &BundleManifest, runtime: &BundleManifest) -> bool {
    bundled.schema_version == runtime.schema_version &&
        bundled.relay.hash == runtime.relay.hash &&
        bundled.bridge.hash == runtime.bridge.hash &&
        bundled.relay.package == runtime.relay.package &&
        bundled.bridge.package == runtime.bridge.package
}

fn runtime_bundle_status(processes_running: bool) -> RuntimeBundleStatus {
    let bundled_root = bundled_root_from_exe();
    let runtime = runtime_root();
    let bundled_manifest = bundled_root.as_ref().and_then(|p| read_bundle_manifest(p));
    let runtime_manifest = read_bundle_manifest(&runtime);
    let runtime_current = match (&bundled_manifest, &runtime_manifest) {
        (Some(bundled), Some(runtime)) => bundle_manifests_match(bundled, runtime),
        _ => false,
    };
    let refresh_available = bundled_manifest.is_some() && !runtime_current;
    let refresh_deferred = refresh_available && processes_running;
    let message = if bundled_manifest.is_none() {
        "No packaged bundle manifest was found. This is expected in development mode.".to_string()
    } else if runtime_current {
        "Runtime bridge and relay match the packaged bundle.".to_string()
    } else if refresh_deferred {
        "Restart Host to apply the packaged bridge and relay update.".to_string()
    } else {
        "Runtime bridge and relay can be refreshed from the packaged bundle.".to_string()
    };

    RuntimeBundleStatus {
        bundled_manifest,
        runtime_manifest,
        runtime_current,
        refresh_available,
        refresh_deferred,
        bundled_path: bundled_root
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(development mode)".to_string()),
        runtime_path: runtime.display().to_string(),
        message,
    }
}

fn copy_file_if_exists(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.exists() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
    }
    Ok(())
}

fn validate_runtime_tree(root: &Path) -> Result<(), String> {
    let relay_server = root.join("relay").join("server.js");
    let bridge_bin = root.join("agnt-bridge").join("bin").join("agnt.js");
    if !relay_server.exists() {
        return Err(format!("missing {}", relay_server.display()));
    }
    if !bridge_bin.exists() {
        return Err(format!("missing {}", bridge_bin.display()));
    }
    if !root.join(BUNDLE_MANIFEST).exists() {
        return Err(format!("missing {}", root.join(BUNDLE_MANIFEST).display()));
    }
    Ok(())
}

fn seed_runtime_from_bundle(bundled_root: &Path, runtime: &Path) {
    let relay_dest = runtime.join("relay");
    if !relay_dest.join("server.js").exists() {
        let relay_src = bundled_root.join("relay");
        if let Err(e) = copy_dir_recursive(&relay_src, &relay_dest) {
            log::warn!("Failed to copy relay to runtime dir: {e}");
        }
    }

    let bridge_dest = runtime.join("agnt-bridge");
    if !bridge_dest.join("bin").join("agnt.js").exists() {
        let bridge_src = bundled_root.join("agnt-bridge");
        if let Err(e) = copy_dir_recursive(&bridge_src, &bridge_dest) {
            log::warn!("Failed to copy bridge to runtime dir: {e}");
        }
    }

    let _ = copy_file_if_exists(&bundled_root.join(BUNDLE_MANIFEST), &runtime.join(BUNDLE_MANIFEST));
}

fn refresh_runtime_from_bundle(processes_running: bool) -> Result<RuntimeBundleStatus, String> {
    let bundled_root = match bundled_root_from_exe() {
        Some(path) => path,
        None => return Ok(runtime_bundle_status(processes_running)),
    };
    let status = runtime_bundle_status(processes_running);
    if !status.refresh_available || status.runtime_current {
        return Ok(status);
    }
    if processes_running {
        return Ok(status);
    }

    let runtime = runtime_root();
    let parent = runtime
        .parent()
        .ok_or_else(|| "Runtime directory has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| format!("runtime parent create failed: {e}"))?;

    let tmp = parent.join("runtime-refresh-tmp");
    let backup = parent.join("runtime-refresh-backup");
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&tmp).map_err(|e| format!("runtime temp create failed: {e}"))?;

    copy_dir_recursive(&bundled_root.join("relay"), &tmp.join("relay"))
        .map_err(|e| format!("relay copy failed: {e}"))?;
    copy_dir_recursive(&bundled_root.join("agnt-bridge"), &tmp.join("agnt-bridge"))
        .map_err(|e| format!("bridge copy failed: {e}"))?;
    copy_file_if_exists(&bundled_root.join(BUNDLE_MANIFEST), &tmp.join(BUNDLE_MANIFEST))
        .map_err(|e| format!("manifest copy failed: {e}"))?;
    validate_runtime_tree(&tmp)?;

    if runtime.exists() {
        fs::rename(&runtime, &backup).map_err(|e| format!("runtime backup failed: {e}"))?;
    }
    if let Err(error) = fs::rename(&tmp, &runtime) {
        if backup.exists() {
            let _ = fs::rename(&backup, &runtime);
        }
        return Err(format!("runtime replace failed: {error}"));
    }
    let _ = fs::remove_dir_all(&backup);

    Ok(runtime_bundle_status(false))
}

#[cfg(test)]
fn copy_fixture_runtime_from_bundle(bundled_root: &Path, runtime: &Path) -> Result<(), String> {
    let parent = runtime
        .parent()
        .ok_or_else(|| "Runtime directory has no parent".to_string())?
        .to_path_buf();
    fs::create_dir_all(&parent).map_err(|e| format!("runtime parent create failed: {e}"))?;

    let tmp = parent.join("runtime-refresh-tmp");
    let backup = parent.join("runtime-refresh-backup");
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&tmp).map_err(|e| format!("runtime temp create failed: {e}"))?;
    copy_dir_recursive(&bundled_root.join("relay"), &tmp.join("relay"))
        .map_err(|e| format!("relay copy failed: {e}"))?;
    copy_dir_recursive(&bundled_root.join("agnt-bridge"), &tmp.join("agnt-bridge"))
        .map_err(|e| format!("bridge copy failed: {e}"))?;
    copy_file_if_exists(&bundled_root.join(BUNDLE_MANIFEST), &tmp.join(BUNDLE_MANIFEST))
        .map_err(|e| format!("manifest copy failed: {e}"))?;
    validate_runtime_tree(&tmp)?;

    if runtime.exists() {
        fs::rename(runtime, &backup).map_err(|e| format!("runtime backup failed: {e}"))?;
    }
    if let Err(error) = fs::rename(&tmp, runtime) {
        if backup.exists() {
            let _ = fs::rename(&backup, runtime);
        }
        return Err(format!("runtime replace failed: {error}"));
    }
    let _ = fs::remove_dir_all(&backup);
    Ok(())
}

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
        state.bridge_process.lock().map_err(|e| e.to_string())?
            .as_ref().map_or("stopped", |_| "running").to_string()
    };
    let network = state.selected_ip.lock().map_err(|e| e.to_string())?.clone();
    let relay_url = state.relay_url.lock().map_err(|e| e.to_string())?.clone();
    let pairing_payload = state.pairing_payload.lock().map_err(|e| e.to_string())?.clone();
    let pairing_code = state.pairing_code.lock().map_err(|e| e.to_string())?.clone();
    let phone_connected = *state.phone_connected.lock().map_err(|e| e.to_string())?;
    let relay_mode = state.config.lock().map_err(|e| e.to_string())?.relay_mode.clone();

    let relay_status = if relay_mode == "remote" {
        "external".to_string()
    } else {
        state.relay_process.lock().map_err(|e| e.to_string())?
            .as_ref().map_or("stopped", |_| "running").to_string()
    };

    let state_str = if phone_connected && bridge == "running" {
        "connected"
    } else if relay_status == "running" && bridge == "running" && pairing_payload.is_some() {
        if relay_mode == "remote" { "remote_placeholder_ready" } else { "local_ready" }
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

fn get_repo_root() -> PathBuf {
    // Bundled production mode: copy to writable app data dir
    if let Some(bundled_root) = bundled_root_from_exe() {
        let runtime = runtime_root();
        seed_runtime_from_bundle(&bundled_root, &runtime);
        return runtime;
    }

    // Dev mode: walk up from cwd
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(_) => return PathBuf::from("."),
    };

    let mut current = cwd.clone();
    for _ in 0..5 {
        if current.join("relay").join("server.js").exists()
            && current.join("agnt-bridge").join("bin").join("agnt.js").exists()
        {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    current = cwd.clone();
    for _ in 0..2 {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }
    current
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            if entry.file_name() != "node_modules" && entry.file_name() != ".git" {
                copy_dir_recursive(&entry.path(), &dest_path)?;
            }
        } else {
            let _ = fs::copy(entry.path(), &dest_path);
        }
    }
    Ok(())
}

fn config_path() -> std::path::PathBuf {
    if let Some(dir) = dirs::config_dir() {
        let p = dir.join("agnt-host").join("config.json");
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        p
    } else {
        std::path::PathBuf::from("agnt-host-config.json")
    }
}

// ─── provider_bridge secrets ─────────────────────────────────
// The provider-bridge API key is stored apart from config.json so it never
// rides along with exported/synced settings.

fn provider_bridge_secret_path() -> std::path::PathBuf {
    if let Some(dir) = dirs::config_dir() {
        let p = dir
            .join("agnt-host")
            .join("provider-bridge-secrets.json");
        if let Some(parent) = p.parent() {
            let _ = fs::create_dir_all(parent);
        }
        p
    } else {
        std::path::PathBuf::from("agnt-provider-bridge-secrets.json")
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ProviderBridgeSecrets {
    // Generic on-disk schema so a second adapter reuses the same file.
    api_key: Option<String>,
}

fn load_provider_bridge_secrets() -> ProviderBridgeSecrets {
    let path = provider_bridge_secret_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(secrets) = serde_json::from_str::<ProviderBridgeSecrets>(&content) {
                return secrets;
            }
        }
    }
    ProviderBridgeSecrets::default()
}

fn save_provider_bridge_secrets(secrets: &ProviderBridgeSecrets) {
    let path = provider_bridge_secret_path();
    if let Ok(json) = serde_json::to_string_pretty(secrets) {
        let _ = fs::write(path, json);
    }
}

// Env override precedence: the agnt-prefixed name first, then the DeepSeek
// adapter's documented var. Add future adapter vars to this list.
fn provider_bridge_env_api_key() -> Option<String> {
    ["AGNT_PROVIDER_BRIDGE_API_KEY", "DEEPSEEK_API_KEY"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn provider_bridge_key_status() -> provider_bridge::config::ProviderKeyStatus {
    let has_env_key = provider_bridge_env_api_key().is_some();
    let secrets = load_provider_bridge_secrets();
    let has_stored_key = secrets
        .api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());

    provider_bridge::config::ProviderKeyStatus {
        available: has_env_key || has_stored_key,
        source: if has_env_key {
            "environment".to_string()
        } else if has_stored_key {
            "stored".to_string()
        } else {
            "missing".to_string()
        },
        has_stored_key,
    }
}

fn resolve_provider_bridge_api_key() -> Option<String> {
    provider_bridge_env_api_key().or_else(|| {
        load_provider_bridge_secrets()
            .api_key
            .filter(|value| !value.trim().is_empty())
    })
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
        cmd.args(["add", key, "/v", name, "/t", "REG_SZ", "/d", &exe_path, "/f"]);
        #[cfg(target_os = "windows")] { cmd.creation_flags(CREATE_NO_WINDOW); }
        let _ = cmd.output();
    } else {
        let mut cmd = Command::new("reg");
        cmd.args(["delete", key, "/v", name, "/f"]);
        #[cfg(target_os = "windows")] { cmd.creation_flags(CREATE_NO_WINDOW); }
        let _ = cmd.output();
    }
    }
}

fn fire_wall_warning(app_handle: &tauri::AppHandle, ip: &str, port: u16) {
    if ip == "127.0.0.1" || ip == "localhost" || ip.is_empty() {
        return;
    }
    add_log(app_handle, "app", "warning", &format!(
        "Relay is on {ip}:{port}. Windows Firewall may block incoming connections from your phone."
    ));
    let _ = app_handle.emit("firewall-warning", serde_json::json!({
        "ip": ip,
        "port": port,
        "message": "Windows Firewall could be blocking the port. Make sure your phone can reach this PC.",
    }));
    let _ = app_handle.emit("status-changed", AppStatus {
        state: "warning".to_string(),
        relay_mode: "local".to_string(),
        relay: "running".to_string(),
        bridge: "stopped".to_string(),
        network: ip.to_string(),
        relay_url: format!("ws://{ip}:{port}/relay"),
        pairing_payload: None,
        pairing_code: None,
        phone_connected: false,
    });
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
            .args(["-e", &format!(r#"display notification "{}" with title "{}""#, body, title)])
            .spawn();
    }
}

fn hide_console(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn ensure_deps(dir: &std::path::Path, app_handle: &tauri::AppHandle) -> bool {
    let node_modules = dir.join("node_modules");
    let package_json = dir.join("package.json");

    if !package_json.exists() {
        return true;
    }

    if node_modules.exists() {
        return true;
    }

    add_log(app_handle, "app", "info", &format!("Installing dependencies in {}...", dir.display()));

    let output = if cfg!(windows) {
        let cmd = format!(
            "cd /d {} && npm install --no-audit --no-fund --silent",
            dir.display()
        );
        let mut c = Command::new("cmd");
        c.args(["/C", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut c);
        c.output()
    } else {
        Command::new("npm")
            .args(["install", "--no-audit", "--no-fund", "--silent"])
            .current_dir(dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
    };

    match output {
        Ok(out) if out.status.success() => {
            add_log(app_handle, "app", "info", &format!("Dependencies installed in {}", dir.display()));
            true
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            add_log(app_handle, "app", "error", &format!("npm install failed: {}{}", stderr, stdout));
            false
        }
        Err(e) => {
            add_log(app_handle, "app", "error", &format!("Failed to run npm install: {}", e));
            false
        }
    }
}

// Removed find_npm — now unused

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_available_port(start: u16) -> u16 {
    (start..start + 100).find(|&p| is_port_available(p)).unwrap_or(9000)
}

fn wait_for_port(port: u16, timeout_secs: u32) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    for _ in 0..(timeout_secs * 10) {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&content) {
                return cfg;
            }
        }
    }
    AppConfig::default()
}

fn save_config(config: &AppConfig) {
    let path = config_path();
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

// ─── Network detection ──────────────────────────────────────

fn is_private_ipv4(addr: &str) -> bool {
    let parts: Vec<&str> = addr.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    if let (Ok(a), Ok(b)) = (parts[0].parse::<u8>(), parts[1].parse::<u8>()) {
        match a {
            10 => true,
            172 => (16..=31).contains(&b),
            192 => b == 168,
            _ => false,
        }
    } else {
        false
    }
}

fn is_tailscale_ipv4(addr: &str) -> bool {
    let parts: Vec<&str> = addr.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    if let (Ok(a), Ok(b)) = (parts[0].parse::<u8>(), parts[1].parse::<u8>()) {
        a == 100 && (64..=127).contains(&b)
    } else {
        false
    }
}

fn is_local_relay_host(host: &str) -> bool {
    let h = host.trim().trim_matches(['[', ']']).to_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h == "::1" || h.ends_with(".local") || h.ends_with(".ts.net") {
        return true;
    }
    if !h.contains('.') && !h.contains(':') {
        return true;
    }
    if is_private_ipv4(&h) || is_tailscale_ipv4(&h) || h.starts_with("127.") || h.starts_with("169.254.") {
        return true;
    }
    if !h.contains(':') {
        return false;
    }
    h.starts_with("fc") ||
        h.starts_with("fd") ||
        h.starts_with("fe8") ||
        h.starts_with("fe9") ||
        h.starts_with("fea") ||
        h.starts_with("feb")
}

fn relay_url_parts(raw: &str) -> Option<(String, String, String)> {
    let trimmed = raw.trim().trim_end_matches('/');
    let scheme_end = trimmed.find("://")?;
    let scheme = trimmed[..scheme_end].to_lowercase();
    if !matches!(scheme.as_str(), "ws" | "wss" | "http" | "https") {
        return None;
    }
    let rest = &trimmed[(scheme_end + 3)..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return None;
    }
    let path = if authority_end < rest.len() { &rest[authority_end..] } else { "/" };
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map(|end| authority[1..end].to_string())?
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    if host.trim().is_empty() {
        return None;
    }
    Some((scheme, host, path.to_string()))
}

fn relay_url_policy(raw: &str) -> (String, String) {
    let Some((scheme, host, _path)) = relay_url_parts(raw) else {
        return ("fail".to_string(), "Relay URL is invalid or contains unsupported credentials.".to_string());
    };
    let host_lower = host.to_lowercase();
    let cleartext = scheme == "ws" || scheme == "http";
    if cleartext && !is_local_relay_host(&host) {
        return ("fail".to_string(), "Public ws:// relay URLs are not allowed. Use local/Tailscale ws:// or secure wss://.".to_string());
    }
    if host_lower == "localhost" || host_lower == "127.0.0.1" {
        return ("warn".to_string(), "Loopback relay URLs only work on this PC, not from a phone.".to_string());
    }
    if cleartext && (is_tailscale_ipv4(&host_lower) || host_lower.ends_with(".ts.net")) {
        return ("pass".to_string(), "Tailscale relay URL is accepted as private transport.".to_string());
    }
    if cleartext {
        return ("pass".to_string(), "Local relay URL is accepted.".to_string());
    }
    ("pass".to_string(), "Secure relay URL is accepted.".to_string())
}

fn is_virtual_interface(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("hyper-v")
        || lower.contains("virtual")
        || lower.contains("docker")
        || lower.contains("vswitch")
        || lower.contains("vmware")
        || lower.contains("virtualbox")
        || lower.contains("wsl")
        || lower.contains("bluetooth")
        || lower.contains("loopback")
        || lower.contains("pseudo")
}

fn is_vpn_interface(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("vpn")
        || lower.contains("tailscale")
        || lower.contains("zerotier")
        || lower.contains("wireguard")
        || lower.contains("openvpn")
        || lower.contains("nord")
        || lower.contains("proton")
}

fn detect_network_interfaces() -> Vec<NetworkInterface> {
    let mut interfaces = Vec::new();

    // Use netsh on Windows, ip on Linux/Mac
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile", "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object IPAddress, InterfaceAlias | ConvertTo-Json -Compress"
        ]);
        hide_console(&mut cmd);
        if let Ok(output) = cmd.output()
        {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                // Try to parse the JSON array
                if let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                    for v in values {
                        let name = v["InterfaceAlias"].as_str().unwrap_or("unknown").to_string();
                        let address = v["IPAddress"].as_str().unwrap_or("").to_string();
                        if !address.is_empty() {
                            let is_virt = is_virtual_interface(&name);
                            let is_vpn = is_vpn_interface(&name);
                            let is_priv = is_private_ipv4(&address) || is_tailscale_ipv4(&address);
                            let kind = if is_vpn {
                                "vpn"
                            } else if is_virt {
                                "virtual"
                            } else if name.to_lowercase().contains("wi-fi") || name.to_lowercase().contains("wifi") {
                                "wifi"
                            } else if name.to_lowercase().contains("ethernet") {
                                "ethernet"
                            } else {
                                "other"
                            };
                            interfaces.push(NetworkInterface {
                                name,
                                address,
                                kind: kind.to_string(),
                                is_private: is_priv && !is_virt,
                            });
                        }
                    }
                } else {
                    // Try single object
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                        if let Some(obj) = v.as_object() {
                            let name = obj.get("InterfaceAlias").and_then(|s| s.as_str()).unwrap_or("unknown").to_string();
                            let address = obj.get("IPAddress").and_then(|s| s.as_str()).unwrap_or("").to_string();
                            let is_priv = is_private_ipv4(&address) || is_tailscale_ipv4(&address);
                            if !address.is_empty() {
                                interfaces.push(NetworkInterface {
                                    name,
                                    address,
                                    kind: "other".to_string(),
                                    is_private: is_priv,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("sh")
            .args(["-c", "ifconfig | grep 'inet ' | grep -v 127.0.0.1"])
            .output();
        if let Ok(out) = output {
            if let Ok(stdout) = String::from_utf8(out.stdout) {
                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        let addr = parts[1];
                        if is_private_ipv4(addr) || is_tailscale_ipv4(addr) {
                            interfaces.push(NetworkInterface {
                                name: "en0".to_string(),
                                address: addr.to_string(),
                                kind: "other".to_string(),
                                is_private: true,
                            });
                        }
                    }
                }
            }
        }
    }

    // Sort: private interfaces first, non-virtual first, wifi first
    interfaces.sort_by(|a, b| {
        b.is_private.cmp(&a.is_private)
            .then(a.kind.cmp(&b.kind))
            .then(a.address.cmp(&b.address))
    });

    interfaces
}

// ─── Process piping ─────────────────────────────────────────

fn pipe_stdout_to_logs(
    stdout: std::process::ChildStdout,
    app_handle: tauri::AppHandle,
    source: String,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(text) = line {
                if !text.trim().is_empty() {
                    add_log(&app_handle, &source, "info", &text);
                }
            }
        }
    });
}

fn pipe_stderr_to_logs(
    stderr: std::process::ChildStderr,
    app_handle: tauri::AppHandle,
    source: String,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(text) = line {
                if !text.trim().is_empty() {
                    add_log(&app_handle, &source, "error", &text);
                }
            }
        }
    });
}

// ─── Tauri commands ─────────────────────────────────────────

#[tauri::command]
fn detect_networks() -> Result<Vec<NetworkInterface>, String> {
    Ok(detect_network_interfaces())
}

fn diagnostic_action(kind: &str, label: &str, value: Option<String>) -> DiagnosticAction {
    DiagnosticAction {
        kind: kind.to_string(),
        label: label.to_string(),
        value,
    }
}

fn diagnostic_check(
    id: &str,
    title: &str,
    status: &str,
    detail: String,
    action: Option<DiagnosticAction>,
) -> DiagnosticCheck {
    DiagnosticCheck {
        id: id.to_string(),
        title: title.to_string(),
        status: status.to_string(),
        detail,
        action,
    }
}

fn selected_network<'a>(networks: &'a [NetworkInterface], selected_ip: &str) -> Option<&'a NetworkInterface> {
    networks.iter().find(|nic| nic.address == selected_ip)
}

fn recommended_lan_network(networks: &[NetworkInterface]) -> Option<&NetworkInterface> {
    networks
        .iter()
        .find(|nic| nic.is_private && (nic.kind == "wifi" || nic.kind == "ethernet"))
        .or_else(|| networks.iter().find(|nic| nic.is_private && nic.kind != "virtual"))
}

fn recommended_tailscale_network(networks: &[NetworkInterface]) -> Option<&NetworkInterface> {
    networks
        .iter()
        .find(|nic| nic.kind == "vpn" && is_tailscale_ipv4(&nic.address))
        .or_else(|| networks.iter().find(|nic| is_tailscale_ipv4(&nic.address)))
        .or_else(|| networks.iter().find(|nic| nic.kind == "vpn"))
}

fn pairing_payload_relay(payload: &Option<String>) -> Option<String> {
    let raw = payload.as_ref()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    parsed.get("relay").and_then(|relay| relay.as_str()).map(|s| s.to_string())
}

fn pairing_payload_expiry(payload: &Option<String>) -> Option<i64> {
    let raw = payload.as_ref()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    parsed.get("expiresAt").and_then(|expires| expires.as_i64())
}

fn runtime_process_status(app_handle: &tauri::AppHandle) -> (bool, bool) {
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
        add_log(&app_handle, "app", "info", "Runtime bridge and relay are current");
    } else if status.refresh_deferred {
        add_log(&app_handle, "app", "warning", "Runtime refresh deferred until bridge and relay stop");
    } else if status.refresh_available {
        add_log(&app_handle, "app", "warning", &status.message);
    }
    Ok(status)
}

#[tauri::command]
async fn get_diagnostics(app_handle: tauri::AppHandle) -> Result<DiagnosticsSnapshot, String> {
    let state = app_handle.state::<AppState>();
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let selected_ip = state.selected_ip.lock().map_err(|e| e.to_string())?.clone();
    let relay_url = state.relay_url.lock().map_err(|e| e.to_string())?.clone();
    let pairing_payload = state.pairing_payload.lock().map_err(|e| e.to_string())?.clone();
    let pairing_code = state.pairing_code.lock().map_err(|e| e.to_string())?.clone();
    let phone_connected = *state.phone_connected.lock().map_err(|e| e.to_string())?;
    let logs = state.logs.lock().map_err(|e| e.to_string())?.clone();
    let (relay_running, bridge_running) = runtime_process_status(&app_handle);
    let runtime = runtime_bundle_status(relay_running || bridge_running);
    let debug = debug_paths()?;
    let networks = detect_network_interfaces();
    let mut checks = Vec::new();
    let mut recommended_actions = Vec::new();

    let runtime_action = if runtime.refresh_available && !runtime.refresh_deferred {
        Some(diagnostic_action("refreshRuntime", "Refresh runtime", None))
    } else {
        None
    };
    if let Some(action) = runtime_action.clone() {
        recommended_actions.push(action);
    }
    checks.push(diagnostic_check(
        "runtime-current",
        "Bundled bridge and relay",
        if runtime.runtime_current || runtime.bundled_manifest.is_none() { "pass" } else if runtime.refresh_deferred { "warn" } else { "fail" },
        runtime.message.clone(),
        runtime_action,
    ));

    let node_ok = debug.node_version.starts_with('v');
    checks.push(diagnostic_check(
        "node",
        "Node.js",
        if node_ok { "pass" } else { "fail" },
        if node_ok { format!("Detected {}", debug.node_version) } else { "Node.js was not detected on PATH.".to_string() },
        None,
    ));

    checks.push(diagnostic_check(
        "runtime-paths",
        "Runtime files",
        if debug.relay_server_exists && debug.bridge_bin_exists { "pass" } else { "fail" },
        format!(
            "Relay server: {}. Bridge binary: {}.",
            if debug.relay_server_exists { "found" } else { "missing" },
            if debug.bridge_bin_exists { "found" } else { "missing" },
        ),
        None,
    ));

    let port_available = is_port_available(config.relay_port);
    let port_status = if relay_running || port_available { "pass" } else { "fail" };
    let port_action = if !relay_running && !port_available {
        let suggested = find_available_port(config.relay_port);
        let action = diagnostic_action("applyPort", &format!("Use port {suggested}"), Some(suggested.to_string()));
        recommended_actions.push(action.clone());
        Some(action)
    } else {
        None
    };
    checks.push(diagnostic_check(
        "port",
        "Relay port",
        port_status,
        if relay_running {
            format!("Relay is running on configured port {}.", config.relay_port)
        } else if port_available {
            format!("Port {} is available.", config.relay_port)
        } else {
            format!("Port {} is already in use.", config.relay_port)
        },
        port_action,
    ));

    let network_check = if selected_ip.is_empty() {
        let action = recommended_lan_network(&networks)
            .map(|nic| diagnostic_action("selectNetwork", &format!("Use {}", nic.address), Some(nic.address.clone())));
        if let Some(action) = action.clone() {
            recommended_actions.push(action);
        }
        diagnostic_check(
            "network",
            "Selected network",
            "warn",
            "No phone-reachable network is selected. The Host will use 127.0.0.1, which phones cannot reach.".to_string(),
            action,
        )
    } else if selected_ip == "127.0.0.1" || selected_ip.eq_ignore_ascii_case("localhost") {
        diagnostic_check(
            "network",
            "Selected network",
            "fail",
            "Loopback points back to this PC and cannot be reached from the phone.".to_string(),
            recommended_lan_network(&networks)
                .map(|nic| diagnostic_action("selectNetwork", &format!("Use {}", nic.address), Some(nic.address.clone()))),
        )
    } else if let Some(nic) = selected_network(&networks, &selected_ip) {
        diagnostic_check(
            "network",
            "Selected network",
            "pass",
            format!("{} ({}) is selected.", nic.address, nic.kind),
            None,
        )
    } else {
        diagnostic_check(
            "network",
            "Selected network",
            "warn",
            format!("{selected_ip} is saved but was not found in detected interfaces."),
            recommended_lan_network(&networks)
                .map(|nic| diagnostic_action("selectNetwork", &format!("Use {}", nic.address), Some(nic.address.clone()))),
        )
    };
    if let Some(action) = network_check.action.clone() {
        recommended_actions.push(action);
    }
    checks.push(network_check);

    let active_relay_url = if config.relay_mode == "remote" {
        config.remote_relay_url.clone()
    } else if relay_url.is_empty() {
        if selected_ip.is_empty() {
            format!("ws://127.0.0.1:{}/relay", config.relay_port)
        } else {
            format!("ws://{}:{}/relay", selected_ip, config.relay_port)
        }
    } else {
        relay_url.clone()
    };
    let (relay_policy_status, relay_policy_detail) = relay_url_policy(&active_relay_url);
    checks.push(diagnostic_check(
        "relay-url",
        "Relay URL",
        &relay_policy_status,
        format!("{active_relay_url} - {relay_policy_detail}"),
        None,
    ));

    let qr_relay = pairing_payload_relay(&pairing_payload);
    let qr_status = if pairing_payload.is_some() && qr_relay.as_deref() == Some(active_relay_url.as_str()) {
        "pass"
    } else if pairing_payload.is_some() {
        "warn"
    } else {
        "warn"
    };
    let expiry_detail = pairing_payload_expiry(&pairing_payload)
        .map(|expires| format!(" Expires at epoch ms {expires}."))
        .unwrap_or_default();
    checks.push(diagnostic_check(
        "pairing",
        "Pairing QR",
        qr_status,
        if pairing_payload.is_none() {
            "No QR payload captured yet. Start relay and bridge to generate pairing.".to_string()
        } else if qr_relay.as_deref() == Some(active_relay_url.as_str()) {
            format!("QR relay matches current relay URL.{expiry_detail}")
        } else {
            format!(
                "QR relay is {} but current relay URL is {}.",
                qr_relay.unwrap_or_else(|| "(missing)".to_string()),
                active_relay_url,
            )
        },
        None,
    ));

    checks.push(diagnostic_check(
        "processes",
        "Processes",
        if relay_running && bridge_running { "pass" } else if relay_running || bridge_running { "warn" } else { "warn" },
        format!(
            "Relay: {}. Bridge: {}. Pairing code: {}. Phone: {}.",
            if relay_running { "running" } else { "stopped" },
            if bridge_running { "running" } else { "stopped" },
            if pairing_code.is_some() { "ready" } else { "not ready" },
            if phone_connected { "connected" } else { "not connected" },
        ),
        None,
    ));

    let last_error = logs.iter().rev().find(|entry| entry.level == "error");
    checks.push(diagnostic_check(
        "last-error",
        "Last error",
        if last_error.is_some() { "warn" } else { "pass" },
        last_error
            .map(|entry| format!("[{}] {}", entry.source, entry.message))
            .unwrap_or_else(|| "No error logged in this Host session.".to_string()),
        None,
    ));

    let update_status = match app_handle.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let action = diagnostic_action("checkUpdate", "Review update", None);
                recommended_actions.push(action.clone());
                checks.push(diagnostic_check(
                    "updater",
                    "Host updates",
                    "warn",
                    format!("Version {} is available.", update.version),
                    Some(action),
                ));
                None
            }
            Ok(None) => Some(diagnostic_check(
                "updater",
                "Host updates",
                "pass",
                "No Host update is currently available.".to_string(),
                None,
            )),
            Err(error) => Some(diagnostic_check(
                "updater",
                "Host updates",
                "warn",
                format!("Update check failed: {error}"),
                Some(diagnostic_action("checkUpdate", "Retry update check", None)),
            )),
        },
        Err(error) => Some(diagnostic_check(
            "updater",
            "Host updates",
            "warn",
            format!("Updater unavailable: {error}"),
            None,
        )),
    };
    if let Some(check) = update_status {
        if let Some(action) = check.action.clone() {
            recommended_actions.push(action);
        }
        checks.push(check);
    }

    let lan_action = recommended_lan_network(&networks)
        .map(|nic| diagnostic_action("selectNetwork", &format!("Use {}", nic.address), Some(nic.address.clone())));
    let tailscale_action = recommended_tailscale_network(&networks)
        .map(|nic| diagnostic_action("selectNetwork", &format!("Use {}", nic.address), Some(nic.address.clone())));
    let presets = vec![
        SetupPreset {
            id: "same-wifi".to_string(),
            title: "Same Wi-Fi".to_string(),
            detail: recommended_lan_network(&networks)
                .map(|nic| format!("Use {} ({}) for phones on the same network.", nic.address, nic.name))
                .unwrap_or_else(|| "No Wi-Fi or Ethernet private address was detected.".to_string()),
            status: if lan_action.is_some() { "pass" } else { "warn" }.to_string(),
            action: lan_action,
        },
        SetupPreset {
            id: "tailscale".to_string(),
            title: "Tailscale".to_string(),
            detail: recommended_tailscale_network(&networks)
                .map(|nic| format!("Use {} ({}) for Tailscale pairing.", nic.address, nic.name))
                .unwrap_or_else(|| "No Tailscale-style address was detected.".to_string()),
            status: if tailscale_action.is_some() { "pass" } else { "warn" }.to_string(),
            action: tailscale_action,
        },
        SetupPreset {
            id: "custom-relay".to_string(),
            title: "Custom Relay".to_string(),
            detail: "Use a relay URL you control. Public relays should use wss://.".to_string(),
            status: if config.remote_relay_url.starts_with("wss://") { "pass" } else { "warn" }.to_string(),
            action: Some(diagnostic_action("openSettings", "Edit custom relay", None)),
        },
    ];

    let fail_count = checks.iter().filter(|check| check.status == "fail").count();
    let warn_count = checks.iter().filter(|check| check.status == "warn").count();
    let summary = if fail_count > 0 {
        format!("{fail_count} issue{} need attention before pairing.", if fail_count == 1 { "" } else { "s" })
    } else if warn_count > 0 {
        format!("{warn_count} warning{} found. Pairing may still work.", if warn_count == 1 { "" } else { "s" })
    } else {
        "Local setup looks ready.".to_string()
    };

    Ok(DiagnosticsSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339(),
        summary,
        checks,
        presets,
        recommended_actions,
        runtime,
        debug,
    })
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
    add_log(&app_handle, "app", "info", &format!("Selected network: {ip}"));
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
            std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".to_string())
        ));
    }

    // Ensure npm dependencies are installed
    if !ensure_deps(&relay_dir, &app_handle) {
        return Err("Failed to install relay dependencies. Check logs for details.".to_string());
    }

    add_log(&app_handle, "app", "info", &format!("Starting relay on port {port}..."));

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
    let _ = app_handle.emit("status-changed", AppStatus {
        state: "starting".to_string(),
        relay_mode: "local".to_string(),
        relay: "starting".to_string(),
        bridge: "stopped".to_string(),
        network: state.selected_ip.lock().ok().map(|s| s.clone()).unwrap_or_default(),
        relay_url: state.relay_url.lock().ok().map(|s| s.clone()).unwrap_or_default(),
        pairing_payload: None,
        pairing_code: None,
        phone_connected: false,
    });

    // Wait for relay to be ready
    let ah_wait = app_handle.clone();
    let wait_port = port;
    std::thread::spawn(move || {
        let ready = wait_for_port(wait_port, 15);
        let state = ah_wait.state::<AppState>();
        if ready {
            add_log(&ah_wait, "app", "info", &format!("Relay ready on port {wait_port}"));
        } else {
            add_log(&ah_wait, "app", "error", "Relay did not become ready in time");
        }
        // Emit status update
        let _ = ah_wait.emit("status-changed", AppStatus {
            state: if ready { "relay_running".to_string() } else { "error".to_string() },
            relay_mode: "local".to_string(),
            relay: if ready { "running".to_string() } else { "error".to_string() },
            bridge: "stopped".to_string(),
            network: state.selected_ip.lock().ok().map(|s| s.clone()).unwrap_or_default(),
            relay_url: state.relay_url.lock().ok().map(|s| s.clone()).unwrap_or_default(),
            pairing_payload: None,
            pairing_code: None,
            phone_connected: false,
        });
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

    add_log(&app_handle, "app", "info", &format!("Relay started (PID: {pid})"));
    add_log(&app_handle, "app", "info", &format!("Relay URL: {relay_url}"));

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
                let intentional = state.relay_intentional.lock().ok().map(|i| *i).unwrap_or(true);
                if let Ok(mut guard) = state.relay_process.lock() {
                    *guard = None;
                }
                if intentional {
                    // reset flag
                    if let Ok(mut i) = state.relay_intentional.lock() { *i = false; }
                    return;
                }
                let code = status.code().unwrap_or(-1);
                add_log(&ah_watch, "app", "error", &format!("Relay crashed (exit code: {code})"));
                let _ = ah_watch.emit("process-crashed", serde_json::json!({
                    "process": "relay",
                    "exit_code": code,
                }));
                let _ = ah_watch.emit("status-changed", AppStatus {
                    state: "error".to_string(),
                    relay_mode: "local".to_string(),
                    relay: "error".to_string(),
                    bridge: "stopped".to_string(),
                    network: state.selected_ip.lock().ok().map(|s| s.clone()).unwrap_or_default(),
                    relay_url: state.relay_url.lock().ok().map(|s| s.clone()).unwrap_or_default(),
                    pairing_payload: None,
                    pairing_code: None,
                    phone_connected: false,
                });

                // Auto-restart
                let auto_restart = state.config.lock().ok().map(|c| c.auto_restart).unwrap_or(false);
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
    if let Ok(mut i) = state.relay_intentional.lock() { *i = true; }
    let mut guard = state.relay_process.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        add_log(&app_handle, "app", "info", "Stopping relay...");
        child.kill().map_err(|e| format!("Failed to kill relay: {e}"))?;
        child.wait().map_err(|e| format!("Failed to wait relay: {e}"))?;
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
            std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".to_string())
        ));
    }

    // Ensure npm dependencies are installed
    if !ensure_deps(&bridge_dir, &app_handle) {
        return Err("Failed to install bridge dependencies. Check logs for details.".to_string());
    }

    add_log(&app_handle, "app", "info", &format!("Starting bridge with relay: {relay_url}"));
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
                            if payload.get("relay").is_some() && payload.get("sessionId").is_some() {
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
                        add_log(&ah_pairing, "app", "warning", "Failed to parse pairing payload");
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
    let relay_mode = app_handle.state::<AppState>().config.lock().ok().map(|c| c.relay_mode.clone()).unwrap_or_else(|| "local".to_string());
    let _ = ah_status.emit("status-changed", AppStatus {
        state: "starting".to_string(),
        relay_mode,
        relay: "running".to_string(),
        bridge: "starting".to_string(),
        network: app_handle.state::<AppState>().selected_ip.lock().ok().map(|s| s.clone()).unwrap_or_default(),
        relay_url: relay_url.clone(),
        pairing_payload: None,
        pairing_code: None,
        phone_connected: false,
    });

    add_log(&app_handle, "app", "info", &format!("Bridge started (PID: {pid})"));

    // Crash watcher
    let ah_watch = app_handle.clone();
    std::thread::spawn(move || {
        loop {
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
                let intentional = state.bridge_intentional.lock().ok().map(|i| *i).unwrap_or(true);
                if let Ok(mut guard) = state.bridge_process.lock() {
                    *guard = None;
                }
                if intentional {
                    if let Ok(mut i) = state.bridge_intentional.lock() { *i = false; }
                    return;
                }
                let code = status.code().unwrap_or(-1);
                add_log(&ah_watch, "app", "error", &format!("Bridge crashed (exit code: {code})"));
                let _ = ah_watch.emit("process-crashed", serde_json::json!({
                    "process": "bridge",
                    "exit_code": code,
                }));
                let _ = ah_watch.emit("status-changed", AppStatus {
                    state: "error".to_string(),
                    relay_mode: state.config.lock().ok().map(|c| c.relay_mode.clone()).unwrap_or_else(|| "local".to_string()),
                    relay: state.relay_process.lock().ok().and_then(|p| p.as_ref().map(|_| "running".to_string())).unwrap_or_else(|| "stopped".to_string()),
                    bridge: "error".to_string(),
                    network: state.selected_ip.lock().ok().map(|s| s.clone()).unwrap_or_default(),
                    relay_url: state.relay_url.lock().ok().map(|s| s.clone()).unwrap_or_default(),
                    pairing_payload: None,
                    pairing_code: None,
                    phone_connected: false,
                });

                let auto_restart = state.config.lock().ok().map(|c| c.auto_restart).unwrap_or(false);
                if auto_restart {
                    add_log(&ah_watch, "app", "info", "Auto-restarting bridge...");
                    let _ = start_bridge(ah_watch.clone());
                }
                return;
            }
        }
    });

    Ok(format!("Bridge started, PID: {pid}"))
}

#[tauri::command]
fn stop_bridge(app_handle: tauri::AppHandle) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    if let Ok(mut i) = state.bridge_intentional.lock() { *i = true; }
    let mut guard = state.bridge_process.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        add_log(&app_handle, "app", "info", "Stopping bridge...");
        child.kill().map_err(|e| format!("Failed to kill bridge: {e}"))?;
        child.wait().map_err(|e| format!("Failed to wait bridge: {e}"))?;
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
        add_log(&app_handle, "app", "info", "Remote mode: skipping local relay");
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
    add_log(&app_handle, "app", "info", &format!("Relay mode set to: {mode}"));
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
    let pairing_payload = state.pairing_payload.lock().map_err(|e| e.to_string())?.clone();
    if pairing_payload.is_none() {
        if let Some(w) = app_handle.get_webview_window("pet-popup") {
            let _ = w.hide();
        }
        return Ok(());
    }

    let pet_pos = app_handle
        .get_webview_window("pet")
        .and_then(|pet| pet.outer_position().ok());
    let popup_x = pet_pos
        .map(|pos| (pos.x - 90).max(0))
        .unwrap_or(0);
    let popup_y = pet_pos
        .map(|pos| (pos.y - 222).max(0))
        .unwrap_or(0);

    if let Some(w) = app_handle.get_webview_window("pet-popup") {
        w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(popup_x, popup_y)))
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
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32)))
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
    let mut secrets = load_provider_bridge_secrets();
    secrets.api_key = normalized;
    save_provider_bridge_secrets(&secrets);
    add_log(
        &app_handle,
        "provider_bridge",
        "info",
        if secrets.api_key.is_some() {
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
                    add_log(app.handle(), "app", "info", "Runtime bridge and relay are current");
                }
                Ok(status) if status.refresh_available => {
                    add_log(app.handle(), "app", "warning", &status.message);
                }
                Ok(_) => {}
                Err(error) => {
                    add_log(app.handle(), "app", "error", &format!("Runtime refresh failed: {error}"));
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
            let screen_width = app.primary_monitor()
                .ok().flatten()
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
            let restart_bridge = MenuItemBuilder::with_id("restart_bridge", "Restart Bridge").build(app)?;
            let restart_relay = MenuItemBuilder::with_id("restart_relay", "Restart Relay").build(app)?;
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
                    } = event {
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
        write_file(&root.join("agnt-bridge").join("bin").join("agnt.js"), "bridge");
        write_file(&root.join(BUNDLE_MANIFEST), &fixture_manifest(bridge_hash, relay_hash));
    }

    #[test]
    fn relay_url_policy_accepts_lan_tailscale_and_secure_public() {
        assert_eq!(relay_url_policy("ws://192.168.1.5:9000/relay").0, "pass");
        assert_eq!(relay_url_policy("ws://100.100.100.100:9000/relay").0, "pass");
        assert_eq!(relay_url_policy("ws://macbook.tailnet.ts.net:9000/relay").0, "pass");
        assert_eq!(relay_url_policy("wss://relay.example.com/relay").0, "pass");
    }

    #[test]
    fn relay_url_policy_rejects_public_cleartext_and_credentials() {
        assert_eq!(relay_url_policy("ws://relay.example.com/relay").0, "fail");
        assert_eq!(relay_url_policy("wss://user:pass@relay.example.com/relay").0, "fail");
    }

    #[test]
    fn bundle_manifests_match_when_hashes_and_versions_match() {
        let a = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-a", "relay-a")).unwrap();
        let b = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-a", "relay-a")).unwrap();
        let c = serde_json::from_str::<BundleManifest>(&fixture_manifest("bridge-b", "relay-a")).unwrap();
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
        assert!(runtime.join("agnt-bridge").join("bin").join("agnt.js").exists());
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
