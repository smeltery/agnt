use reqwest::StatusCode;
use serde_json::Value;

use crate::provider_bridge::errors::ProviderBridgeError;

const DEEPSEEK_CHAT_COMPLETIONS_URL: &str = "https://api.deepseek.com/chat/completions";

// Extra model ids (beyond the configured default) this adapter advertises on
// `/v1/models`.
pub const EXTRA_MODELS: &[&str] = &["deepseek-v4-flash"];

pub async fn create_chat_completion(
    client: &reqwest::Client,
    api_key: &str,
    request: Value,
) -> Result<Value, ProviderBridgeError> {
    let response = client
        .post(DEEPSEEK_CHAT_COMPLETIONS_URL)
        .bearer_auth(api_key)
        .json(&request)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(ProviderBridgeError::UpstreamStatus {
            status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            body,
        });
    }

    Ok(response.json::<Value>().await?)
}
