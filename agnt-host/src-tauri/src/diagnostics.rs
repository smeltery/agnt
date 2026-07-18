use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use crate::app_types::AppState;
use crate::network::detect_network_interfaces;
use crate::runtime_bundle::runtime_bundle_status;
use crate::{build_debug_paths, find_available_port, is_port_available, runtime_process_status};

pub use crate::diagnostics_models::DiagnosticsSnapshot;
pub(crate) use crate::diagnostics_models::{diagnostic_action, diagnostic_check, SetupPreset};
pub(crate) use crate::diagnostics_policy::{
    is_private_ipv4, is_tailscale_ipv4, pairing_payload_expiry, pairing_payload_relay,
    recommended_lan_network, recommended_tailscale_network, relay_url_policy, selected_network,
};

pub(crate) async fn build_diagnostics_snapshot(
    app_handle: tauri::AppHandle,
) -> Result<DiagnosticsSnapshot, String> {
    let state = app_handle.state::<AppState>();
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let selected_ip = state.selected_ip.lock().map_err(|e| e.to_string())?.clone();
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
    let logs = state.logs.lock().map_err(|e| e.to_string())?.clone();
    let (relay_running, bridge_running) = runtime_process_status(&app_handle);
    let runtime = runtime_bundle_status(relay_running || bridge_running);
    let debug = build_debug_paths()?;
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
        if runtime.runtime_current || runtime.bundled_manifest.is_none() {
            "pass"
        } else if runtime.refresh_deferred {
            "warn"
        } else {
            "fail"
        },
        runtime.message.clone(),
        runtime_action,
    ));

    let node_ok = debug.node_version.starts_with('v');
    checks.push(diagnostic_check(
        "node",
        "Node.js",
        if node_ok { "pass" } else { "fail" },
        if node_ok {
            format!("Detected {}", debug.node_version)
        } else {
            "Node.js was not detected on PATH.".to_string()
        },
        None,
    ));

    checks.push(diagnostic_check(
        "runtime-paths",
        "Runtime files",
        if debug.relay_server_exists && debug.bridge_bin_exists {
            "pass"
        } else {
            "fail"
        },
        format!(
            "Relay server: {}. Bridge binary: {}.",
            if debug.relay_server_exists {
                "found"
            } else {
                "missing"
            },
            if debug.bridge_bin_exists {
                "found"
            } else {
                "missing"
            },
        ),
        None,
    ));

    let port_available = is_port_available(config.relay_port);
    let port_status = if relay_running || port_available {
        "pass"
    } else {
        "fail"
    };
    let port_action = if !relay_running && !port_available {
        let suggested = find_available_port(config.relay_port);
        let action = diagnostic_action(
            "applyPort",
            &format!("Use port {suggested}"),
            Some(suggested.to_string()),
        );
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
        let action = recommended_lan_network(&networks).map(|nic| {
            diagnostic_action(
                "selectNetwork",
                &format!("Use {}", nic.address),
                Some(nic.address.clone()),
            )
        });
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
            recommended_lan_network(&networks).map(|nic| {
                diagnostic_action(
                    "selectNetwork",
                    &format!("Use {}", nic.address),
                    Some(nic.address.clone()),
                )
            }),
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
            recommended_lan_network(&networks).map(|nic| {
                diagnostic_action(
                    "selectNetwork",
                    &format!("Use {}", nic.address),
                    Some(nic.address.clone()),
                )
            }),
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
    let qr_status =
        if pairing_payload.is_some() && qr_relay.as_deref() == Some(active_relay_url.as_str()) {
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
        if relay_running && bridge_running {
            "pass"
        } else if relay_running || bridge_running {
            "warn"
        } else {
            "warn"
        },
        format!(
            "Relay: {}. Bridge: {}. Pairing code: {}. Phone: {}.",
            if relay_running { "running" } else { "stopped" },
            if bridge_running { "running" } else { "stopped" },
            if pairing_code.is_some() {
                "ready"
            } else {
                "not ready"
            },
            if phone_connected {
                "connected"
            } else {
                "not connected"
            },
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

    let lan_action = recommended_lan_network(&networks).map(|nic| {
        diagnostic_action(
            "selectNetwork",
            &format!("Use {}", nic.address),
            Some(nic.address.clone()),
        )
    });
    let tailscale_action = recommended_tailscale_network(&networks).map(|nic| {
        diagnostic_action(
            "selectNetwork",
            &format!("Use {}", nic.address),
            Some(nic.address.clone()),
        )
    });
    let presets = vec![
        SetupPreset {
            id: "same-wifi".to_string(),
            title: "Same Wi-Fi".to_string(),
            detail: recommended_lan_network(&networks)
                .map(|nic| {
                    format!(
                        "Use {} ({}) for phones on the same network.",
                        nic.address, nic.name
                    )
                })
                .unwrap_or_else(|| {
                    "No Wi-Fi or Ethernet private address was detected.".to_string()
                }),
            status: if lan_action.is_some() { "pass" } else { "warn" }.to_string(),
            action: lan_action,
        },
        SetupPreset {
            id: "tailscale".to_string(),
            title: "Tailscale".to_string(),
            detail: recommended_tailscale_network(&networks)
                .map(|nic| format!("Use {} ({}) for Tailscale pairing.", nic.address, nic.name))
                .unwrap_or_else(|| "No Tailscale-style address was detected.".to_string()),
            status: if tailscale_action.is_some() {
                "pass"
            } else {
                "warn"
            }
            .to_string(),
            action: tailscale_action,
        },
        SetupPreset {
            id: "custom-relay".to_string(),
            title: "Custom Relay".to_string(),
            detail: "Use a relay URL you control. Public relays should use wss://.".to_string(),
            status: if config.remote_relay_url.starts_with("wss://") {
                "pass"
            } else {
                "warn"
            }
            .to_string(),
            action: Some(diagnostic_action("openSettings", "Edit custom relay", None)),
        },
    ];

    let fail_count = checks.iter().filter(|check| check.status == "fail").count();
    let warn_count = checks.iter().filter(|check| check.status == "warn").count();
    let summary = if fail_count > 0 {
        format!(
            "{fail_count} issue{} need attention before pairing.",
            if fail_count == 1 { "" } else { "s" }
        )
    } else if warn_count > 0 {
        format!(
            "{warn_count} warning{} found. Pairing may still work.",
            if warn_count == 1 { "" } else { "s" }
        )
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
