// FILE: providers/_shared/thread-jsonl-reconstructor.js
// Purpose: Best-effort reconstruction of a finished thread from a single
//          newline-delimited JSON rollout file. Both the Claude shim
//          (~/.claude/projects/<encoded>/<session>.jsonl) and the Cursor
//          shim (~/.cursor/chats/<sessionId>.jsonl) write rollouts in the
//          same shape: an interleaved stream of {type:"user"|"assistant",
//          message:{content,...}, uuid, cwd?} entries.
// Layer: shared translator utility (filesystem-aware)
// Exports: readUserMessageText, reconstructThreadFromJsonl
//
// Why this isn't in translator-utils.js: that module is pure. This one
// reads from disk and pulls in fs/path. Keeping the filesystem boundary
// isolated keeps the pure utils mockable without monkey-patching fs.
//
// What's *not* here:
//   - Locating the session file on disk. The Claude rollout lives under a
//     URL-encoded project dir; Cursor's is a flat chats/<id>.jsonl. Each
//     translator passes a resolved path in.
//   - opencode's REST-based thread reconstruction (uses /session + /message
//     endpoints, not a JSONL file).

const fs = require("fs");
const { generateItemId, generateTurnId, readString, safeParseJson } = require("./translator-utils");

function readUserMessageText(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push(entry);
    } else if (entry && typeof entry === "object" && entry.type === "text") {
      parts.push(readString(entry.text));
    }
  }
  return parts.join("");
}

/**
 * Reconstructs a thread snapshot from a JSONL rollout file. Returns the
 * same envelope shape that `thread/read` / `thread/turns/list` consumers
 * expect: `{ id, threadId, thread_id, cwd, status, turns: [...] }`.
 *
 * Parts handled today: `text` (assistant message) and `thinking`
 * (reasoning bubble). Claude emits both; Cursor only emits `text`, so the
 * `thinking` branch is a no-op there.
 *
 * @param {object} opts
 * @param {string} opts.targetThreadId
 * @param {string} opts.sessionFile     Absolute path to the JSONL file.
 * @param {string} [opts.fallbackCwd]   Used if the file has no cwd entries.
 * @returns {object|null} Thread snapshot, or null if the file is unreadable.
 */
function reconstructThreadFromJsonl({ targetThreadId, sessionFile, fallbackCwd = "" }) {
  if (!sessionFile) return null;
  let raw;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return null;
  }
  const turns = [];
  let currentTurn = null;
  let cwd = "";
  for (const line of raw.split("\n")) {
    const entry = safeParseJson(line);
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.cwd === "string" && !cwd) cwd = entry.cwd;
    if (entry.type === "user" && entry.message && typeof entry.message === "object") {
      const text = readUserMessageText(entry.message);
      if (!text) continue;
      currentTurn = {
        id: readString(entry.uuid) || generateTurnId(),
        turnId: readString(entry.uuid) || generateTurnId(),
        status: "completed",
        input: [{ type: "text", text }],
        items: [],
      };
      turns.push(currentTurn);
      continue;
    }
    if (entry.type === "assistant" && entry.message && typeof entry.message === "object") {
      if (!currentTurn) continue;
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const t = readString(part.type);
        if (t === "text" && readString(part.text)) {
          currentTurn.items.push({
            id: readString(entry.uuid) || generateItemId("assistant"),
            type: "assistant_message",
            role: "assistant",
            text: part.text,
            content: [{ type: "text", text: part.text }],
          });
        } else if (t === "thinking" && readString(part.thinking)) {
          currentTurn.items.push({
            id: generateItemId("thinking"),
            type: "reasoning",
            text: part.thinking,
          });
        }
      }
    }
  }
  return {
    id: targetThreadId,
    threadId: targetThreadId,
    thread_id: targetThreadId,
    cwd: cwd || fallbackCwd || process.cwd(),
    status: "idle",
    turns,
  };
}

module.exports = {
  readUserMessageText,
  reconstructThreadFromJsonl,
};
