use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use crate::app_types::AppState;
use crate::network::detect_network_interfaces;
use crate::runtime_bundle::runtime_bundle_status;
use crate::{
    build_debug_paths, find_available_port, is_port_available, runtime_process_status,
    NetworkInterface,
};

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
    pub runtime: crate::runtime_bundle::RuntimeBundleStatus,
    pub debug: crate::app_types::DebugInfo,
}

pub(crate) fn is_private_ipv4(addr: &str) -> bool {
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

pub(crate) fn is_tailscale_ipv4(addr: &str) -> bool {
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
    if is_private_ipv4(&h)
        || is_tailscale_ipv4(&h)
        || h.starts_with("127.")
        || h.starts_with("169.254.")
    {
        return true;
    }
    if !h.contains(':') {
        return false;
    }
    h.starts_with("fc")
        || h.starts_with("fd")
        || h.starts_with("fe8")
        || h.starts_with("fe9")
        || h.starts_with("fea")
        || h.starts_with("feb")
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
    let path = if authority_end < rest.len() {
        &rest[authority_end..]
    } else {
        "/"
    };
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

pub(crate) fn relay_url_policy(raw: &str) -> (String, String) {
    let Some((scheme, host, _path)) = relay_url_parts(raw) else {
        return (
            "fail".to_string(),
            "Relay URL is invalid or contains unsupported credentials.".to_string(),
        );
    };
    let host_lower = host.to_lowercase();
    let cleartext = scheme == "ws" || scheme == "http";
    if cleartext && !is_local_relay_host(&host) {
        return (
            "fail".to_string(),
            "Public ws:// relay URLs are not allowed. Use local/Tailscale ws:// or secure wss://."
                .to_string(),
        );
    }
    if host_lower == "localhost" || host_lower == "127.0.0.1" {
        return (
            "warn".to_string(),
            "Loopback relay URLs only work on this PC, not from a phone.".to_string(),
        );
    }
    if cleartext && (is_tailscale_ipv4(&host_lower) || host_lower.ends_with(".ts.net")) {
        return (
            "pass".to_string(),
            "Tailscale relay URL is accepted as private transport.".to_string(),
        );
    }
    if cleartext {
        return (
            "pass".to_string(),
            "Local relay URL is accepted.".to_string(),
        );
    }
    (
        "pass".to_string(),
        "Secure relay URL is accepted.".to_string(),
    )
}

pub(crate) fn diagnostic_action(
    kind: &str,
    label: &str,
    value: Option<String>,
) -> DiagnosticAction {
    DiagnosticAction {
        kind: kind.to_string(),
        label: label.to_string(),
        value,
    }
}

pub(crate) fn diagnostic_check(
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

pub(crate) fn selected_network<'a>(
    networks: &'a [NetworkInterface],
    selected_ip: &str,
) -> Option<&'a NetworkInterface> {
    networks.iter().find(|nic| nic.address == selected_ip)
}

pub(crate) fn recommended_lan_network(networks: &[NetworkInterface]) -> Option<&NetworkInterface> {
    networks
        .iter()
        .find(|nic| nic.is_private && (nic.kind == "wifi" || nic.kind == "ethernet"))
        .or_else(|| {
            networks
                .iter()
                .find(|nic| nic.is_private && nic.kind != "virtual")
        })
}

pub(crate) fn recommended_tailscale_network(
    networks: &[NetworkInterface],
) -> Option<&NetworkInterface> {
    networks
        .iter()
        .find(|nic| nic.kind == "vpn" && is_tailscale_ipv4(&nic.address))
        .or_else(|| networks.iter().find(|nic| is_tailscale_ipv4(&nic.address)))
        .or_else(|| networks.iter().find(|nic| nic.kind == "vpn"))
}

pub(crate) fn pairing_payload_relay(payload: &Option<String>) -> Option<String> {
    let raw = payload.as_ref()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    parsed
        .get("relay")
        .and_then(|relay| relay.as_str())
        .map(|s| s.to_string())
}

pub(crate) fn pairing_payload_expiry(payload: &Option<String>) -> Option<i64> {
    let raw = payload.as_ref()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    parsed.get("expiresAt").and_then(|expires| expires.as_i64())
}

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
