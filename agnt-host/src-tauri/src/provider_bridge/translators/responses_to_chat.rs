use serde_json::{json, Map, Value};

use crate::provider_bridge::errors::ProviderBridgeError;

pub fn responses_to_chat_completion(
    request: &Value,
    default_model: &str,
) -> Result<Value, ProviderBridgeError> {
    let mut messages = Vec::new();
    if let Some(instructions) = request.get("instructions").and_then(Value::as_str) {
        messages.push(json!({
            "role": "system",
            "content": instructions
        }));
    }

    let input = request
        .get("input")
        .ok_or_else(|| ProviderBridgeError::UnsupportedRequest("missing input".to_string()))?;
    append_input_messages(input, &mut messages)?;

    let mut chat = Map::new();
    chat.insert(
        "model".to_string(),
        request
            .get("model")
            .cloned()
            .unwrap_or_else(|| Value::String(default_model.to_string())),
    );
    chat.insert("messages".to_string(), Value::Array(messages));
    copy_if_present(request, &mut chat, "temperature");
    copy_if_present(request, &mut chat, "top_p");
    copy_if_present_as(request, &mut chat, "max_output_tokens", "max_tokens");
    Ok(Value::Object(chat))
}

fn append_input_messages(
    input: &Value,
    messages: &mut Vec<Value>,
) -> Result<(), ProviderBridgeError> {
    match input {
        Value::String(text) => {
            messages.push(json!({
                "role": "user",
                "content": text
            }));
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                let role = item.get("role").and_then(Value::as_str).ok_or_else(|| {
                    ProviderBridgeError::UnsupportedRequest(
                        "array input items must include string role".to_string(),
                    )
                })?;
                let role = normalize_message_role(role)?;
                let content = item.get("content").ok_or_else(|| {
                    ProviderBridgeError::UnsupportedRequest(
                        "array input items must include content".to_string(),
                    )
                })?;
                let content = normalize_message_content(content)?;
                messages.push(json!({
                    "role": role,
                    "content": content
                }));
            }
            Ok(())
        }
        _ => Err(ProviderBridgeError::UnsupportedRequest(
            "input must be a string or an array of role/content messages".to_string(),
        )),
    }
}

fn normalize_message_role(role: &str) -> Result<&str, ProviderBridgeError> {
    match role {
        "developer" => Ok("system"),
        "system" | "user" | "assistant" | "tool" => Ok(role),
        other => Err(ProviderBridgeError::UnsupportedRequest(format!(
            "unsupported message role: {other}"
        ))),
    }
}

fn normalize_message_content(content: &Value) -> Result<Value, ProviderBridgeError> {
    match content {
        Value::String(_) => Ok(content.clone()),
        Value::Array(parts) => {
            let mut normalized_parts = Vec::with_capacity(parts.len());
            for part in parts {
                let part_type = part.get("type").and_then(Value::as_str).ok_or_else(|| {
                    ProviderBridgeError::UnsupportedRequest(
                        "content parts must include string type".to_string(),
                    )
                })?;
                let text = part.get("text").and_then(Value::as_str).ok_or_else(|| {
                    ProviderBridgeError::UnsupportedRequest(
                        "only text content parts with string text are supported".to_string(),
                    )
                })?;
                if !matches!(part_type, "input_text" | "output_text" | "text") {
                    return Err(ProviderBridgeError::UnsupportedRequest(format!(
                        "unsupported content part type: {part_type}"
                    )));
                }
                normalized_parts.push(json!({
                    "type": "text",
                    "text": text
                }));
            }
            Ok(Value::Array(normalized_parts))
        }
        _ => Err(ProviderBridgeError::UnsupportedRequest(
            "message content must be a string or an array of text parts".to_string(),
        )),
    }
}

fn copy_if_present(source: &Value, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = source.get(field) {
        target.insert(field.to_string(), value.clone());
    }
}

fn copy_if_present_as(source: &Value, target: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = source.get(from) {
        target.insert(to.to_string(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_messages_in_order_without_rewriting_content() {
        let request = json!({
            "model": "deepseek-chat",
            "instructions": "stay exact",
            "input": [
                { "role": "user", "content": "alpha" },
                { "role": "assistant", "content": "beta" },
                { "role": "user", "content": "alpha" }
            ],
            "temperature": 0.2,
            "max_output_tokens": 123
        });

        let translated = responses_to_chat_completion(&request, "fallback").unwrap();

        assert_eq!(translated["model"], "deepseek-chat");
        assert_eq!(
            translated["messages"],
            json!([
                { "role": "system", "content": "stay exact" },
                { "role": "user", "content": "alpha" },
                { "role": "assistant", "content": "beta" },
                { "role": "user", "content": "alpha" }
            ])
        );
        assert_eq!(translated["temperature"], 0.2);
        assert_eq!(translated["max_tokens"], 123);
    }

    #[test]
    fn ignores_response_stream_flag_for_chat_translation() {
        let request = json!({
            "input": "hello",
            "stream": true
        });

        let translated = responses_to_chat_completion(&request, "deepseek-chat").unwrap();
        assert!(translated.get("stream").is_none());
    }

    #[test]
    fn preserves_order_for_responses_text_parts() {
        let request = json!({
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "alpha" },
                        { "type": "input_text", "text": "beta" }
                    ]
                }
            ]
        });

        let translated = responses_to_chat_completion(&request, "deepseek-v4-pro").unwrap();

        assert_eq!(
            translated["messages"][0]["content"],
            json!([
                { "type": "text", "text": "alpha" },
                { "type": "text", "text": "beta" }
            ])
        );
    }

    #[test]
    fn rejects_non_text_content_parts() {
        let request = json!({
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_image", "image_url": "file:///tmp/a.png" }
                    ]
                }
            ]
        });

        assert!(matches!(
            responses_to_chat_completion(&request, "deepseek-v4-pro"),
            Err(ProviderBridgeError::UnsupportedRequest(message))
                if message.contains("only text content parts")
        ));
    }

    #[test]
    fn maps_developer_role_to_system_for_chat_completions() {
        let request = json!({
            "input": [
                {
                    "role": "developer",
                    "content": "follow repo instructions"
                }
            ]
        });

        let translated = responses_to_chat_completion(&request, "deepseek-v4-pro").unwrap();

        assert_eq!(translated["messages"][0]["role"], "system");
        assert_eq!(
            translated["messages"][0]["content"],
            "follow repo instructions"
        );
    }
}
