pub mod deepseek;

use serde_json::Value;

use super::errors::ProviderBridgeError;

// Pluggable upstream backend selected by `ProviderBridgeConfig::provider`.
// DeepSeek is the one concrete adapter today; a second backend slots in by
// adding a variant here and an `adapters/<id>.rs` module — routes, translators,
// state, and the Tauri command layer stay untouched.
#[derive(Clone, Copy, Debug)]
pub enum ProviderAdapter {
    DeepSeek,
}

impl ProviderAdapter {
    pub fn from_provider(provider: &str) -> Result<Self, ProviderBridgeError> {
        match provider {
            "deepseek" => Ok(Self::DeepSeek),
            other => Err(ProviderBridgeError::UnsupportedProvider(other.to_string())),
        }
    }

    pub async fn create_chat_completion(
        self,
        client: &reqwest::Client,
        api_key: &str,
        request: Value,
    ) -> Result<Value, ProviderBridgeError> {
        match self {
            Self::DeepSeek => deepseek::create_chat_completion(client, api_key, request).await,
        }
    }

    // Model ids (beyond the configured default) to advertise on `/v1/models`.
    pub fn extra_models(self) -> &'static [&'static str] {
        match self {
            Self::DeepSeek => deepseek::EXTRA_MODELS,
        }
    }
}
