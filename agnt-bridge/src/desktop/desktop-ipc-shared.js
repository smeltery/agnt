// FILE: desktop-ipc-shared.js
// Purpose: Shared primitives for the Codex Desktop IPC modules (framing, socket path, envelopes, JSON helpers).
// Layer: CLI helper
// Exports: FRAME_HEADER_BYTES, MAX_FRAME_BYTES, cloneJSON, normalizeToken, readString, readText, requestIdKey, resolveDefaultIpcSocketPath, resolveIpcSocketPathCandidates, safeParseJSON, writeFrame
// Depends on: fs, os, path

const fs = require("fs");
const os = require("os");
const path = require("path");

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

const CLIENT_STATUS_CHANGED = "client-status-changed";
const THREAD_STREAM_FOLLOWING_CHANGED = "thread-stream-following-changed";
const THREAD_STREAM_FOLLOWING_STATUS_REQUESTED = "thread-stream-following-status-requested";

// Single source of truth for Codex Desktop's IPC method versions. Desktop's
// bundled map validates versions on both requests and broadcasts, and this
// table already drifted once while it lived in two modules.
const DESKTOP_IPC_METHOD_VERSIONS = new Map([
  ["initialize", 1],
  [CLIENT_STATUS_CHANGED, 1],
  // Desktop pins thread-stream-state-changed at version 8 and drops mismatches.
  ["thread-stream-state-changed", 8],
  [THREAD_STREAM_FOLLOWING_CHANGED, 1],
  [THREAD_STREAM_FOLLOWING_STATUS_REQUESTED, 1],
  ["thread-archived", 2],
  ["thread-unarchived", 1],
  ["thread-read-state-changed", 1],
  ["thread-queued-followups-changed", 1],
  ["thread-follower-start-turn", 1],
  ["thread-follower-load-complete-history", 1],
  ["thread-follower-update-thread-settings", 1],
  ["thread-follower-compact-thread", 1],
  ["thread-follower-steer-turn", 1],
  ["thread-follower-interrupt-turn", 2],
  ["thread-follower-set-model-and-reasoning", 1],
  ["thread-follower-set-collaboration-mode", 1],
  ["thread-follower-edit-last-user-turn", 2],
  ["thread-follower-command-approval-decision", 1],
  ["thread-follower-file-approval-decision", 1],
  ["thread-follower-permissions-request-approval-response", 1],
  ["thread-follower-submit-user-input", 1],
  ["thread-follower-submit-mcp-server-elicitation-response", 1],
  ["thread-follower-set-queued-follow-ups-state", 1],
]);

// Mirrors Codex's ContextualUserFragment registry. Keep this exact: arbitrary
// XML is valid user input, while these runtime-owned markers are hidden history.
const CONTEXT_MARKER_PAIRS = [
  ["<environment_context>", "</environment_context>"],
  ["<skill>", "</skill>"],
  ["<user_shell_command>", "</user_shell_command>"],
  ["<turn_aborted>", "</turn_aborted>"],
  ["<subagent_notification>", "</subagent_notification>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
  ["<goal_context>", "</goal_context>"],
  // Review mode records this raw handoff in history, then emits the visible
  // review result separately. Showing it as a user bubble leaks runtime state.
  ["<user_action>", "</user_action>"],
];
const LEGACY_CONTEXT_WARNING_PREFIXES = [
  "Warning: The maximum number of unified exec processes you can keep open is",
  "Warning: Your account was flagged for potentially high-risk cyber activity",
];
const LEGACY_APPLY_PATCH_WARNING_PREFIX = "Warning: apply_patch was requested via ";
const LEGACY_APPLY_PATCH_WARNING_SUFFIX = "Use the apply_patch tool instead of exec_command.";
const AGENTS_INSTRUCTIONS_PREFIX = "# AGENTS.md instructions";
const AGENTS_INSTRUCTIONS_BEGIN = "<instructions>";
const AGENTS_INSTRUCTIONS_END = "</instructions>";
const INTERNAL_CONTEXT_PREFIX_PATTERN = /^<codex_internal_context\s+source=(?:"[a-z][a-z0-9_]*"|'[a-z][a-z0-9_]*')>[\s\S]*?<\/codex_internal_context>/;
const EXTERNAL_CONTEXT_PREFIX_PATTERN = /^<external_([a-z0-9_-]+)>[\s\S]*?<\/external_\1>/;
const PROMPT_REQUEST_BEGIN = "## My request for Codex:";
const REVIEW_PROMPT_PREFIX = "## Code review guidelines:";

// Attachments ride as input_image entries framed by "<image>"/"</image>" text
// entries, so an image-only item's joined text is exactly an empty tag pair.
// That incidentally matches the context shape, but it is NOT injected context:
// classifying it as such would drop image-only user messages (the image entries
// live in the same item the callers discard). Strip the placeholders before
// classifying, and never surface them as visible bubble text.
const IMAGE_PLACEHOLDER_PAIR = /<image>\s*<\/image>/gi;
const IMAGE_PLACEHOLDER_TOKEN = /^<\/?image>$/i;
const RUNTIME_IMAGE_OPENING_TAG = /<image\s+name=\[Image #\d+\]\s+path=(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s<>]+)\s*>/gi;

function stripImagePlaceholders(text) {
  let sawRuntimeImageOpeningTag = false;
  const withoutRuntimeOpeners = text.replace(RUNTIME_IMAGE_OPENING_TAG, () => {
    sawRuntimeImageOpeningTag = true;
    return "";
  });
  const withoutPairs = withoutRuntimeOpeners.replace(IMAGE_PLACEHOLDER_PAIR, "");
  if (sawRuntimeImageOpeningTag) {
    return withoutPairs.replace(/<\/image>/gi, "");
  }
  return IMAGE_PLACEHOLDER_TOKEN.test(withoutPairs.trim()) ? "" : withoutPairs;
}

function isReviewEnvelopeText(trimmed) {
  return trimmed.startsWith(REVIEW_PROMPT_PREFIX) && trimmed.includes(PROMPT_REQUEST_BEGIN);
}

function consumeLeadingContextFragment(text) {
  const lower = text.toLowerCase();

  for (const [start, end] of CONTEXT_MARKER_PAIRS) {
    if (!lower.startsWith(start)) {
      continue;
    }
    const closeIndex = lower.indexOf(end, start.length);
    return closeIndex === -1 ? null : text.slice(closeIndex + end.length);
  }

  const internal = INTERNAL_CONTEXT_PREFIX_PATTERN.exec(text);
  if (internal) {
    return text.slice(internal[0].length);
  }
  const external = EXTERNAL_CONTEXT_PREFIX_PATTERN.exec(text);
  if (external) {
    return text.slice(external[0].length);
  }

  if (lower.startsWith(AGENTS_INSTRUCTIONS_PREFIX.toLowerCase())) {
    return consumeAgentsInstructionsFragment(text, lower);
  }

  if (LEGACY_CONTEXT_WARNING_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return "";
  }
  return text.startsWith(LEGACY_APPLY_PATCH_WARNING_PREFIX)
    && text.endsWith(LEGACY_APPLY_PATCH_WARNING_SUFFIX)
    ? ""
    : null;
}

function consumeAgentsInstructionsFragment(text, lower) {
  const closeIndex = lower.indexOf(AGENTS_INSTRUCTIONS_END);
  if (closeIndex >= 0) {
    return consumeChainedInstructionsBlocks(text.slice(closeIndex + AGENTS_INSTRUCTIONS_END.length));
  }

  const nextMarkerIndex = CONTEXT_MARKER_PAIRS
    .map(([start]) => lower.indexOf(start, 1))
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0];
  return nextMarkerIndex === undefined ? null : text.slice(nextMarkerIndex);
}

function consumeChainedInstructionsBlocks(text) {
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith(AGENTS_INSTRUCTIONS_BEGIN)) {
      return rest;
    }
    const closeIndex = lower.indexOf(AGENTS_INSTRUCTIONS_END, AGENTS_INSTRUCTIONS_BEGIN.length);
    if (closeIndex === -1) {
      return rest;
    }
    rest = trimmed.slice(closeIndex + AGENTS_INSTRUCTIONS_END.length);
  }
}

function stripLeadingContextFragments(trimmed) {
  let rest = trimmed;
  while (rest) {
    const remainder = consumeLeadingContextFragment(rest);
    if (remainder === null) {
      break;
    }
    rest = remainder.trim();
  }
  return rest;
}

function isContextualUserText(text) {
  const raw = typeof text === "string" ? text : "";
  const trimmed = stripImagePlaceholders(raw).trim();
  if (!trimmed || isReviewEnvelopeText(trimmed)) {
    return false;
  }
  return stripLeadingContextFragments(trimmed) === "";
}

function decodeXmlText(text) {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (match, entity) => ({
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    amp: "&",
  })[entity] || match);
}

function extractNestedRuntimeText(text, outerTag, innerTag) {
  const outerPattern = new RegExp(`^<${outerTag}>[\\s\\S]*<\\/${outerTag}>$`, "i");
  if (!outerPattern.test(text.trim())) {
    return null;
  }
  const innerPattern = new RegExp(`<${innerTag}>([\\s\\S]*?)<\\/${innerTag}>`, "i");
  const match = innerPattern.exec(text);
  return match ? decodeXmlText(match[1]).trim() : null;
}

// Some runtime wrappers are visible triggers, not hidden context. Codex.app
// presents only their human-facing payload and keeps transport metadata private.
function extractVisibleRuntimeEnvelope(text) {
  const trimmed = text.trim();
  const envelopePairs = [
    ["heartbeat", "instructions"],
    ["codex_delegation", "input"],
    ["realtime_delegation", "input"],
    ["sidechat_boundary", "latest_user_message"],
  ];
  for (const [outerTag, innerTag] of envelopePairs) {
    const extracted = extractNestedRuntimeText(trimmed, outerTag, innerTag);
    if (extracted != null) {
      return extracted;
    }
  }

  const hookPrompt = /^<hook_prompt\s+hook_run_id=(?:"[^"]+"|'[^']+')>([\s\S]*?)<\/hook_prompt>$/i.exec(trimmed);
  return hookPrompt ? decodeXmlText(hookPrompt[1]).trim() : null;
}

// Mirrors Desktop's extract_prompt_request: IDE-context prompts embed the real
// request after the last "## My request for Codex:" delimiter.
function visibleUserPromptText(text) {
  if (typeof text !== "string" || !text) {
    return "";
  }
  const cleaned = stripImagePlaceholders(text);
  const trimmed = cleaned.trim();
  if (!trimmed) {
    return "";
  }
  const stripped = isReviewEnvelopeText(trimmed)
    ? trimmed
    : stripLeadingContextFragments(trimmed);
  if (!stripped) {
    return "";
  }
  const body = stripped === trimmed ? cleaned : stripped;
  const requestIndex = body.lastIndexOf(PROMPT_REQUEST_BEGIN);
  if (requestIndex >= 0) {
    const request = body.slice(requestIndex + PROMPT_REQUEST_BEGIN.length).trim();
    if (request) {
      return request;
    }
    const precedingBody = body.slice(0, requestIndex).trimEnd();
    return isContextualUserText(precedingBody) ? "" : precedingBody;
  }
  const envelopeText = extractVisibleRuntimeEnvelope(body);
  if (envelopeText != null) {
    return envelopeText;
  }
  return body;
}

// Sanitizes text fragments independently so a hidden fragment cannot cause a
// sibling prompt or image attachment in the same user item to be discarded.
function sanitizeUserInputEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const visible = visibleUserPromptText(entry);
      if (visible) {
        sanitized.push(visible);
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const textKey = ["text", "message", "content"].find((key) => typeof entry[key] === "string");
    if (!textKey) {
      sanitized.push(entry);
      continue;
    }
    const visible = visibleUserPromptText(entry[textKey]);
    if (!visible) {
      continue;
    }
    sanitized.push(visible === entry[textKey] ? entry : { ...entry, [textKey]: visible });
  }
  return sanitized;
}

function sanitizeUserRoleItem(item) {
  if (!isUserRoleItem(item)) {
    return item;
  }
  let sanitized = item;
  let changed = false;

  if (Array.isArray(item.content)) {
    const content = sanitizeUserInputEntries(item.content);
    changed = content.length !== item.content.length
      || content.some((entry, index) => entry !== item.content[index]);
    if (changed) {
      sanitized = { ...sanitized, content };
    }
  }

  for (const key of ["text", "message"]) {
    if (typeof sanitized[key] !== "string") {
      continue;
    }
    const visible = visibleUserPromptText(sanitized[key]);
    if (!visible && !Array.isArray(sanitized.content)) {
      return null;
    }
    if (visible !== sanitized[key]) {
      sanitized = { ...sanitized, [key]: visible };
      changed = true;
    }
  }

  const hasContent = Array.isArray(sanitized.content) && sanitized.content.length > 0;
  const hasDirectText = ["text", "message"].some((key) => (
    typeof sanitized[key] === "string" && sanitized[key].trim()
  ));
  if (Array.isArray(sanitized.content) && !hasContent && !hasDirectText) {
    return null;
  }

  return changed ? sanitized : item;
}

// Extracts the visible human prompt from turn-start input entries while dropping
// injected context fragments. Used by Desktop IPC and rollout mirrors.
function visibleUserPromptFromInputEntries(input) {
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map(readInputEntryText)
    .map((text) => visibleUserPromptText(text).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readInputEntryText(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.message === "string") {
    return entry.message;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  const content = Array.isArray(entry.content) ? entry.content : [];
  return content
    .map(readInputEntryText)
    .filter(Boolean)
    .join("\n");
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readText(value) {
  return typeof value === "string" ? value : "";
}

function hasVisiblePlanUpdate(explanation, plan) {
  return Boolean(readString(explanation)) || (Array.isArray(plan) && plan.length > 0);
}

function normalizeToken(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[_-\s]+/g, "")
    : "";
}

function isThreadTurnStateProbeRequest(message) {
  const params = message?.params;
  if (readString(message?.method) !== "thread/turns/list"
    || readString(params?.cursor)
    || params?.agntRequireCanonical === true) {
    return false;
  }
  if (params?.agntTurnStateOnly === true) {
    return true;
  }
  return Number(params?.limit) === 8
    && normalizeToken(readString(params?.sortDirection) || "desc") === "desc";
}

function cloneJSON(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function isPlainJSONObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Single predicate for "this timeline item is a user message", shared by the
// relay sanitizer, the JSONL history parser, and the Desktop-bound adapter so
// context filters can never drift apart across paths again.
function isUserRoleItem(item) {
  const type = normalizeToken(item?.type);
  if (type === "usermessage") {
    return true;
  }
  return type === "message" && normalizeToken(item?.role) === "user";
}

function readUserItemText(item) {
  const direct = readString(item?.text) || readString(item?.message);
  if (direct) {
    return direct;
  }
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// A stream snapshot that carries an actively running turn is evidence the
// sender's runtime is executing the conversation. Idle snapshots also arrive
// for threads a peer merely viewed or re-broadcast on reconnect, so they are
// weaker claims: strong enough to take over an idle thread, but never one the
// local app-server is still running.
function conversationSnapshotShowsActiveTurn(change) {
  const conversationState = change?.conversationState || change?.conversation_state;
  const turns = Array.isArray(conversationState?.turns) ? conversationState.turns : [];
  return turns.some((turn) => {
    const status = normalizeToken(turn?.status);
    return status === "inprogress" || status === "running" || status === "active";
  });
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requestIdKey(value) {
  if (typeof value === "string" && value) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function writeFrame(socket, payload, callback) {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]), callback);
}

function createFrameReader({ onFrame, onOverflow }) {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= FRAME_HEADER_BYTES) {
        const frameLength = buffer.readUInt32LE(0);
        if (frameLength > MAX_FRAME_BYTES) {
          buffer = Buffer.alloc(0);
          onOverflow?.();
          return;
        }
        if (buffer.length < FRAME_HEADER_BYTES + frameLength) {
          return;
        }

        const payload = buffer
          .slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength)
          .toString("utf8");
        buffer = buffer.slice(FRAME_HEADER_BYTES + frameLength);
        const envelope = safeParseJSON(payload);
        if (envelope) {
          onFrame(envelope);
        }
      }
    },
    reset() {
      buffer = Buffer.alloc(0);
    },
  };
}

function buildIpcRequestEnvelope({ requestId, method, params, clientId, initializing = false }) {
  return {
    type: "request",
    requestId,
    sourceClientId: initializing ? "initializing-client" : clientId || "agnt-bridge",
    version: DESKTOP_IPC_METHOD_VERSIONS.get(method) || 1,
    method,
    params: params || {},
  };
}

// Newer app-server builds omit every turn unless thread/read opts in explicitly.
// Callers that hydrate a Desktop-owned or bridge-owned thread's full baseline
// (rather than just watching for metadata changes) always need the complete
// history: publishing the metadata-only default as a Desktop snapshot would
// replace the visible transcript with an empty one.
function buildCompleteThreadReadParams(threadId) {
  return {
    threadId: readString(threadId),
    includeTurns: true,
  };
}

function resolveIpcSocketPathCandidates() {
  if (process.platform === "win32") {
    return ["\\\\.\\pipe\\codex-ipc"];
  }

  const configuredCodexHome = readString(process.env.CODEX_HOME);
  const codexHome = configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(os.homedir(), ".codex");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return [
    path.join(codexHome, "ipc", "ipc.sock"),
    path.join(os.tmpdir(), "codex-ipc", `ipc-${uid}.sock`),
  ];
}

function resolveDefaultIpcSocketPath() {
  const candidates = resolveIpcSocketPathCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isSocket()) {
        return candidate;
      }
    } catch {
      // Missing or unreadable candidate: keep looking.
    }
  }
  return candidates[0];
}

function toSocketPathResolver(socketPath) {
  return typeof socketPath === "function" ? socketPath : () => socketPath;
}

function toSocketPathCandidatesResolver(socketPath) {
  const resolveSocketPath = toSocketPathResolver(socketPath);
  return () => {
    const resolved = resolveSocketPath();
    const candidates = Array.isArray(resolved) ? resolved : [resolved];
    return candidates.filter((candidate, index) => (
      typeof candidate === "string"
      && candidate.length > 0
      && candidates.indexOf(candidate) === index
    ));
  };
}

module.exports = {
  CLIENT_STATUS_CHANGED,
  THREAD_STREAM_FOLLOWING_CHANGED,
  THREAD_STREAM_FOLLOWING_STATUS_REQUESTED,
  buildCompleteThreadReadParams,
  buildIpcRequestEnvelope,
  createFrameReader,
  DESKTOP_IPC_METHOD_VERSIONS,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  cloneJSON,
  conversationSnapshotShowsActiveTurn,
  hasVisiblePlanUpdate,
  isContextualUserText,
  isPlainJSONObject,
  isThreadTurnStateProbeRequest,
  isUserRoleItem,
  normalizeToken,
  readString,
  readText,
  readUserItemText,
  requestIdKey,
  resolveDefaultIpcSocketPath,
  resolveIpcSocketPathCandidates,
  safeParseJSON,
  sanitizeUserInputEntries,
  sanitizeUserRoleItem,
  toSocketPathCandidatesResolver,
  toSocketPathResolver,
  visibleUserPromptText,
  visibleUserPromptFromInputEntries,
  writeFrame,
};
