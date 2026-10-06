// FILE: providers/opencode/mappers.js
// Purpose: Convert opencode session/message shapes into bridge thread and turn payloads.
// Layer: provider plugin (opencode)
// Exports: inferImageMediaType, mapMessagesToTurns, mapSessionToSummary, mapSessionToThread
// Depends on: ../_shared/translator-utils

const {
  generateItemId,
  generateTurnId,
  numberOr,
  readString,
} = require("../_shared/translator-utils");

function mapSessionToThread(session, fallback = {}) {
  const id = readString(session?.id) || readString(fallback.id);
  return {
    id,
    threadId: id,
    thread_id: id,
    cwd: readString(session?.directory) || readString(fallback.cwd) || "",
    title: readString(session?.title) || "",
    status: "idle",
    turns: [],
    createdAt: numberOr(session?.time?.created, 0),
    updatedAt: numberOr(session?.time?.updated, 0),
  };
}

function mapSessionToSummary(session) {
  const id = readString(session?.id);
  return {
    id,
    threadId: id,
    thread_id: id,
    title: readString(session?.title) || "",
    status: "idle",
    cwd: readString(session?.directory) || "",
    createdAt: numberOr(session?.time?.created, 0),
    updatedAt: numberOr(session?.time?.updated, 0),
  };
}

function turnIdForMessage(messageId) {
  return messageId.startsWith("msg_") ? `turn_${messageId.slice(4)}` : messageId || generateTurnId();
}

function mapMessagesToTurns(messages) {
  const turns = [];
  let currentTurn = null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const info = message.info && typeof message.info === "object" ? message.info : message;
    const role = readString(info.role);
    const messageId = readString(info.id);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (role === "user") {
      currentTurn = {
        id: turnIdForMessage(messageId),
        turnId: turnIdForMessage(messageId),
        status: "completed",
        input: parts.map(mapPartToInput).filter(Boolean),
        items: [],
      };
      turns.push(currentTurn);
      continue;
    }
    if (role === "assistant") {
      if (!currentTurn) {
        currentTurn = {
          id: messageId || generateTurnId(),
          turnId: messageId || generateTurnId(),
          status: "completed",
          input: [],
          items: [],
        };
        turns.push(currentTurn);
      }
      for (const part of parts) {
        const item = mapPartToItem(part, messageId);
        if (item) currentTurn.items.push(item);
      }
    }
  }
  return turns;
}

function mapPartToInput(part) {
  if (!part || typeof part !== "object") return null;
  const type = readString(part.type);
  if (type === "text") return { type: "text", text: readString(part.text) };
  if (type === "image") return { type: "image", image_url: readString(part.url) };
  return null;
}

function mapPartToItem(part, messageId) {
  if (!part || typeof part !== "object") return null;
  const type = readString(part.type);
  const itemId = readString(part.id) || messageId || generateItemId("assistant");
  if (type === "text") {
    const text = readString(part.text);
    return {
      id: itemId,
      itemId,
      type: "assistant_message",
      role: "assistant",
      text,
      content: [{ type: "text", text }],
    };
  }
  if (type === "reasoning") {
    return {
      id: itemId,
      itemId,
      type: "reasoning",
      text: readString(part.text),
    };
  }
  if (type === "tool") {
    return {
      id: itemId,
      itemId,
      type: "tool_call",
      name: readString(part.tool),
    };
  }
  return null;
}

function inferImageMediaType(url) {
  if (typeof url !== "string") return "image/png";
  const dataMatch = /^data:([^;]+);/i.exec(url);
  if (dataMatch) return dataMatch[1];
  const lower = url.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

module.exports = {
  inferImageMediaType,
  mapMessagesToTurns,
  mapSessionToSummary,
  mapSessionToThread,
};
