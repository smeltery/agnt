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
  generateItemId,
  generateTurnId,
  numberOr,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");

const PROTO_VERSION = "1.0.0-opencode-shim";

function createOpencodeTranslator({ injectInbound, transport, env: _env = process.env } = {}) {
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);

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

  return {
    outbound,
    inbound,
    handleStarted() {},
    handleClose() {
      if (activeTurnId && activeThreadId && !didEmitTurnCompletedForActive) {
        emitNotification("turn/failed", {
          threadId: activeThreadId,
          turnId: activeTurnId,
          id: activeTurnId,
          error: { message: "opencode transport closed before turn completed" },
        });
        emitNotification("turn/completed", {
          threadId: activeThreadId,
          turnId: activeTurnId,
          id: activeTurnId,
        });
      }
      resetTurnState();
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
      handleApprovalReply(parsed);
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
      handleThreadStart(parsed);
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
      handleContextWindowRead(parsed);
      return null;
    }

    if (method === "thread/compact/start" || method === "thread/compact") {
      handleThreadCompact(parsed);
      return null;
    }

    if (method === "thread/fork") {
      handleThreadFork(parsed);
      return null;
    }

    if (method === "thread/generateTitle" || method === "thread/name/set") {
      if (id != null) injectResponse(id, { ok: true });
      return null;
    }

    if (id != null) {
      respondError(id, -32601, `opencode provider does not support method: ${method}`);
    }
    return null;
  }

  // ── inbound (opencode SSE data line → bridge JSON-RPC) ─────────────────
  function inbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed || typeof parsed !== "object") return null;
    const type = readString(parsed.type);
    if (!type) return null;
    const props = parsed.properties && typeof parsed.properties === "object"
      ? parsed.properties
      : {};
    const sessionId = readString(props.sessionID) || readString(props.session_id);

    if (sessionId && activeThreadId && sessionId !== activeThreadId) {
      // Event is for a session we did not start through this bridge connection.
      // Ignore so we do not crosstalk between iOS app sessions.
      return null;
    }

    if (type === "session.status") {
      handleSessionStatus(props);
      return null;
    }
    if (type === "message.updated") {
      handleMessageUpdated(props);
      return null;
    }
    if (type === "message.part.updated") {
      handleMessagePartUpdated(props);
      return null;
    }
    if (type === "session.updated") {
      handleSessionUpdated(props);
      return null;
    }
    if (type === "session.diff") {
      handleSessionDiff(props);
      return null;
    }
    if (type === "session.error") {
      handleSessionError(props);
      return null;
    }
    if (type === "permission.asked") {
      handlePermissionAsked(parsed);
      return null;
    }
    if (type === "permission.replied") {
      // Mirror reply (the REST POST already handled it). Nothing to surface.
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
  async function handleThreadStart(request) {
    try {
      const res = await transport.httpRequest("POST", "/session", {});
      const sessionId = readString(res?.json?.id);
      if (!sessionId) {
        respondError(request?.id, -32603, `opencode POST /session returned no id (status ${res?.status})`);
        return;
      }
      activeThreadId = sessionId;
      const threadPayload = mapSessionToThread(res.json);
      if (request?.id != null) {
        injectResponse(request.id, { thread: threadPayload });
      }
      emitNotification("thread/started", {
        threadId: sessionId,
        thread_id: sessionId,
        thread: threadPayload,
      });
      emitNotification("thread/initialized", {
        threadId: sessionId,
        thread_id: sessionId,
        provider: "opencode",
        cwd: readString(res.json?.directory) || "",
        // opencode agents/tools are per-message, not exposed on session create.
        // Surface what we know; the iOS app can fall back to defaults.
        tools: [
          "bash", "read", "write", "edit", "glob", "grep",
          "task", "todowrite", "webfetch", "websearch",
        ],
        slashCommands: [],
        skills: [],
        agents: [],
      });
    } catch (err) {
      respondError(request?.id, -32603, `opencode POST /session failed: ${err?.message || err}`);
    }
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

    const turnId = generateTurnId();
    activeTurnId = turnId;
    activeAssistantMessageId = "";
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

    emitNotification("turn/started", {
      threadId: activeThreadId,
      turnId,
      id: turnId,
      turn_id: turnId,
    });

    const body = buildOpencodeMessageBody(params);
    if (!body) {
      emitNotification("turn/failed", {
        threadId: activeThreadId,
        turnId,
        id: turnId,
        error: { message: "turn/start had no usable text or attachments" },
      });
      emitNotification("turn/completed", {
        threadId: activeThreadId,
        turnId,
        id: turnId,
      });
      return;
    }

    // Fire-and-forget: opencode streams the assistant content via SSE on /event.
    // The HTTP response carries the final message snapshot but we do not wait
    // on it — the iOS app's UI is driven entirely off the SSE notifications.
    transport.httpRequest("POST", `/session/${encodeURIComponent(activeThreadId)}/message`, body)
      .catch((err) => {
        emitNotification("turn/failed", {
          threadId: activeThreadId,
          turnId,
          id: turnId,
          error: { message: `opencode POST /session/{id}/message failed: ${err?.message || err}` },
        });
        emitNotification("turn/completed", {
          threadId: activeThreadId,
          turnId,
          id: turnId,
        });
      });
  }

  function handleTurnInterrupt(request) {
    if (request?.id != null) injectResponse(request.id, { ok: true });
    if (!activeThreadId || !activeTurnId) return;
    transport.httpRequest("POST", `/session/${encodeURIComponent(activeThreadId)}/abort`, {})
      .catch(() => { /* best-effort */ });
    emitNotification("turn/failed", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      id: activeTurnId,
      error: { message: "interrupted by user" },
    });
    emitNotification("turn/completed", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      id: activeTurnId,
    });
    didEmitTurnCompletedForActive = true;
    resetTurnState();
  }

  async function handleThreadRead(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || activeThreadId;
    if (!targetThreadId) {
      respondError(request?.id, -32602, "thread/read requires a threadId");
      return;
    }
    activeThreadId = targetThreadId;
    try {
      const [sessionRes, messagesRes] = await Promise.all([
        transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}`),
        transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}/message`),
      ]);
      const session = sessionRes?.json || null;
      const messages = Array.isArray(messagesRes?.json) ? messagesRes.json : [];
      const thread = mapSessionToThread(session, { id: targetThreadId });
      thread.turns = mapMessagesToTurns(messages);
      if (request?.id != null) {
        injectResponse(request.id, { thread });
      }
    } catch (err) {
      respondError(request?.id, -32603, `opencode thread/read failed: ${err?.message || err}`);
    }
  }

  async function handleThreadTurnsList(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || activeThreadId;
    try {
      const messagesRes = await transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}/message`);
      const messages = Array.isArray(messagesRes?.json) ? messagesRes.json : [];
      const turns = mapMessagesToTurns(messages);
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
    } catch (err) {
      respondError(request?.id, -32603, `opencode thread/turns/list failed: ${err?.message || err}`);
    }
  }

  async function handleThreadCompact(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || activeThreadId;
    if (!targetThreadId) {
      respondError(request?.id, -32602, "thread/compact requires a threadId");
      return;
    }
    try {
      const res = await transport.httpRequest(
        "POST",
        `/session/${encodeURIComponent(targetThreadId)}/summarize`,
        {},
      );
      const ok = res?.status >= 200 && res?.status < 300;
      if (request?.id != null) {
        injectResponse(request.id, {
          ok,
          compacted: ok,
          threadId: targetThreadId,
        });
      }
    } catch (err) {
      respondError(request?.id, -32603, `opencode thread/compact failed: ${err?.message || err}`);
    }
  }

  async function handleThreadFork(request) {
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || activeThreadId;
    if (!targetThreadId) {
      respondError(request?.id, -32602, "thread/fork requires a threadId");
      return;
    }
    try {
      const messageId = readString(params.messageId) || readString(params.fromMessageId);
      const body = messageId ? { messageID: messageId } : {};
      const res = await transport.httpRequest(
        "POST",
        `/session/${encodeURIComponent(targetThreadId)}/fork`,
        body,
      );
      const newThread = mapSessionToThread(res?.json, { id: readString(res?.json?.id) || "" });
      if (request?.id != null) {
        injectResponse(request.id, { thread: newThread });
      }
    } catch (err) {
      respondError(request?.id, -32603, `opencode thread/fork failed: ${err?.message || err}`);
    }
  }

  async function handleContextWindowRead(request) {
    if (request?.id == null) return;
    const params = request?.params || {};
    const targetThreadId = readString(params.threadId)
      || readString(params.thread_id)
      || activeThreadId;
    if (!targetThreadId) {
      injectResponse(request.id, { threadId: activeThreadId, contextWindow: null });
      return;
    }
    try {
      const messagesRes = await transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}/message`);
      const messages = Array.isArray(messagesRes?.json) ? messagesRes.json : [];
      // The most recent assistant message carries the latest token snapshot.
      let tokens = null;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const info = messages[i]?.info && typeof messages[i].info === "object" ? messages[i].info : null;
        if (info && info.role === "assistant" && info.tokens && typeof info.tokens === "object") {
          tokens = info.tokens;
          break;
        }
      }
      injectResponse(request.id, {
        threadId: targetThreadId,
        contextWindow: tokens
          ? {
            inputTokens: numberOr(tokens.input, 0),
            outputTokens: numberOr(tokens.output, 0),
            reasoningTokens: numberOr(tokens.reasoning, 0),
            cacheReadTokens: numberOr(tokens.cache?.read, 0),
            cacheCreateTokens: numberOr(tokens.cache?.write, 0),
          }
          : null,
      });
    } catch (err) {
      respondError(request.id, -32603, `opencode thread/contextWindow/read failed: ${err?.message || err}`);
    }
  }

  async function handleThreadList(request) {
    try {
      const res = await transport.httpRequest("GET", "/session");
      const sessions = Array.isArray(res?.json) ? res.json : [];
      const params = request?.params || {};
      const requestedLimit = numberOr(params.limit, 0);
      // Cap unbounded lists so a phone with many sessions does not blow up
      // the relay payload. Mirrors the Claude shim's listThreadSummaries cap.
      const limit = Math.max(1, Math.min(requestedLimit > 0 ? requestedLimit : 200, 200));
      const sorted = sessions
        .slice()
        .sort((a, b) => numberOr(b?.time?.updated, 0) - numberOr(a?.time?.updated, 0))
        .slice(0, limit)
        .map((session) => mapSessionToSummary(session));
      if (request?.id != null) {
        injectResponse(request.id, {
          data: sorted,
          threads: sorted,
          nextCursor: null,
          hasMore: sessions.length > limit,
        });
      }
    } catch (err) {
      respondError(request?.id, -32603, `opencode thread/list failed: ${err?.message || err}`);
    }
  }

  // ── inbound handlers ───────────────────────────────────────────────────
  function handleSessionStatus(props) {
    const status = props?.status;
    const kind = readString(status?.type);
    if (!kind) return;

    if (kind === "busy") {
      // A `busy` status mid-turn just confirms work is in progress; we already
      // emitted turn/started up-front, so nothing to do here.
      return;
    }
    if (kind === "idle") {
      finalizeActiveTurn();
      return;
    }
    if (kind === "retry" || kind === "error") {
      const message = readString(status?.message) || `session ${kind}`;
      // The retry status carries `next` (epoch ms) when opencode is rate-
      // limited — surface that as thread/status/changed so the iOS app can
      // render a banner while the request waits to resume.
      const next = numberOr(status?.next, 0);
      if (next > 0 && activeThreadId) {
        emitNotification("thread/status/changed", {
          threadId: activeThreadId,
          thread_id: activeThreadId,
          status: {
            type: "rateLimited",
            rateLimit: {
              status: kind,
              resetsAt: next,
              attempt: numberOr(status?.attempt, 0),
              message,
            },
          },
        });
      }
      if (activeTurnId && activeThreadId) {
        emitNotification("turn/failed", {
          threadId: activeThreadId,
          turnId: activeTurnId,
          id: activeTurnId,
          error: { message },
        });
        // Don't fire turn/completed here — opencode may auto-recover; an
        // explicit `idle` status will follow once the retry resolves.
      }
    }
  }

  function handleMessageUpdated(props) {
    const info = props?.info;
    if (!info || typeof info !== "object") return;
    const role = readString(info.role);
    const messageId = readString(info.id);
    if (role !== "assistant" || !messageId || !activeTurnId || !activeThreadId) return;

    if (info.tokens && typeof info.tokens === "object") {
      lastTokenSnapshot = info.tokens;
    }

    if (activeAssistantMessageId === messageId) return;
    activeAssistantMessageId = messageId;
    emitNotification("item/started", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      itemId: messageId,
      item: {
        id: messageId,
        itemId: messageId,
        type: "assistant_message",
        role: "assistant",
      },
    });
  }

  function handleMessagePartUpdated(props) {
    if (!activeTurnId || !activeThreadId) return;
    const part = props?.part;
    if (!part || typeof part !== "object") return;
    const partId = readString(part.id);
    const partType = readString(part.type);
    const messageId = readString(part.messageID) || activeAssistantMessageId;

    if (partType === "text") {
      const text = readString(part.text);
      if (!text) return;
      const itemId = messageId || mapPartItemId(partId, "assistant");
      const previous = partItemIds.get(partId);
      const delta = previous === undefined
        ? text
        : text.length > previous.length && text.startsWith(previous)
          ? text.slice(previous.length)
          : text;
      partItemIds.set(partId, text);
      emitNotification("item/agentMessage/delta", {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId,
        delta,
      });
      return;
    }

    if (partType === "reasoning") {
      const reasoning = readString(part.text) || readString(part.reasoning);
      if (!reasoning) return;
      const itemId = mapPartItemId(partId, "thinking");
      const previous = partItemIds.get(partId);
      const delta = typeof previous === "string" && reasoning.length > previous.length && reasoning.startsWith(previous)
        ? reasoning.slice(previous.length)
        : reasoning;
      partItemIds.set(partId, reasoning);
      emitNotification("item/reasoning/textDelta", {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId,
        delta,
      });
      return;
    }

    if (partType === "tool") {
      handleToolPartUpdate(part, partId);
      return;
    }

    if (partType === "patch") {
      handlePatchPartUpdate(part, partId);
      return;
    }

    // step-start / step-finish / snapshot / agent / file are intentional
    // no-ops here: step markers are turn-internal phase signals, snapshot is
    // workspace bookkeeping, file/agent appear inside other parts. Add
    // explicit handling here when iOS gains UI affordances for them.
  }

  function handlePatchPartUpdate(part, partId) {
    if (!activeTurnId || !activeThreadId) return;
    const filePath = readString(part?.file_path) || readString(part?.path) || readString(part?.filepath);
    const diff = readString(part?.diff) || readString(part?.text) || "";
    if (!filePath && !diff) return;
    const itemId = partId || generateItemId("patch");
    emitNotification("turn/diff/updated", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      diff: [{ file: filePath, patch: diff }],
    });
    if (!toolCallById.has(partId)) {
      toolCallById.set(partId, { kind: "file_change", toolName: "patch", filePath, itemId, wroteBegin: true });
      emitNotification("item/started", {
        threadId: activeThreadId, turnId: activeTurnId, itemId,
        item: {
          id: itemId, itemId,
          type: "file_change", tool: "patch", name: "patch",
          file_path: filePath, path: filePath,
        },
      });
    }
    if (diff) {
      emitNotification("item/fileChange/outputDelta", {
        threadId: activeThreadId, turnId: activeTurnId, itemId,
        delta: diff,
      });
    }
  }

  function handleToolPartUpdate(part, partId) {
    const toolName = (readString(part.tool) || readString(part.name) || "tool").toLowerCase();
    const state = part.state && typeof part.state === "object" ? part.state : null;
    const status = readString(state?.status);
    const input = state?.input && typeof state.input === "object" ? state.input : {};
    const errored = status === "error";
    const isTerminal = status === "completed" || status === "error";

    if (!toolCallById.has(partId)) {
      const itemId = partId || generateItemId("tool");
      const kind = classifyOpencodeTool(toolName);
      const command = readString(input.command);
      const cwd = readString(input.cwd);
      const filePath = readString(input.file_path) || readString(input.filePath) || readString(input.path);
      const pattern = readString(input.pattern) || readString(input.query);
      toolCallById.set(partId, {
        kind, toolName, itemId, command, cwd, filePath, pattern, wroteBegin: false,
      });
    }
    const record = toolCallById.get(partId);
    const output = readString(state?.output) || readString(state?.stdout) || "";

    if (record.kind === "bash") {
      if (!record.wroteBegin) {
        record.wroteBegin = true;
        emitNotification("codex/event/exec_command_begin", {
          threadId: activeThreadId, turnId: activeTurnId,
          call_id: record.itemId, command: record.command, cwd: record.cwd,
          status: "running",
        });
      }
      if (isTerminal) {
        if (output) {
          emitNotification("codex/event/exec_command_output_delta", {
            threadId: activeThreadId, turnId: activeTurnId,
            call_id: record.itemId, command: record.command, cwd: record.cwd,
            chunk: output,
          });
        }
        emitNotification("codex/event/exec_command_end", {
          threadId: activeThreadId, turnId: activeTurnId,
          call_id: record.itemId, command: record.command, cwd: record.cwd,
          status: errored ? "error" : "completed", output,
        });
        toolCallById.delete(partId);
      }
      return;
    }

    if (record.kind === "file_read") {
      if (!record.wroteBegin) {
        record.wroteBegin = true;
        emitNotification("item/started", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          item: {
            id: record.itemId, itemId: record.itemId,
            type: record.toolName === "read" ? "file_read" : "tool_call",
            tool: record.toolName, name: record.toolName,
            file_path: record.filePath, path: record.filePath,
            query: record.pattern,
          },
        });
      }
      if (output) {
        emitNotification("item/toolCall/outputDelta", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          delta: output,
        });
      }
      if (isTerminal) {
        emitNotification("item/completed", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          item: {
            id: record.itemId, itemId: record.itemId,
            type: record.toolName === "read" ? "file_read" : "tool_call",
            tool: record.toolName, name: record.toolName,
            file_path: record.filePath, path: record.filePath,
            query: record.pattern,
            status: errored ? "error" : "completed",
            output,
          },
        });
        toolCallById.delete(partId);
      }
      return;
    }

    if (record.kind === "file_change") {
      if (!record.wroteBegin) {
        record.wroteBegin = true;
        emitNotification("item/started", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          item: {
            id: record.itemId, itemId: record.itemId,
            type: "file_change",
            tool: record.toolName, name: record.toolName,
            file_path: record.filePath, path: record.filePath,
          },
        });
      }
      if (output) {
        emitNotification("item/fileChange/outputDelta", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          delta: output,
        });
      }
      if (isTerminal) {
        emitNotification("item/completed", {
          threadId: activeThreadId, turnId: activeTurnId, itemId: record.itemId,
          item: {
            id: record.itemId, itemId: record.itemId,
            type: "file_change",
            tool: record.toolName, name: record.toolName,
            file_path: record.filePath, path: record.filePath,
            status: errored ? "error" : "completed",
          },
        });
        toolCallById.delete(partId);
      }
      return;
    }

    // background tool (task, todowrite, webfetch, websearch, ...)
    if (!record.wroteBegin) {
      record.wroteBegin = true;
      emitNotification("codex/event/background_event", {
        threadId: activeThreadId, turnId: activeTurnId,
        call_id: record.itemId,
        message: describeOpencodeTool(record.toolName, input),
      });
    }
    if (isTerminal) {
      toolCallById.delete(partId);
    }
  }

  function classifyOpencodeTool(toolName) {
    switch (toolName) {
      case "bash": return "bash";
      case "read":
      case "glob":
      case "grep": return "file_read";
      case "write":
      case "edit":
      case "patch":
      case "notebookedit":
      case "notebook_edit": return "file_change";
      default: return "background";
    }
  }

  function describeOpencodeTool(toolName, input) {
    switch (toolName) {
      case "task": return `Running task: ${readString(input?.description) || "subagent"}`;
      case "todowrite": return "Updating todo list";
      case "webfetch": return `Fetching ${readString(input?.url) || "URL"}`;
      case "websearch": return "Searching the web";
      default: return `Running ${toolName}`;
    }
  }

  function handleSessionUpdated(props) {
    const info = props?.info;
    if (!info || typeof info !== "object") return;
    const sessionId = readString(info.id);
    const title = readString(info.title);
    if (sessionId && title) {
      emitNotification("thread/name/updated", {
        threadId: sessionId,
        thread_id: sessionId,
        name: title,
        title,
      });
    }
  }

  function handleSessionDiff(props) {
    if (!activeThreadId) return;
    emitNotification("turn/diff/updated", {
      threadId: activeThreadId,
      turnId: activeTurnId || "",
      diff: props?.diff || [],
    });
  }

  function handleSessionError(props) {
    const message = readString(props?.error?.message)
      || readString(props?.message)
      || "opencode session reported an error";
    if (activeTurnId && activeThreadId) {
      emitNotification("turn/failed", {
        threadId: activeThreadId,
        turnId: activeTurnId,
        id: activeTurnId,
        error: { message },
      });
      emitNotification("turn/completed", {
        threadId: activeThreadId,
        turnId: activeTurnId,
        id: activeTurnId,
      });
      didEmitTurnCompletedForActive = true;
      resetTurnState();
    }
  }

  // ── approval flow ──────────────────────────────────────────────────────
  function handlePermissionAsked(envelope) {
    // opencode top-level shape (from the SDK code): the event payload is the
    // permission object directly under `properties` (not wrapped). Defensive
    // about both layouts.
    const props = envelope?.properties || {};
    const perm = props?.info && typeof props.info === "object" ? props.info : props;
    const permissionID = readString(perm?.id) || readString(perm?.permissionID);
    if (!permissionID) return;
    const sessionID = readString(perm?.sessionID) || activeThreadId;
    if (sessionID !== activeThreadId) return;

    const kind = readString(perm?.permission) || "command";
    const metadata = perm?.metadata && typeof perm.metadata === "object" ? perm.metadata : {};
    const requestId = `approval_${permissionID}`;
    approvalIdToPermission.set(String(requestId), { permissionID, sessionID });

    const isFileChange = kind === "edit" || kind === "write" || kind === "patch";
    const requestMethod = isFileChange
      ? "item/fileChange/requestApproval"
      : "item/commandExecution/requestApproval";

    injectInbound(JSON.stringify({
      id: requestId,
      method: requestMethod,
      params: {
        threadId: activeThreadId,
        turnId: activeTurnId,
        kind,
        command: readString(metadata.command) || readString(perm?.tool) || "",
        cwd: readString(metadata.cwd) || readString(perm?.directory) || "",
        file_path: readString(metadata.filepath) || readString(metadata.file_path) || "",
        diff: readString(metadata.diff) || "",
        reason: readString(perm?.title) || readString(perm?.description) || "",
        permissionID,
      },
    }));
  }

  async function handleApprovalReply(reply) {
    const requestId = String(reply.id);
    const tracked = approvalIdToPermission.get(requestId);
    if (!tracked) return; // not an approval reply we issued
    approvalIdToPermission.delete(requestId);

    const decision = readString(reply?.result?.decision)
      || readString(reply?.result?.response)
      || (reply?.error ? "reject" : "");
    // iOS uses Codex's "accept"/"decline"/"reject"; opencode wants
    // "once"|"always"|"reject" (and optionally other optionIds).
    let response;
    if (decision === "accept" || decision === "approve" || decision === "once") {
      response = "once";
    } else if (decision === "always") {
      response = "always";
    } else {
      response = "reject";
    }

    try {
      await transport.httpRequest(
        "POST",
        `/session/${encodeURIComponent(tracked.sessionID)}/permissions/${encodeURIComponent(tracked.permissionID)}`,
        { sessionID: tracked.sessionID, permissionID: tracked.permissionID, response },
      );
    } catch {
      // Best-effort; the assistant will surface a tool failure if the POST
      // didn't land.
    }
  }

  function finalizeActiveTurn() {
    if (!activeTurnId || !activeThreadId || didEmitTurnCompletedForActive) return;
    if (activeAssistantMessageId) {
      const accumulator = collectAssistantText();
      if (accumulator) {
        emitNotification("codex/event/agent_message", {
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: activeAssistantMessageId,
          message: accumulator,
        });
      }
      emitNotification("item/completed", {
        threadId: activeThreadId,
        turnId: activeTurnId,
        itemId: activeAssistantMessageId,
        item: {
          id: activeAssistantMessageId,
          itemId: activeAssistantMessageId,
          type: "assistant_message",
          role: "assistant",
          text: accumulator,
          content: accumulator ? [{ type: "text", text: accumulator }] : [],
        },
      });
    }
    if (lastTokenSnapshot) {
      emitNotification("thread/tokenUsage/updated", {
        threadId: activeThreadId,
        tokenUsage: {
          inputTokens: numberOr(lastTokenSnapshot.input, 0),
          outputTokens: numberOr(lastTokenSnapshot.output, 0),
          reasoningTokens: numberOr(lastTokenSnapshot.reasoning, 0),
          cachedInputTokens: numberOr(lastTokenSnapshot.cache?.read, 0),
          cachedCreationInputTokens: numberOr(lastTokenSnapshot.cache?.write, 0),
        },
      });
    }
    emitNotification("turn/completed", {
      threadId: activeThreadId,
      turnId: activeTurnId,
      id: activeTurnId,
      turn_id: activeTurnId,
    });
    didEmitTurnCompletedForActive = true;
    resetTurnState();
  }

  function collectAssistantText() {
    let combined = "";
    for (const [, snapshot] of partItemIds) {
      if (typeof snapshot === "string") combined += snapshot;
    }
    return combined;
  }

  function resetTurnState() {
    activeTurnId = "";
    activeAssistantMessageId = "";
    partItemIds.clear();
    toolCallById.clear();
    didEmitTurnCompletedForActive = false;
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function buildOpencodeMessageBody(params) {
    const items = Array.isArray(params?.input) ? params.input : [];
    const parts = [];
    let combinedText = "";
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const type = readString(item.type);
      if (type === "text") {
        const text = readString(item.text);
        if (text) combinedText += combinedText ? `\n${text}` : text;
      } else if (type === "image") {
        const url = readString(item.image_url) || readString(item.url);
        if (!url) continue;
        // opencode receives images as `{type:"file", mediaType, url}` parts.
        // The internal model adapter rewrites that to image_url for upstream
        // providers (verified in opencode 1.14.30 binary).
        const mediaType = inferImageMediaType(url);
        parts.push({ type: "file", mediaType, url });
      } else if (type === "skill") {
        const name = readString(item.name) || readString(item.id);
        if (name) combinedText += `\n[skill: ${name}]`;
      } else if (type === "mention") {
        const name = readString(item.name);
        const p = readString(item.path);
        if (name && p) combinedText += `\n@${name} (${p})`;
      }
    }
    if (combinedText) parts.unshift({ type: "text", text: combinedText });
    if (parts.length === 0) return null;

    const providerId = readString(params.providerID)
      || readString(params.provider)
      || lastProviderId
      || "anthropic";
    const modelId = readString(params.modelID)
      || readString(params.model)
      || lastModelId
      || "claude-haiku-4-5";
    lastProviderId = providerId;
    lastModelId = modelId;

    return {
      providerID: providerId,
      modelID: modelId,
      parts,
    };
  }

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
          id: messageId || generateTurnId(),
          turnId: messageId || generateTurnId(),
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
      return {
        id: itemId,
        itemId,
        type: "assistant_message",
        role: "assistant",
        text: readString(part.text),
        content: [{ type: "text", text: readString(part.text) }],
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

  function mapPartItemId(partId, kind) {
    if (!partId) return generateItemId(kind);
    const cached = partItemIds.get(`${partId}:itemId`);
    if (cached) return cached;
    const id = generateItemId(kind);
    partItemIds.set(`${partId}:itemId`, id);
    return id;
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

}

module.exports = {
  createOpencodeTranslator,
};
