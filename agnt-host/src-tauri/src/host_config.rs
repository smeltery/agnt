use std::fs;

use crate::provider_bridge;

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

fn default_relay_mode() -> String {
    "local".to_string()
}

fn default_free_message_limit() -> u32 {
    5
}

fn default_log_level() -> String {
    "info".to_string()
}

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

pub fn config_path() -> std::path::PathBuf {
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

pub fn load_config() -> AppConfig {
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

pub fn save_config(config: &AppConfig) {
    let path = config_path();
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

// The provider-bridge API key is stored apart from config.json so it never
// rides along with exported/synced settings.
fn provider_bridge_secret_path() -> std::path::PathBuf {
    if let Some(dir) = dirs::config_dir() {
        let p = dir.join("agnt-host").join("provider-bridge-secrets.json");
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

pub fn provider_bridge_key_status() -> provider_bridge::config::ProviderKeyStatus {
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

pub fn resolve_provider_bridge_api_key() -> Option<String> {
    provider_bridge_env_api_key().or_else(|| {
        load_provider_bridge_secrets()
            .api_key
            .filter(|value| !value.trim().is_empty())
    })
}

pub fn store_provider_bridge_api_key(api_key: Option<String>) {
    let mut secrets = load_provider_bridge_secrets();
    secrets.api_key = api_key;
    save_provider_bridge_secrets(&secrets);
}
