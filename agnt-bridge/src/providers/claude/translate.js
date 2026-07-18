// FILE: providers/claude/translate.js
// Purpose: Codex JSON-RPC <-> Claude Code stream-json protocol shim. Lets the
//          existing iOS app drive the `claude --output-format stream-json
//          --input-format stream-json --verbose` CLI without changes.
// Layer: provider plugin (claude)
// Exports: createClaudeTranslator
// Depends on: fs, path, os, ../_shared/translator-utils
//
// Design notes:
//   - The bridge speaks Codex JSON-RPC. The Claude CLI speaks stream-json:
//     stdin lines are `{type:"user", message:{...}}`. Stdout has multiple
//     frame types per turn:
//        system.init           — emitted at the start of each turn
//        system.status         — periodic phase signal ("requesting")
//        stream_event          — Anthropic SDK SSE-style events; this is the
//                                authoritative delta source when the CLI is
//                                run with --include-partial-messages
//        assistant             — consolidated message snapshot (used for
//                                tool_use blocks and as a fallback delta)
//        user                  — echoed user input + tool_result frames
//        result                — turn complete (cost, usage, final text)
//        rate_limit_event      — surfaced as a thread/status/changed event
//   - One translator instance per bridge connection. State lives in closure:
//       threadId  : the synthetic Codex-style id we hand to the iOS app
//       sessionId : Claude's actual session_id (assigned at first system.init).
//                   Published to transport.setResumeSessionId() so a respawn
//                   after turn/interrupt continues the same conversation.
//       activeTurnId / activeAssistantItemId / blocksByIndex / ...
//   - Claude does not pre-create sessions; the very first turn implicitly
//     creates one. We synthesize a `thread/start` response with a placeholder
//     threadId, then map that threadId to whatever session_id Claude reports
//     in the `system.init` line of the next turn.

const {
  buildTurnOverlapError,
  createFrameEmitter,
  createTurnLifecycleEmitter,
  generateThreadId,
  generateTurnId,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");
const { reconstructThreadFromJsonl } = require("../_shared/thread-jsonl-reconstructor");
const {
  buildClaudeUserMessageLine,
} = require("./turn-input");
const { createClaudeSessionStore } = require("./session-store");
const {
  handleContextWindowRead,
  handleGenerateTitle,
  publishTurnArgsForParams,
} = require("./turn-options");
const { createClaudeToolEmitter } = require("./tools");
const { createClaudeStreamHandlers } = require("./stream-handlers");

const PROTO_VERSION = "1.0.0-claude-shim";

function createClaudeTranslator({ injectInbound, transport, env = process.env } = {}) {
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);
  const turnLifecycle = createTurnLifecycleEmitter(emitNotification);
  const sessionStore = createClaudeSessionStore({ env });

  // ── per-connection state ───────────────────────────────────────────────
  /** Synthetic threadId surfaced to the iOS app. */
  let threadId = "";
  /** Claude's session_id reported in system.init. May arrive after threadId. */
  let sessionId = "";
  /** Cwd used for Claude's session (drives ~/.claude/projects/<encoded>/). */
  let sessionCwd = "";
  /** Active turnId synthesized by us (Claude has no turn-id concept). */
  let activeTurnId = "";
  /** Item id of the currently streaming assistant text message (one per turn). */
  let activeAssistantItemId = "";
  /** Accumulated assistant text in the current turn (used for the final agent_message). */
  let assistantTextAccumulator = "";
  /** Item id of the in-progress reasoning bubble in the current turn. */
  let reasoningItemId = "";
  /** Accumulated reasoning text (only for the final summary; deltas are emitted live). */
  let reasoningAccumulator = "";
  /** Fingerprint of the last assistant message we forwarded so duplicate replays don't double-emit. */
  let lastAssistantMessageId = "";
  /** Map of Claude tool_use_id → { name, command, cwd, kind } so we can close the loop on tool_result. */
  const pendingToolCalls = new Map();
  /**
   * Index of the in-progress streamed content block. Claude emits
   * content_block_start with `index` followed by content_block_delta /
   * content_block_stop sharing that index. We keep per-index state
   * (kind=text|thinking|tool_use, accumulated text, item id, tool input
   * fragments) so deltas route to the right bridge item.
   */
  const blocksByIndex = new Map();
  /** Once we see system.init, we emit thread/started. Track so we don't repeat per resume. */
  let didEmitThreadStarted = false;
  /** Track whether we have already emitted turn/started for the active turn. */
  let didEmitTurnStarted = false;
  /** Last Claude usage snapshot for token usage updates. */
  let lastUsage = null;
  const state = {
    get activeAssistantItemId() { return activeAssistantItemId; },
    set activeAssistantItemId(value) { activeAssistantItemId = value; },
    get activeTurnId() { return activeTurnId; },
    set activeTurnId(value) { activeTurnId = value; },
    get assistantTextAccumulator() { return assistantTextAccumulator; },
    set assistantTextAccumulator(value) { assistantTextAccumulator = value; },
    blocksByIndex,
    get didEmitThreadStarted() { return didEmitThreadStarted; },
    set didEmitThreadStarted(value) { didEmitThreadStarted = value; },
    get didEmitTurnStarted() { return didEmitTurnStarted; },
    set didEmitTurnStarted(value) { didEmitTurnStarted = value; },
    get lastAssistantMessageId() { return lastAssistantMessageId; },
    set lastAssistantMessageId(value) { lastAssistantMessageId = value; },
    get lastUsage() { return lastUsage; },
    set lastUsage(value) { lastUsage = value; },
    get reasoningAccumulator() { return reasoningAccumulator; },
    set reasoningAccumulator(value) { reasoningAccumulator = value; },
    get reasoningItemId() { return reasoningItemId; },
    set reasoningItemId(value) { reasoningItemId = value; },
    get sessionCwd() { return sessionCwd; },
    set sessionCwd(value) { sessionCwd = value; },
    get sessionId() { return sessionId; },
    set sessionId(value) { sessionId = value; },
    get threadId() { return threadId; },
    set threadId(value) { threadId = value; },
  };
  const toolEmitter = createClaudeToolEmitter({
    emitNotification,
    getActiveTurnId: () => activeTurnId,
    getSessionCwd: () => sessionCwd,
    getThreadId: () => threadId,
    pendingToolCalls,
  });
  const streamHandlers = createClaudeStreamHandlers({
    emitErrorNotification,
    emitNotification,
    emitTurnCompleted,
    emitTurnStarted,
    resetTurnState,
    state,
    toolEmitter,
    transport,
  });

  return {
    outbound,
    inbound,
    handleStarted() {},
    handleClose() {
      // Surface a synthetic turn/failed if a turn is mid-flight when the CLI
      // exits — otherwise the iOS app's spinner stays forever.
      if (activeTurnId && threadId) {
        turnLifecycle.emitTurnFailed(threadId, activeTurnId, "claude transport closed before turn completed");
        turnLifecycle.emitTurnCompleted(threadId, activeTurnId);
      }
      resetTurnState();
    },
  };

  // ── outbound (bridge → claude stream-json) ─────────────────────────────
  function outbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const method = readString(parsed.method);
    const id = parsed.id;

    // Bridge-managed initialize handshake — answer locally and never touch claude.
    if (method === "initialize" || method === "client/initialize") {
      if (id != null) {
        injectResponse(id, {
          protocolVersion: PROTO_VERSION,
          serverInfo: { name: "claude-shim", version: PROTO_VERSION },
          capabilities: {},
        });
      }
      return null;
    }

    if (method === "thread/start") {
      handleThreadStart(parsed);
      return null;
    }

    if (method === "turn/start") {
      return handleTurnStart(parsed);
    }

    if (method === "turn/interrupt") {
      handleTurnInterrupt(parsed);
      return null;
    }

    if (method === "turn/steer") {
      // Claude has no equivalent of mid-turn steering; reject explicitly so the
      // iOS app's fallback path takes over instead of hanging.
      respondError(id, -32601, "claude provider does not support turn/steer");
      return null;
    }

    if (method === "thread/read" || method === "thread/resume") {
      handleThreadRead(parsed);
      return null;
    }

    if (method === "thread/turns/list") {
      handleThreadTurnsList(parsed);
      return null;
    }

    if (method === "thread/list") {
      handleThreadList(parsed);
      return null;
    }

    if (method === "thread/contextWindow/read") {
      handleContextWindowRead({ lastUsage, request: parsed, threadId, injectResponse });
      return null;
    }

    if (method === "thread/generateTitle") {
      handleGenerateTitle({ injectResponse, request: parsed, threadId });
      return null;
    }

    if (method === "thread/name/set") {
      if (id != null) injectResponse(id, { ok: true });
      return null;
    }

    if (method === "thread/compact/start" || method === "thread/compact") {
      // Claude's `/compact` slash command is interactive-only — the
      // stream-json CLI ignores it. Acknowledge with `compacted:false` so
      // the iOS app's compact pill can render a "not supported" hint
      // without hanging.
      if (id != null) {
        injectResponse(id, {
          ok: true,
          compacted: false,
          reason: "claude_cli_compact_unsupported",
        });
      }
      return null;
    }

    // Default: treat unknown bridge requests as no-ops (do not forward to
    // claude — claude's stream-json protocol doesn't accept JSON-RPC).
    if (id != null) {
      respondError(id, -32601, `claude provider does not support method: ${method}`);
    }
    return null;
  }

  // ── inbound (claude stream-json → bridge JSON-RPC) ─────────────────────
  function inbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const type = readString(parsed.type);
    if (!type) return null;

    if (type === "system") {
      return streamHandlers.handleSystem(parsed);
    }
    if (type === "stream_event") {
      return streamHandlers.handleStreamEvent(parsed);
    }
    if (type === "assistant") {
      return streamHandlers.handleAssistant(parsed);
    }
    if (type === "user") {
      return streamHandlers.handleUser(parsed);
    }
    if (type === "result") {
      return streamHandlers.handleResult(parsed);
    }
    if (type === "rate_limit_event") {
      return streamHandlers.handleRateLimitEvent(parsed);
    }
    return null;
  }

  // ── outbound handlers ──────────────────────────────────────────────────
  function handleThreadStart(request) {
    const params = request?.params || {};
    const requestedCwd = readString(params.cwd) || readString(params.workingDirectory) || "";
    if (requestedCwd) {
      sessionCwd = requestedCwd;
      try { transport?.setCwd?.(requestedCwd); } catch { /* best-effort */ }
    }

    if (!threadId) {
      threadId = generateThreadId();
    }
    if (!sessionCwd) {
      sessionCwd = process.cwd();
    }

    if (request?.id != null) {
      injectResponse(request.id, {
        thread: {
          id: threadId,
          threadId,
          thread_id: threadId,
          cwd: sessionCwd,
          status: "idle",
          turns: [],
        },
      });
    }

    if (!didEmitThreadStarted) {
      didEmitThreadStarted = true;
      emitNotification("thread/started", {
        threadId,
        thread_id: threadId,
        thread: {
          id: threadId,
          threadId,
          thread_id: threadId,
          cwd: sessionCwd,
        },
      });
    }
  }

  // turn/start: send a `{type:"user", ...}` line to claude, ack the JSON-RPC
  // request immediately, and emit `turn/started` so the iOS app's spinner
  // shows up before the assistant deltas arrive.
  function handleTurnStart(request) {
    const params = request?.params || {};

    // Reject overlapping turns rather than letting state collide. iOS UI
    // generally disables Send while a turn runs; this is a backstop for
    // pathological clients (and a clean error if it ever fires).
    if (activeTurnId) {
      const err = buildTurnOverlapError();
      respondError(request?.id, err.code, err.message);
      return null;
    }

    const incomingThreadId = readString(params.threadId) || readString(params.thread_id);
    if (incomingThreadId) {
      threadId = incomingThreadId;
    }
    if (!threadId) {
      threadId = generateThreadId();
    }

    // Translate per-turn JSON-RPC params into Claude CLI flags. Applying via
    // setTurnArgs respawns the CLI when flags change (with --resume so the
    // conversation continues). Most users only set these once at thread start.
    publishTurnArgsForParams(params, transport);

    const turnId = generateTurnId();
    activeTurnId = turnId;
    activeAssistantItemId = "";
    assistantTextAccumulator = "";
    reasoningItemId = "";
    reasoningAccumulator = "";
    didEmitTurnStarted = false;
    pendingToolCalls.clear();

    if (request?.id != null) {
      injectResponse(request.id, {
        turnId,
        turn_id: turnId,
        id: turnId,
        threadId,
        thread_id: threadId,
      });
    }

    emitTurnStarted(turnId);

    const claudeUserLine = buildClaudeUserMessageLine(params);
    if (!claudeUserLine) {
      // Nothing to send — finish the turn locally so the UI does not hang.
      emitErrorNotification(turnId, "turn/start had no usable text or attachments");
      emitTurnCompleted(turnId);
      return null;
    }

    return [claudeUserLine];
  }

  function handleTurnInterrupt(request) {
    if (request?.id != null) {
      injectResponse(request.id, { ok: true });
    }
    // Soft-kill the running turn at the transport level. The transport drops
    // its child reference; the next send() respawns with --resume so the
    // conversation continues.
    try { transport?.interruptTurn?.(); } catch { /* best-effort */ }
    if (!activeTurnId || !threadId) return;
    emitErrorNotification(activeTurnId, "interrupted by user");
    emitTurnCompleted(activeTurnId);
    resetTurnState();
  }

  function handleThreadRead(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || threadId;

    if (!targetThreadId) {
      respondError(request?.id, -32602, "thread/read requires a threadId");
      return;
    }

    if (!threadId) threadId = targetThreadId;

    const reconstructed = reconstructThreadFromJsonl({
      targetThreadId,
      sessionFile: sessionStore.locateSessionFile(targetThreadId),
      fallbackCwd: sessionCwd,
    });
    if (request?.id != null) {
      injectResponse(request.id, {
        thread: reconstructed || {
          id: targetThreadId,
          threadId: targetThreadId,
          thread_id: targetThreadId,
          cwd: sessionCwd || process.cwd(),
          status: "idle",
          turns: [],
        },
      });
    }
  }

  function handleThreadTurnsList(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || threadId;
    const reconstructed = reconstructThreadFromJsonl({
      targetThreadId,
      sessionFile: sessionStore.locateSessionFile(targetThreadId),
      fallbackCwd: sessionCwd,
    });
    const turns = reconstructed?.turns || [];

    if (request?.id != null) {
      injectResponse(request.id, {
        threadId: targetThreadId,
        thread_id: targetThreadId,
        turns,
        nextCursor: null,
        hasMore: false,
        page: { turns, nextCursor: null, hasMore: false },
      });
    }
  }

  function handleThreadList(request) {
    if (request?.id == null) return;
    const summaries = sessionStore.listThreadSummaries();
    injectResponse(request.id, {
      data: summaries,
      threads: summaries,
      nextCursor: null,
      hasMore: false,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function emitTurnStarted(turnId) {
    didEmitTurnStarted = true;
    turnLifecycle.emitTurnStarted(threadId, turnId);
  }

  function emitTurnCompleted(turnId) {
    turnLifecycle.emitTurnCompleted(threadId, turnId);
  }

  function emitErrorNotification(turnId, errorMessage) {
    turnLifecycle.emitTurnFailed(threadId, turnId, errorMessage);
  }

  function resetTurnState() {
    activeTurnId = "";
    activeAssistantItemId = "";
    assistantTextAccumulator = "";
    reasoningItemId = "";
    reasoningAccumulator = "";
    didEmitTurnStarted = false;
    pendingToolCalls.clear();
    blocksByIndex.clear();
  }

}

module.exports = {
  createClaudeTranslator,
};
