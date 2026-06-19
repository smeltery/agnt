use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tower_http::trace::TraceLayer;

use super::{
    adapters::ProviderAdapter,
    config::ProviderBridgeConfig,
    errors::ProviderBridgeError,
    routes::{health, models, responses},
};

#[derive(Clone)]
pub struct ProviderBridgeAppState {
    pub config: ProviderBridgeConfig,
    pub client: reqwest::Client,
    pub api_key: String,
    pub adapter: ProviderAdapter,
}

pub struct RunningProviderBridge {
    pub shutdown_tx: oneshot::Sender<()>,
    pub task: JoinHandle<Result<(), std::io::Error>>,
}

pub async fn start(
    config: ProviderBridgeConfig,
    api_key: String,
) -> Result<RunningProviderBridge, ProviderBridgeError> {
    let adapter = ProviderAdapter::from_provider(&config.provider)?;

    let listener = TcpListener::bind(config.socket_addr()?).await?;
    let state = Arc::new(ProviderBridgeAppState {
        config,
        client: reqwest::Client::new(),
        api_key,
        adapter,
    });
    let app = Router::new()
        .route("/health", get(health::get_health))
        .route("/v1/models", get(models::get_models))
        .route("/v1/responses", post(responses::post_responses))
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
    });

    Ok(RunningProviderBridge { shutdown_tx, task })
}
