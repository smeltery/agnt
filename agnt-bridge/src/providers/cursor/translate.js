// FILE: providers/cursor/translate.js
// Purpose: Codex JSON-RPC <-> Cursor stream-json protocol shim. Lets the iOS
//          app drive `cursor-agent --output-format stream-json` without
//          changes — synthesizes thread/turn ids, maps tool_call frames into
//          exec_command_* notifications, and resumes sessions across turns.
// Layer: provider plugin (cursor)
// Exports: createCursorTranslator
// Depends on: fs, path, os, ../_shared/translator-utils
//
// Wire mapping (high level):
//   bridge JSON-RPC outbound       cursor action
//   ─────────────────────────────  ──────────────────────────────────────
//   thread/start                   synthesize threadId; cache cwd
//   turn/start                     emit `{type:"prompt", text}` to transport
//                                  — the cursor transport spawns a fresh
//                                  `cursor-agent -p <text> ...` per turn
//   turn/interrupt                 transport.interruptTurn() (SIGINT)
//   thread/read / turns/list       reconstruct from `~/.cursor/chats/*.jsonl`
//   thread/list                    summaries from `~/.cursor/chats/`
//   thread/compact / generateTitle synthetic responses (cursor has no API)
//
//   cursor stream-json inbound     bridge JSON-RPC notifications
//   ─────────────────────────────  ──────────────────────────────────────
//   system.init                    thread/started + thread/initialized
//   user                           (echoed input — ignored)
//   assistant (text content)       item/agentMessage/delta + accumulator
//   tool_call.started              codex/event/exec_command_begin OR
//                                  item/started (read/write/edit/grep/...)
//   tool_call.completed            codex/event/exec_command_end OR
//                                  item/completed
//   result                         codex/event/agent_message + turn/completed
//
// State model:
//   - One translator instance per bridge connection. State lives in closure.
//   - Cursor reports `session_id` on every frame; we mirror it via
//     transport.setResumeSessionId so the next spawn's `--resume` keeps
//     conversation continuity (each turn is a fresh CLI invocation).
//   - `tool_call` frames carry a discriminated `tool_call.<kind>ToolCall`
//     payload — readToolCall, writeToolCall, editToolCall, shellToolCall,
//     grepToolCall, globToolCall, lsToolCall, function. We branch on kind to
//     decide whether to emit Codex exec_command_* events (shell) or the
//     item/* family (file ops + everything else).

const {
  buildTurnOverlapError,
  createFrameEmitter,
  createTurnLifecycleEmitter,
  deriveTitleFromSeed,
  generateThreadId,
  generateTurnId,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");
const { reconstructThreadFromJsonl } = require("../_shared/thread-jsonl-reconstructor");
const { createCursorSessionStore } = require("./session-store");
const { createCursorStreamHandlers } = require("./stream-handlers");

const PROTO_VERSION = "1.0.0-cursor-shim";

function createCursorTranslator({ injectInbound, transport, env = process.env } = {}) {
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);
  const turnLifecycle = createTurnLifecycleEmitter(emitNotification);

  // ── per-connection state ───────────────────────────────────────────────
  /** Synthetic threadId surfaced to the iOS app. */
  let threadId = "";
  /** Cursor's session_id (assigned at first system.init). */
  let sessionId = "";
  /** Cwd used for cursor's session. */
  let sessionCwd = "";
  /** Active turnId synthesized by us (cursor has no turn-id concept). */
  let activeTurnId = "";
  /** Item id of the currently streaming assistant text message (one per turn). */
  let activeAssistantItemId = "";
  /** Accumulated assistant text in the current turn. */
  let assistantTextAccumulator = "";
  /** Map of cursor tool call_id → { kind, displayName, command, cwd, filePath }. */
  const pendingToolCalls = new Map();
  /** Once we see system.init, we emit thread/started. Track so we don't repeat. */
  let didEmitThreadStarted = false;
  /** Track whether we have already emitted turn/started for the active turn. */
  let didEmitTurnStarted = false;
  const state = {
    get threadId() { return threadId; },
    set threadId(value) { threadId = value; },
    get sessionId() { return sessionId; },
    set sessionId(value) { sessionId = value; },
    get sessionCwd() { return sessionCwd; },
    set sessionCwd(value) { sessionCwd = value; },
    get activeTurnId() { return activeTurnId; },
    set activeTurnId(value) { activeTurnId = value; },
    get activeAssistantItemId() { return activeAssistantItemId; },
    set activeAssistantItemId(value) { activeAssistantItemId = value; },
    get assistantTextAccumulator() { return assistantTextAccumulator; },
    set assistantTextAccumulator(value) { assistantTextAccumulator = value; },
    get didEmitThreadStarted() { return didEmitThreadStarted; },
    set didEmitThreadStarted(value) { didEmitThreadStarted = value; },
    get didEmitTurnStarted() { return didEmitTurnStarted; },
    set didEmitTurnStarted(value) { didEmitTurnStarted = value; },
    pendingToolCalls,
  };
  const sessionStore = createCursorSessionStore({ env });
  const streamHandlers = createCursorStreamHandlers({
    emitNotification,
    emitTurnCompleted,
    emitTurnStarted,
    emitErrorNotification,
    resetTurnState,
    state,
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
        turnLifecycle.emitTurnFailed(threadId, activeTurnId, "cursor transport closed before turn completed");
        turnLifecycle.emitTurnCompleted(threadId, activeTurnId);
      }
      resetTurnState();
    },
  };

  // ── outbound (bridge → cursor CLI args) ────────────────────────────────
  function outbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") return null;

    const method = readString(parsed.method);
    const id = parsed.id;

    if (method === "initialize" || method === "client/initialize") {
      if (id != null) {
        injectResponse(id, {
          protocolVersion: PROTO_VERSION,
          serverInfo: { name: "cursor-shim", version: PROTO_VERSION },
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
      respondError(id, -32601, "cursor provider does not support turn/steer");
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
      // cursor-agent does not surface a context-window endpoint. Return an
      // empty snapshot so the iOS status row keeps rendering.
      if (id != null) {
        injectResponse(id, { threadId: threadId || "", contextWindow: null });
      }
      return null;
    }

    if (method === "thread/generateTitle") {
      handleGenerateTitle(parsed);
      return null;
    }

    if (method === "thread/name/set") {
      if (id != null) injectResponse(id, { ok: true });
      return null;
    }

    if (method === "thread/compact/start" || method === "thread/compact") {
      // cursor-agent has no equivalent of `/compact`. Acknowledge with
      // compacted:false so the iOS pill renders a "not supported" hint.
      if (id != null) {
        injectResponse(id, {
          ok: true,
          compacted: false,
          reason: "cursor_cli_compact_unsupported",
        });
      }
      return null;
    }

    // Default: reject unknown bridge requests cleanly.
    if (id != null) {
      respondError(id, -32601, `cursor provider does not support method: ${method}`);
    }
    return null;
  }

  // ── inbound (cursor stream-json → bridge JSON-RPC) ─────────────────────
  function inbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") return null;

    const type = readString(parsed.type);
    if (!type) return null;

    // Mirror session_id as soon as cursor reveals it so the next spawn can
    // --resume cleanly. This appears on system, assistant, tool_call, and
    // result frames.
    const lineSessionId = readString(parsed.session_id);
    if (lineSessionId && lineSessionId !== sessionId) {
      sessionId = lineSessionId;
      try { transport?.setResumeSessionId?.(sessionId); } catch { /* best-effort */ }
    }

    if (type === "system") return streamHandlers.handleSystem(parsed);
    if (type === "assistant") return streamHandlers.handleAssistant(parsed);
    if (type === "tool_call") return streamHandlers.handleToolCall(parsed);
    if (type === "result") return streamHandlers.handleResult(parsed);
    if (type === "user") return null; // echo of our own prompt
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

    if (!threadId) threadId = generateThreadId();
    if (!sessionCwd) sessionCwd = process.cwd();

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

  function handleTurnStart(request) {
    const params = request?.params || {};

    // Reject overlapping turns rather than letting state collide.
    if (activeTurnId) {
      const err = buildTurnOverlapError();
      respondError(request?.id, err.code, err.message);
      return null;
    }

    const incomingThreadId = readString(params.threadId) || readString(params.thread_id);
    if (incomingThreadId) threadId = incomingThreadId;
    if (!threadId) threadId = generateThreadId();

    publishTurnArgsForParams(params);

    const turnId = generateTurnId();
    activeTurnId = turnId;
    activeAssistantItemId = "";
    assistantTextAccumulator = "";
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

    const promptText = extractPromptText(params);
    if (!promptText) {
      emitErrorNotification(turnId, "turn/start had no usable text input");
      emitTurnCompleted(turnId);
      resetTurnState();
      return null;
    }

    return [JSON.stringify({ type: "prompt", text: promptText })];
  }

  function handleTurnInterrupt(request) {
    if (request?.id != null) injectResponse(request.id, { ok: true });
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

  function handleGenerateTitle(request) {
    if (request?.id == null) return;
    const params = request?.params || {};
    const seed = readString(params.seed)
      || readString(params.firstMessage)
      || readString(params.message)
      || "";
    const title = deriveTitleFromSeed(seed);
    injectResponse(request.id, {
      threadId: readString(params.threadId) || threadId,
      title,
      name: title,
    });
  }

  // ── inbound handlers ───────────────────────────────────────────────────
  // ── per-turn CLI flag publishing ───────────────────────────────────────
  function publishTurnArgsForParams(params) {
    const args = [];
    const model = readString(params?.model)
      || readString(params?.modelId)
      || readString(params?.modelID);
    if (model) args.push("--model", model);
    try { transport?.setTurnArgs?.(args); } catch { /* best-effort */ }
  }

  function extractPromptText(params) {
    const items = Array.isArray(params?.input) ? params.input : [];
    let text = "";
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (readString(item.type) !== "text") continue;
      const fragment = readString(item.text);
      if (!fragment) continue;
      text += text ? `\n${fragment}` : fragment;
    }
    return text;
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
    didEmitTurnStarted = false;
    pendingToolCalls.clear();
  }

}

module.exports = {
  createCursorTranslator,
};
