// FILE: providers/_shared/translator-utils.js
// Purpose: Tiny pure helpers shared by every translator. Extracted to keep the
//          three translator files (claude, opencode, cursor) from diverging on
//          things that are not provider-specific — JSON-RPC frame shapes,
//          opaque id generation, and a couple of defensive type coercions.
// Layer: shared translator utilities
// Exports: safeParseJson, readString, numberOr, generateThreadId,
//          generateTurnId, generateItemId, createFrameEmitter,
//          TURN_OVERLAP_ERROR_CODE, buildTurnOverlapError
//
// What lives here vs. in each translator:
//   - PURE shape: id formats and JSON-RPC envelope wrapping live here. The
//     framing must be byte-identical across providers since the iOS app
//     parses every shim's output through the same Codex JSON-RPC paths.
//   - PROVIDER-SPECIFIC content (tool lists, item shapes, session→thread
//     mappings, approval transcripts) stays in each translator.
//
// What does NOT live here:
//   - The synthetic response builders for `thread/start` / `thread/read` /
//     `thread/turns/list`. Their result *envelopes* are identical, but their
//     *content* diverges per provider (opencode populates `turns` from
//     /session/messages; claude/cursor return empty). Centralizing them
//     would force one direction at the cost of another.

const crypto = require("crypto");

// Identifier formats. Kept identical so the iOS app can render a single
// "thread"/"turn"/"item" pill regardless of provider. The 12-byte / 10-byte
// split mirrors what the existing translators picked — don't shrink it
// without reviewing how iOS treats id collisions across reconnects.
function generateThreadId() {
  return `thr_${crypto.randomBytes(12).toString("hex")}`;
}

function generateTurnId() {
  return `turn_${crypto.randomBytes(12).toString("hex")}`;
}

function generateItemId(kind) {
  return `${kind}_${crypto.randomBytes(10).toString("hex")}`;
}

// JSON-RPC error code used when a second `turn/start` arrives while one is
// already in flight. iOS UI usually disables Send during a turn but this is
// a backstop against reconnect races and pathological clients.
const TURN_OVERLAP_ERROR_CODE = -32003;
const TURN_OVERLAP_ERROR_MESSAGE = "A turn is already in flight on this thread";

function buildTurnOverlapError() {
  return {
    code: TURN_OVERLAP_ERROR_CODE,
    message: TURN_OVERLAP_ERROR_MESSAGE,
  };
}

/**
 * Builds the trio of frame-emitting helpers that every translator needs:
 * an unsolicited notification, a response to a prior request, and an error
 * response. All three serialize to a single JSON-RPC line and push it back
 * into the bridge via the translator's `injectInbound` callback.
 *
 * Frames intentionally omit `"jsonrpc": "2.0"` because the existing
 * translators omitted it and the iOS app already tolerates the bare shape.
 * Keep it that way unless you also update the parity tests on agnt-web /
 * AgntAndroid.
 *
 * @param {(line: string) => void} injectInbound
 * @returns {{
 *   emitNotification: (method: string, params: object) => void,
 *   injectResponse:  (id: string|number, result: object) => void,
 *   respondError:    (id: string|number|null, code: number, message: string) => void,
 * }}
 */
function createFrameEmitter(injectInbound) {
  return {
    emitNotification(method, params) {
      injectInbound(JSON.stringify({ method, params }));
    },
    injectResponse(id, result) {
      injectInbound(JSON.stringify({ id, result }));
    },
    respondError(id, code, message) {
      if (id == null) return;
      injectInbound(JSON.stringify({ id, error: { code, message } }));
    },
  };
}

function safeParseJson(line) {
  if (typeof line !== "string") return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value ? value : "";
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

module.exports = {
  TURN_OVERLAP_ERROR_CODE,
  TURN_OVERLAP_ERROR_MESSAGE,
  buildTurnOverlapError,
  createFrameEmitter,
  generateItemId,
  generateThreadId,
  generateTurnId,
  numberOr,
  readString,
  safeParseJson,
};
