use std::process::Child;
use std::sync::Mutex;

use crate::host_config::AppConfig;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct LogEntry {
    pub timestamp: String,
    pub source: String,
    pub level: String,
    pub message: String,
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
