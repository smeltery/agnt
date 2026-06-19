use std::sync::Arc;

use std::convert::Infallible;

use axum::{
    extract::State,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream;

use crate::provider_bridge::{
    errors::ProviderBridgeError,
    server::ProviderBridgeAppState,
    translators::{
        chat_to_responses::chat_completion_to_response,
        chat_to_responses::chat_completion_to_stream_events,
        responses_to_chat::responses_to_chat_completion,
    },
};

pub async fn post_responses(
    State(state): State<Arc<ProviderBridgeAppState>>,
    Json(request): Json<serde_json::Value>,
) -> Result<Response, ProviderBridgeError> {
    let wants_stream = request.get("stream").and_then(serde_json::Value::as_bool) == Some(true);
    let chat_request = responses_to_chat_completion(&request, &state.config.default_model)?;
    let chat_response = state
        .adapter
        .create_chat_completion(&state.client, &state.api_key, chat_request)
        .await?;

    if wants_stream {
        let events = chat_completion_to_stream_events(chat_response)
            .into_iter()
            .map(|event| Ok::<_, Infallible>(Event::default().json_data(event).unwrap()));
        return Ok(Sse::new(stream::iter(events))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    Ok(Json(chat_completion_to_response(chat_response)).into_response())
}
