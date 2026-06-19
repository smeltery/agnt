use std::sync::Arc;

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::provider_bridge::server::ProviderBridgeAppState;

pub async fn get_models(State(state): State<Arc<ProviderBridgeAppState>>) -> Json<Value> {
    let mut data = vec![json!({
        "id": state.config.default_model.clone(),
        "object": "model",
        "owned_by": state.config.provider.clone()
    })];

    for model in state.adapter.extra_models() {
        data.push(json!({
            "id": *model,
            "object": "model",
            "owned_by": state.config.provider.clone()
        }));
    }

    Json(json!({
        "object": "list",
        "data": data
    }))
}
