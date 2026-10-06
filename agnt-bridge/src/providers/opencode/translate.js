// FILE: providers/opencode/translate.js
// Purpose: Codex JSON-RPC <-> opencode REST/SSE protocol shim. Lets the iOS
//          app drive a local `opencode serve` instance through the same
//          turn lifecycle it uses for Codex.
// Layer: provider plugin (opencode)
// Exports: createOpencodeTranslator
// Depends on: ../_shared/translator-utils
//
// Wire mapping (high level):
//   bridge JSON-RPC outbound       opencode action
//   ─────────────────────────────  ──────────────────────────────────────
//   thread/start                   POST /session                  -> threadId = session.id
//   thread/read                    GET  /session/{id}/message
//   thread/turns/list              GET  /session/{id}/message
//   thread/list                    GET  /session
//   turn/start                     POST /session/{id}/message     -> fire-and-forget
//   turn/interrupt                 POST /session/{id}/abort
//
//   opencode SSE inbound           bridge JSON-RPC notifications
//   ─────────────────────────────  ──────────────────────────────────────
//   server.connected               (ignored)
//   message.updated (assistant)    item/started + item id mapping
//   message.part.updated (text)    item/agentMessage/delta
//   message.part.updated (reason)  item/reasoning/textDelta
//   message.part.updated (tool)    codex/event/exec_command_* family
//   session.status busy            turn/started
//   session.status idle            turn/completed (and item/completed)
//   session.status retry/error     turn/failed (then turn/completed)
//   session.diff                   turn/diff/updated
//   server.heartbeat               (ignored)
//
// Threading model:
//   opencode has no native "turn" concept — a session simply alternates user
//   and assistant messages and reports busy/idle. We synthesize a turnId per
//   user-initiated `turn/start` and fire `turn/completed` on the next idle
//   transition.

const {
  buildTurnOverlapError,
  createFrameEmitter,
  createTurnLifecycleEmitter,
  generateTurnId,
  numberOr,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");

const { createOpencodeApprovalFlow } = require("./approval-flow");
const { createOpencodeMessageBodyBuilder } = require("./message-body");
const { createOpencodeStreamHandlers } = require("./stream-handlers");
const { createOpencodeThreadHandlers } = require("./thread-handlers");

const { createOpencodeSessionClient } = require("./session-client");
const { normalizeModelCatalog } = require("./model-catalog");

const { createOpencodeStreamRecovery } = require("./stream-recovery");

const PROTO_VERSION = "1.0.0-opencode-shim";

function createOpencodeTranslator({ injectInbound, transport, env: _env = process.env } = {}) {
  transport = createOpencodeSessionClient(transport);
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);
  const turnLifecycle = createTurnLifecycleEmitter(emitNotification);

  // ── per-connection state ───────────────────────────────────────────────
  /** Map of threadId → opencode session id. The bridge uses sessionId == threadId. */
  let activeThreadId = "";
  /** Outstanding turnId synthesized by us (one in flight at a time per session). */
  let activeTurnId = "";
  /** Provider/model snapshot supplied by the iOS turn/start params. */
  let lastProviderId = "";
  let lastModelId = "";
  /** Track the assistant message id we are currently streaming. */
  let activeAssistantMessageId = "";
  /** Latest token usage snapshot from message.updated events. */
  let lastTokenSnapshot = null;
  /**
   * Map: bridge-generated approval JSON-RPC request id → opencode permissionID.
   * The shim emits an item/commandExecution/requestApproval request to iOS
   * with that id; when iOS replies, we look up the permissionID and POST to
   * /session/{id}/permissions/{permissionID}.
   */
  const approvalIdToPermission = new Map();
  /** Map opencode message-part id → bridge item id so deltas route to the same row. */
  const partItemIds = new Map();
  /** Map opencode tool-part id → { toolName, command, cwd } so completion routes correctly. */
  const toolCallById = new Map();
  /** Once the active turn is finalized, suppress further turn/completed emissions. */
  let didEmitTurnCompletedForActive = false;
  const state = {
    get activeThreadId() { return activeThreadId; },
    set activeThreadId(value) { activeThreadId = value; },
    get activeTurnId() { return activeTurnId; },
    set activeTurnId(value) { activeTurnId = value; },
    get lastProviderId() { return lastProviderId; },
    set lastProviderId(value) { lastProviderId = value; },
    get lastModelId() { return lastModelId; },
    set lastModelId(value) { lastModelId = value; },
    get activeAssistantMessageId() { return activeAssistantMessageId; },
    set activeAssistantMessageId(value) { activeAssistantMessageId = value; },
    get lastTokenSnapshot() { return lastTokenSnapshot; },
    set lastTokenSnapshot(value) { lastTokenSnapshot = value; },
    get didEmitTurnCompletedForActive() { return didEmitTurnCompletedForActive; },
    set didEmitTurnCompletedForActive(value) { didEmitTurnCompletedForActive = value; },
    partItemIds,
    sessionSettings: transport.settings,
    activeUserMessageId: "",
    activeTurnAccepted: false,
  };
  const threadHandlers = createOpencodeThreadHandlers({
    emitNotification,
    injectResponse,
    respondError,
    state,
    transport,
  });
  const streamHandlers = createOpencodeStreamHandlers({
    emitNotification,
    state,
    toolCallById,
    turnLifecycle,
  });
  const recovery = createOpencodeStreamRecovery({ state, transport, streamHandlers });
  const approvalFlow = createOpencodeApprovalFlow({
    approvalIdToPermission,
    getActiveThreadId: () => activeThreadId,
    getActiveTurnId: () => activeTurnId,
    injectInbound,
    transport,
  });
  const { buildOpencodeMessageBody } = createOpencodeMessageBodyBuilder(state);

  return {
    outbound,
    inbound,
    handleStarted() {},
    handleClose() {
      recovery.stop();
      if (activeTurnId && activeThreadId && !didEmitTurnCompletedForActive) {
        turnLifecycle.emitTurnFailed(activeThreadId, activeTurnId, "opencode transport closed before turn completed");
        turnLifecycle.emitTurnCompleted(activeThreadId, activeTurnId);
      }
      streamHandlers.resetTurnState();
      approvalIdToPermission.clear();
    },
  };

  // ── outbound (bridge → opencode REST) ──────────────────────────────────
  function outbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") return null;
    const method = readString(parsed.method);
    const id = parsed.id;

    // iOS approval reply (no method, has id + result/error). Route to opencode
    // /session/{id}/permissions/{permissionID} based on the tracked mapping.
    if (!method && id != null && (parsed.result !== undefined || parsed.error !== undefined)) {
      approvalFlow.handleApprovalReply(parsed);
      return null;
    }

    if (method === "initialize" || method === "client/initialize") {
      if (id != null) {
        injectResponse(id, {
          protocolVersion: PROTO_VERSION,
          serverInfo: { name: "opencode-shim", version: PROTO_VERSION },
          capabilities: {},
        });
      }
      return null;
    }

    if (method === "thread/start") {
      threadHandlers.handleThreadStart(parsed);
      return null;
    }

    if (method === "turn/start") {
      handleTurnStart(parsed);
      return null;
    }

    if (method === "turn/interrupt") {
      handleTurnInterrupt(parsed);
      return null;
    }

    if (method === "turn/steer") {
      respondError(id, -32601, "opencode provider does not support turn/steer");
      return null;
    }

    if (method === "thread/read" || method === "thread/resume") {
      threadHandlers.handleThreadRead(parsed);
      return null;
    }

    if (method === "thread/turns/list") {
      threadHandlers.handleThreadTurnsList(parsed);
      return null;
    }

    if (method === "thread/list") {
      threadHandlers.handleThreadList(parsed);
      return null;
    }

    if (method === "thread/contextWindow/read") {
      threadHandlers.handleContextWindowRead(parsed);
      return null;
    }

    if (method === "thread/compact/start" || method === "thread/compact") {
      threadHandlers.handleThreadCompact(parsed);
      return null;
    }

    if (method === "thread/fork") {
      threadHandlers.handleThreadFork(parsed);
      return null;
    }

    if (method === "model/list") {
      transport.httpRequest("GET", "/provider")
        .then((response) => injectResponse(id, { data: normalizeModelCatalog(response.json), nextCursor: null }))
        .catch((error) => respondError(id, -32603, error.message));
      return null;
    }

    if (["thread/generateTitle", "thread/name/set", "thread/archive", "thread/unarchive"].includes(method)) {
      threadHandlers.handleThreadUpdate(parsed);
      return null;
    }

    if (id != null) {
      respondError(id, -32601, `opencode provider does not support method: ${method}`);
    }
    return null;
  }

  function handleTurnStart(request) {
    const params = request?.params || {};

    // Reject overlapping turns. Same backstop as the Claude shim.
    if (activeTurnId) {
      const err = buildTurnOverlapError();
      respondError(request?.id, err.code, err.message);
      return;
    }

    const incomingThreadId = readString(params.threadId) || readString(params.thread_id);
    if (incomingThreadId) activeThreadId = incomingThreadId;
    if (!activeThreadId) {
      respondError(request?.id, -32602, "opencode turn/start requires a thread; call thread/start first");
      return;
    }

    recovery.invalidate();
    const turnId = generateTurnId();
    activeTurnId = turnId;
    activeAssistantMessageId = "";
    lastTokenSnapshot = null;
    partItemIds.clear();
    toolCallById.clear();
    didEmitTurnCompletedForActive = false;

    if (request?.id != null) {
      injectResponse(request.id, {
        turnId,
        turn_id: turnId,
        id: turnId,
        threadId: activeThreadId,
        thread_id: activeThreadId,
      });
    }

    turnLifecycle.emitTurnStarted(activeThreadId, turnId);

    const body = buildOpencodeMessageBody(params);
    state.activeUserMessageId = `msg_${turnId.slice(5)}`;
    state.activeTurnAccepted = false;
    if (body) body.messageID = state.activeUserMessageId;
    if (!body) {
      turnLifecycle.emitTurnFailed(activeThreadId, turnId, "turn/start had no usable text or attachments");
      turnLifecycle.emitTurnCompleted(activeThreadId, turnId);
      streamHandlers.resetTurnState();
      return;
    }

    // The async prompt endpoint acknowledges acceptance; live output arrives over SSE.
    const threadId = activeThreadId;
    transport.httpRequest("POST", `/session/${encodeURIComponent(threadId)}/prompt_async`, body)
      .then(() => {
        if (activeThreadId === threadId && activeTurnId === turnId) state.activeTurnAccepted = true;
      })
      .catch((err) => {
        if (activeThreadId !== threadId || activeTurnId !== turnId) return;
        turnLifecycle.emitTurnFailed(threadId, turnId, `opencode message failed: ${err?.message || err}`);
        turnLifecycle.emitTurnCompleted(threadId, turnId);
        streamHandlers.resetTurnState();
      });
  }

  function handleTurnInterrupt(request) {
    recovery.invalidate();
    const target = readString(request?.params?.threadId) || activeThreadId;
    if (target !== activeThreadId) {
      respondError(request?.id, -32602, "Cannot interrupt a different thread");
      return;
    }
    if (request?.id != null) injectResponse(request.id, { ok: true });
    if (!activeThreadId || !activeTurnId) return;
    transport.httpRequest("POST", `/session/${encodeURIComponent(activeThreadId)}/abort`, {})
      .catch(() => { /* best-effort */ });
    turnLifecycle.emitTurnFailed(activeThreadId, activeTurnId, "interrupted by user");
    turnLifecycle.emitTurnCompleted(activeThreadId, activeTurnId);
    didEmitTurnCompletedForActive = true;
    streamHandlers.resetTurnState();
  }


  // ── inbound (opencode SSE data line → bridge JSON-RPC) ─────────────────
  function inbound(line) {
    const envelope = safeParseJson(line);
    const parsed = envelope?.payload || envelope;
    if (!parsed || typeof parsed !== "object") return null;
    const type = readString(parsed.type);
    if (!type) return null;
    if (type === "server.connected") { void recovery.refresh(); return null; }
    const props = parsed.properties && typeof parsed.properties === "object"
      ? parsed.properties
      : {};
    const sessionId = readString(props.sessionID) || readString(props.session_id)
      || readString(props.info?.sessionID) || readString(props.part?.sessionID);
    if (type === "session.updated" && props.info?.id) transport.remember(props.info);

    if (sessionId && activeThreadId && sessionId !== activeThreadId) {
      // Event is for a session we did not start through this bridge connection.
      // Ignore so we do not crosstalk between iOS app sessions.
      return null;
    }

    if (sessionId === activeThreadId) recovery.invalidate();

    if (type === "session.status") {
      streamHandlers.handleSessionStatus(props);
      return null;
    }
    if (type === "message.updated") {
      streamHandlers.handleMessageUpdated(props);
      return null;
    }
    if (type === "message.part.delta") {
      streamHandlers.handleMessagePartDelta(props);
      return null;
    }
    if (type === "message.part.updated") {
      streamHandlers.handleMessagePartUpdated(props);
      return null;
    }
    if (type === "session.updated") {
      streamHandlers.handleSessionUpdated(props);
      return null;
    }
    if (type === "session.diff") {
      streamHandlers.handleSessionDiff(props);
      return null;
    }
    if (type === "session.error") {
      streamHandlers.handleSessionError(props);
      return null;
    }
    if (type === "permission.asked" || type === "permission.updated") {
      approvalFlow.handlePermissionAsked(parsed);
      return null;
    }
    if (type === "question.asked" || type === "question.updated") {
      approvalFlow.handleQuestionAsked(parsed);
      return null;
    }
    if (["permission.replied", "question.replied", "question.rejected"].includes(type)) {
      approvalFlow.handleResolved(parsed);
      return null;
    }
    if (type === "tui.toast.show") {
      handleToastShow(parsed);
      return null;
    }
    return null;
  }

  function handleToastShow(envelope) {
    const props = envelope?.properties || {};
    const title = readString(props.title);
    const message = readString(props.message);
    const variant = readString(props.variant) || "info";
    if (!title && !message) return;
    emitNotification("system/notice", {
      threadId: activeThreadId,
      provider: "opencode",
      severity: variant,
      title,
      message,
      durationMs: numberOr(props.duration, 0),
    });
  }

  // ── outbound handlers ──────────────────────────────────────────────────
  // ── inbound handlers ───────────────────────────────────────────────────
  // ── approval flow ──────────────────────────────────────────────────────
  // ── helpers ────────────────────────────────────────────────────────────

}

module.exports = {
  createOpencodeTranslator,
};
