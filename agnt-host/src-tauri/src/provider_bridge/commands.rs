use tauri::Manager;

use crate::{
    add_log,
    app_types::AppState,
    host_config::{
        provider_bridge_key_status, resolve_provider_bridge_api_key, store_provider_bridge_api_key,
    },
    provider_bridge,
};

#[tauri::command]
pub async fn start_provider_bridge(
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
pub async fn stop_provider_bridge(
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
pub fn get_provider_bridge_status(
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
pub fn get_provider_bridge_codex_config(
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
pub fn get_provider_bridge_key_status() -> provider_bridge::config::ProviderKeyStatus {
    provider_bridge_key_status()
}

#[tauri::command]
pub fn set_provider_bridge_api_key(
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
