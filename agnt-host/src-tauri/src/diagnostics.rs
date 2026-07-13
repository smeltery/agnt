use crate::NetworkInterface;

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
    pub debug: crate::DebugInfo,
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
