use chrono::Utc;
use serde_json::{json, Value};

pub fn chat_completion_to_response(chat: Value) -> Value {
    let id = chat.get("id").and_then(Value::as_str).unwrap_or("response");
    let model = chat
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("deepseek-chat");
    let created_at = chat
        .get("created")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| Utc::now().timestamp());
    let output_text = chat
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let usage = chat.get("usage").cloned().unwrap_or_else(|| json!({}));

    json!({
        "id": id,
        "object": "response",
        "created_at": created_at,
        "status": "completed",
        "model": model,
        "output": [
            {
                "id": format!("{id}_message"),
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": output_text
                    }
                ]
            }
        ],
        "usage": usage
    })
}

pub fn chat_completion_to_stream_events(chat: Value) -> Vec<Value> {
    let response = chat_completion_to_response(chat);
    let item_id = response["output"][0]["id"]
        .as_str()
        .unwrap_or("response_message");
    let text = response["output"][0]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();

    vec![
        json!({
            "type": "response.created",
            "response": response.clone(),
            "sequence_number": 0
        }),
        json!({
            "type": "response.output_text.delta",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "delta": text,
            "sequence_number": 1
        }),
        json!({
            "type": "response.output_text.done",
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "text": text,
            "sequence_number": 2
        }),
        json!({
            "type": "response.completed",
            "response": response,
            "sequence_number": 3
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_chat_completion_to_responses_shape() {
        let chat = json!({
            "id": "chatcmpl-1",
            "created": 42,
            "model": "deepseek-chat",
            "choices": [
                {
                    "message": {
                        "content": "hello"
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 1,
                "total_tokens": 4
            }
        });

        let response = chat_completion_to_response(chat);

        assert_eq!(response["id"], "chatcmpl-1");
        assert_eq!(response["object"], "response");
        assert_eq!(response["created_at"], 42);
        assert_eq!(response["output"][0]["content"][0]["text"], "hello");
        assert_eq!(response["usage"]["total_tokens"], 4);
    }

    #[test]
    fn maps_chat_completion_to_stream_events() {
        let chat = json!({
            "id": "chatcmpl-1",
            "created": 42,
            "model": "deepseek-v4-pro",
            "choices": [
                {
                    "message": {
                        "content": "hello"
                    }
                }
            ]
        });

        let events = chat_completion_to_stream_events(chat);

        assert_eq!(events[0]["type"], "response.created");
        assert_eq!(events[1]["type"], "response.output_text.delta");
        assert_eq!(events[1]["delta"], "hello");
        assert_eq!(events[2]["type"], "response.output_text.done");
        assert_eq!(events[3]["type"], "response.completed");
        assert_eq!(events[3]["response"]["id"], "chatcmpl-1");
    }
}
