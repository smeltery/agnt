// FILE: network.rs
// Purpose: Detects local network interfaces for relay binding and setup guidance.
// Layer: Tauri backend support
// Exports: NetworkInterface, detect_network_interfaces
// Depends on: std::process::Command, serde_json, diagnostics IP helpers

use std::process::Command;

use crate::diagnostics::{is_private_ipv4, is_tailscale_ipv4};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(serde::Serialize, Clone, Debug)]
pub struct NetworkInterface {
    pub name: String,
    pub address: String,
    pub kind: String,
    pub is_private: bool,
}

pub fn detect_network_interfaces() -> Vec<NetworkInterface> {
    let mut interfaces = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile", "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object IPAddress, InterfaceAlias | ConvertTo-Json -Compress"
        ]);
        hide_console(&mut cmd);
        if let Ok(output) = cmd.output() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                if let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                    for v in values {
                        let name = v["InterfaceAlias"]
                            .as_str()
                            .unwrap_or("unknown")
                            .to_string();
                        let address = v["IPAddress"].as_str().unwrap_or("").to_string();
                        if !address.is_empty() {
                            let is_virt = is_virtual_interface(&name);
                            let is_vpn = is_vpn_interface(&name);
                            let is_priv = is_private_ipv4(&address) || is_tailscale_ipv4(&address);
                            let kind = if is_vpn {
                                "vpn"
                            } else if is_virt {
                                "virtual"
                            } else if name.to_lowercase().contains("wi-fi")
                                || name.to_lowercase().contains("wifi")
                            {
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
                } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    if let Some(obj) = v.as_object() {
                        let name = obj
                            .get("InterfaceAlias")
                            .and_then(|s| s.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let address = obj
                            .get("IPAddress")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
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

    interfaces.sort_by(|a, b| {
        b.is_private
            .cmp(&a.is_private)
            .then(a.kind.cmp(&b.kind))
            .then(a.address.cmp(&b.address))
    });

    interfaces
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(target_os = "windows")]
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

#[cfg(target_os = "windows")]
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
