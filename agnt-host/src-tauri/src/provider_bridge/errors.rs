use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderBridgeError {
    #[error("provider bridge is already running")]
    AlreadyRunning,
    #[error("provider bridge is not running")]
    NotRunning,
    #[error("invalid provider bridge bind host: {0}")]
    InvalidBindHost(String),
    #[error("provider bridge bind host must be loopback-only: {0}")]
    NonLoopbackBindHost(String),
    #[error("unsupported provider: {0}")]
    UnsupportedProvider(String),
    #[error("provider bridge API key is not set")]
    MissingApiKey,
    #[error("unsupported Responses API request shape: {0}")]
    UnsupportedRequest(String),
    #[error("upstream request failed: {0}")]
    Upstream(#[from] reqwest::Error),
    #[error("upstream provider returned {status}: {body}")]
    UpstreamStatus { status: StatusCode, body: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("provider bridge task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

impl IntoResponse for ProviderBridgeError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::MissingApiKey => StatusCode::SERVICE_UNAVAILABLE,
            Self::UnsupportedRequest(_) => StatusCode::BAD_REQUEST,
            Self::UnsupportedProvider(_) => StatusCode::NOT_IMPLEMENTED,
            Self::UpstreamStatus { status, .. } => status,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        (
            status,
            Json(json!({
                "error": {
                    "message": self.to_string(),
                    "type": "provider_bridge_error"
                }
            })),
        )
            .into_response()
    }
}
