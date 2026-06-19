use serde::{Deserialize, Serialize};
use std::net::IpAddr;

use super::errors::ProviderBridgeError;

fn default_bind_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    8787
}

fn default_provider() -> String {
    "deepseek".to_string()
}

fn default_model() -> String {
    "deepseek-v4-pro".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderBridgeConfig {
    #[serde(default = "default_bind_host")]
    pub bind_host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub default_model: String,
}

impl Default for ProviderBridgeConfig {
    fn default() -> Self {
        Self {
            bind_host: default_bind_host(),
            port: default_port(),
            provider: default_provider(),
            default_model: default_model(),
        }
    }
}

impl ProviderBridgeConfig {
    pub fn socket_addr(&self) -> Result<std::net::SocketAddr, ProviderBridgeError> {
        let ip = self
            .bind_host
            .parse::<IpAddr>()
            .map_err(|_| ProviderBridgeError::InvalidBindHost(self.bind_host.clone()))?;
        // Loopback-only is a hard safety property: the bridge holds a real
        // provider API key, so it must never be reachable off the local host.
        if !ip.is_loopback() {
            return Err(ProviderBridgeError::NonLoopbackBindHost(
                self.bind_host.clone(),
            ));
        }
        Ok(std::net::SocketAddr::new(ip, self.port))
    }

    pub fn base_url(&self) -> Result<String, ProviderBridgeError> {
        let addr = self.socket_addr()?;
        Ok(format!("http://{addr}"))
    }

    pub fn codex_config(&self) -> Result<ProviderBridgeCodexConfig, ProviderBridgeError> {
        Ok(ProviderBridgeCodexConfig {
            provider: self.provider.clone(),
            base_url: format!("{}/v1", self.base_url()?),
            api_key_env: "DEEPSEEK_API_KEY".to_string(),
            default_model: self.default_model.clone(),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderBridgeCodexConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key_env: String,
    pub default_model: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderKeyStatus {
    pub available: bool,
    pub source: String,
    pub has_stored_key: bool,
}
