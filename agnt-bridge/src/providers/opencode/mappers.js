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

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? { createdAt: value } : {};
}

function mapMessagesToTurns(messages) {
  const turns = [];
  let currentTurn = null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const info = message.info && typeof message.info === "object" ? message.info : message;
    const role = readString(info.role);
    if (role !== "user" && role !== "assistant") continue;
    const messageId = readString(info.id) || generateItemId(role);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (role === "user" || !currentTurn) {
      const turnId = turnIdForMessage(messageId);
      currentTurn = { id: turnId, turnId, status: "completed", input: [], items: [], ...timestamp(info.time?.created) };
      turns.push(currentTurn);
    }
    if (role === "user") {
      currentTurn.input = parts.map(mapPartToInput).filter(Boolean);
      currentTurn.items.push({ id: messageId, itemId: messageId, type: "user_message", role,
        content: currentTurn.input, ...timestamp(info.time?.created) });
      continue;
    }
    let emittedText = false;
    for (const part of parts) {
      if (part?.type === "text") {
        if (emittedText) continue;
        emittedText = true;
        // Live deltas use the message ID, including messages with multiple text parts.
        const text = parts.filter((entry) => entry?.type === "text").map((entry) => rawText(entry.text)).join("");
        currentTurn.items.push({ id: messageId, itemId: messageId, type: "assistant_message", role,
          text, content: [{ type: "text", text }], ...timestamp(info.time?.created) });
      } else {
        const item = mapPartToItem(part, messageId, info.time?.created);
        if (item) currentTurn.items.push(item);
      }
    }
  }
  return turns;
}

function rawText(value) { return typeof value === "string" ? value : ""; }

function mapPartToInput(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text") return { type: "text", text: rawText(part.text) };
  if (part.type === "image" || (part.type === "file" && part.mime?.startsWith("image/"))) {
    return { type: "image", image_url: readString(part.url) };
  }
  if (part.type === "file") return { type: "text", text: readString(part.filename) || readString(part.url) || "File attachment" };
  return null;
}

function mapPartToItem(part, messageId, createdAt) {
  if (!part || typeof part !== "object") return null;
  const itemId = readString(part.id) || `${messageId}-${part.type}`;
  const identity = { id: itemId, itemId, ...timestamp(part.time?.start || createdAt) };
  if (part.type === "reasoning") {
    return { ...identity, type: "reasoning", text: rawText(part.text), content: [{ type: "text", text: rawText(part.text) }] };
  }
  if (part.type === "tool") {
    const tool = readString(part.tool) || "tool";
    const state = part.state || {};
    const input = state.input || {};
    const output = rawText(state.output) || rawText(state.error);
    return { ...identity, type: tool === "bash" ? "commandExecution" : "tool_call",
      name: tool, tool, command: readString(input.command) || tool,
      arguments: input, cwd: readString(input.cwd),
      status: state.status === "error" ? "failed" : readString(state.status) || "inProgress",
      output, aggregatedOutput: output };
  }
  if (part.type === "file") {
    return { ...identity, type: "assistant_message", role: "assistant",
      text: readString(part.filename) || readString(part.url) || "File attachment" };
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
  turnIdForMessage,
};
