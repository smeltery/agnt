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

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  buildTurnOverlapError,
  createFrameEmitter,
  createTurnLifecycleEmitter,
  deriveTitleFromSeed,
  emitAssistantItemStarted,
  generateItemId,
  generateThreadId,
  generateTurnId,
  numberOr,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");
const { reconstructThreadFromJsonl } = require("../_shared/thread-jsonl-reconstructor");

const PROTO_VERSION = "1.0.0-claude-shim";

function createClaudeTranslator({ injectInbound, transport, env = process.env } = {}) {
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);
  const turnLifecycle = createTurnLifecycleEmitter(emitNotification);

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
      handleContextWindowRead(parsed);
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
      return handleSystem(parsed);
    }
    if (type === "stream_event") {
      return handleStreamEvent(parsed);
    }
    if (type === "assistant") {
      return handleAssistant(parsed);
    }
    if (type === "user") {
      return handleUser(parsed);
    }
    if (type === "result") {
      return handleResult(parsed);
    }
    if (type === "rate_limit_event") {
      return handleRateLimitEvent(parsed);
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
    publishTurnArgsForParams(params);

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
      sessionFile: locateSessionFile(targetThreadId),
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
      sessionFile: locateSessionFile(targetThreadId),
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
    const summaries = listThreadSummaries();
    injectResponse(request.id, {
      data: summaries,
      threads: summaries,
      nextCursor: null,
      hasMore: false,
    });
  }

  function handleContextWindowRead(request) {
    if (request?.id == null) return;
    // Claude doesn't surface a context-window endpoint on the CLI; report a
    // best-effort snapshot so the iOS app's status row keeps rendering.
    injectResponse(request.id, {
      threadId: threadId || "",
      contextWindow: lastUsage
        ? {
          inputTokens: numberOr(lastUsage.input_tokens, 0),
          outputTokens: numberOr(lastUsage.output_tokens, 0),
          cacheReadTokens: numberOr(lastUsage.cache_read_input_tokens, 0),
          cacheCreateTokens: numberOr(lastUsage.cache_creation_input_tokens, 0),
        }
        : null,
    });
  }

  // ── inbound handlers ───────────────────────────────────────────────────
  function handleSystem(message) {
    const subtype = readString(message.subtype);
    if (subtype === "status") {
      // `status: "requesting"` is a hint that work has begun; we already
      // emitted turn/started up-front so no need to mirror it.
      return null;
    }
    if (subtype !== "init") return null;

    const newSessionId = readString(message.session_id);
    if (newSessionId) {
      sessionId = newSessionId;
      // Tell the transport so the next respawn (after an interrupt) picks up
      // history with `--resume <sessionId>`.
      try { transport?.setResumeSessionId?.(newSessionId); } catch { /* best-effort */ }
    }
    const initCwd = readString(message.cwd);
    if (initCwd) sessionCwd = initCwd;

    if (!threadId) {
      threadId = generateThreadId();
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
      emitNotification("thread/initialized", {
        threadId,
        thread_id: threadId,
        provider: "claude",
        model: readString(message.model),
        permissionMode: readString(message.permissionMode),
        cwd: sessionCwd,
        tools: Array.isArray(message.tools) ? message.tools.slice(0, 200) : [],
        slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands.slice(0, 200) : [],
        skills: Array.isArray(message.skills) ? message.skills.slice(0, 200) : [],
        agents: Array.isArray(message.agents) ? message.agents.slice(0, 100) : [],
        outputStyle: readString(message.output_style),
        version: readString(message.claude_code_version),
      });
    }

    if (activeTurnId && !didEmitTurnStarted) {
      emitTurnStarted(activeTurnId);
    }
    return null;
  }

  // ── stream_event handler (the real delta source when --include-partial-messages is on) ──
  function handleStreamEvent(envelope) {
    const event = envelope?.event;
    if (!event || typeof event !== "object") return null;
    const evType = readString(event.type);

    if (evType === "message_start") {
      const inner = event.message;
      if (inner && typeof inner === "object") {
        const messageId = readString(inner.id);
        if (messageId && messageId !== lastAssistantMessageId) {
          // New assistant message: reset per-message bookkeeping.
          lastAssistantMessageId = messageId;
          activeAssistantItemId = "";
          assistantTextAccumulator = "";
          reasoningItemId = "";
          reasoningAccumulator = "";
          blocksByIndex.clear();
        }
      }
      return null;
    }

    if (evType === "content_block_start") {
      const index = numberOr(event.index, -1);
      if (index < 0) return null;
      const block = event.content_block || {};
      const blockType = readString(block.type);
      if (blockType === "text") {
        const itemId = ensureAssistantItemId();
        blocksByIndex.set(index, { kind: "text", itemId });
      } else if (blockType === "thinking") {
        const itemId = ensureReasoningItemId();
        blocksByIndex.set(index, { kind: "thinking", itemId });
      } else if (blockType === "tool_use") {
        // Tool use deltas come via input_json_delta; we wait for the
        // consolidated `assistant` frame (which has the parsed input) before
        // emitting exec_command_begin to avoid acting on partial JSON.
        blocksByIndex.set(index, {
          kind: "tool_use",
          toolUseId: readString(block.id),
          toolName: readString(block.name),
        });
      }
      return null;
    }

    if (evType === "content_block_delta") {
      const index = numberOr(event.index, -1);
      const block = blocksByIndex.get(index);
      if (!block) return null;
      const delta = event.delta || {};
      const deltaType = readString(delta.type);

      if (deltaType === "text_delta" && block.kind === "text") {
        const text = readString(delta.text);
        if (!text) return null;
        emitNotification("item/agentMessage/delta", {
          threadId,
          turnId: activeTurnId,
          itemId: block.itemId,
          delta: text,
        });
        assistantTextAccumulator += text;
      } else if (deltaType === "thinking_delta" && block.kind === "thinking") {
        const text = readString(delta.thinking) || readString(delta.text);
        if (!text) return null;
        emitNotification("item/reasoning/textDelta", {
          threadId,
          turnId: activeTurnId,
          itemId: block.itemId,
          delta: text,
        });
        reasoningAccumulator += text;
      }
      // input_json_delta and signature_delta are intentionally dropped — we
      // re-emit tool calls from the consolidated assistant frame instead.
      return null;
    }

    if (evType === "content_block_stop") {
      // No-op: the per-block state lives until the next message_start clears it.
      return null;
    }

    if (evType === "message_delta") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
      if (usage) {
        lastUsage = mergeUsage(lastUsage, usage);
      }
      return null;
    }

    if (evType === "message_stop") {
      return null;
    }

    return null;
  }

  // The consolidated `assistant` frame appears once per message after the
  // stream_event sequence. We use it to:
  //   - emit tool_use exec_command_begin events with the FULL parsed input
  //     (stream_event input_json_delta is fragmentary)
  //   - act as a fallback delta source for clients running without
  //     --include-partial-messages
  function handleAssistant(message) {
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;

    const messageId = readString(inner.id);
    if (messageId) lastAssistantMessageId = messageId;
    const usage = inner.usage && typeof inner.usage === "object" ? inner.usage : null;
    if (usage) lastUsage = mergeUsage(lastUsage, usage);

    const content = Array.isArray(inner.content) ? inner.content : [];
    if (content.length === 0) return null;

    if (!activeTurnId) {
      activeTurnId = generateTurnId();
    }
    if (!didEmitTurnStarted) {
      emitTurnStarted(activeTurnId);
    }

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partType = readString(part.type);

      if (partType === "text") {
        // Fallback path: if no stream_event delta delivered any text yet for
        // this message, treat the consolidated text as a single delta. This
        // keeps the shim working without --include-partial-messages.
        const text = readString(part.text);
        if (!text || assistantTextAccumulator.length >= text.length) continue;
        const newText = text.startsWith(assistantTextAccumulator)
          ? text.slice(assistantTextAccumulator.length)
          : text;
        const itemId = ensureAssistantItemId();
        emitNotification("item/agentMessage/delta", {
          threadId,
          turnId: activeTurnId,
          itemId,
          delta: newText,
        });
        assistantTextAccumulator = text;
        continue;
      }

      if (partType === "thinking") {
        const reasoning = readString(part.thinking) || readString(part.text);
        if (!reasoning || reasoningAccumulator.length >= reasoning.length) continue;
        const newReasoning = reasoning.startsWith(reasoningAccumulator)
          ? reasoning.slice(reasoningAccumulator.length)
          : reasoning;
        const itemId = ensureReasoningItemId();
        emitNotification("item/reasoning/textDelta", {
          threadId,
          turnId: activeTurnId,
          itemId,
          delta: newReasoning,
        });
        reasoningAccumulator = reasoning;
        continue;
      }

      if (partType === "tool_use") {
        emitToolUseStart(part);
        continue;
      }
    }

    return null;
  }

  function ensureAssistantItemId() {
    if (activeAssistantItemId) return activeAssistantItemId;
    activeAssistantItemId = generateItemId("assistant");
    emitAssistantItemStarted({
      emitNotification,
      threadId,
      turnId: activeTurnId,
      itemId: activeAssistantItemId,
    });
    return activeAssistantItemId;
  }

  function ensureReasoningItemId() {
    if (reasoningItemId) return reasoningItemId;
    reasoningItemId = generateItemId("thinking");
    emitNotification("item/started", {
      threadId,
      turnId: activeTurnId,
      itemId: reasoningItemId,
      item: {
        id: reasoningItemId,
        itemId: reasoningItemId,
        type: "reasoning",
      },
    });
    return reasoningItemId;
  }

  function handleRateLimitEvent(envelope) {
    const info = envelope?.rate_limit_info && typeof envelope.rate_limit_info === "object"
      ? envelope.rate_limit_info
      : null;
    if (!info) return null;
    if (!threadId) return null;
    emitNotification("thread/status/changed", {
      threadId,
      thread_id: threadId,
      status: {
        type: "rateLimited",
        rateLimit: {
          type: readString(info.rateLimitType),
          status: readString(info.status),
          resetsAt: numberOr(info.resetsAt, 0),
          isUsingOverage: info.isUsingOverage === true,
        },
      },
    });
    return null;
  }

  function handleUser(message) {
    // The user-frame echo with role:"user" is the bridge's own input — ignore.
    // The interesting case is when claude relays a tool_result: we close the
    // matching exec_command_* event so the iOS app shows the output.
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;
    const content = Array.isArray(inner.content) ? inner.content : [];
    if (content.length === 0) return null;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partType = readString(part.type);
      if (partType !== "tool_result") continue;
      emitToolResult(part);
    }
    return null;
  }

  function handleResult(message) {
    // claude emits a single `result` line per logical turn (in --print/--input
    // stream mode). It carries duration_ms, usage, total_cost_usd, result.
    const finalText = readString(message.result);
    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (usage) lastUsage = usage;
    const newSessionId = readString(message.session_id);
    if (newSessionId && !sessionId) sessionId = newSessionId;

    if (activeTurnId && threadId) {
      // Promote any streamed assistant deltas into a final agent_message + item/completed
      // so the iOS app pins the message in history.
      const agentText = assistantTextAccumulator || finalText || "";
      if (agentText) {
        const itemId = activeAssistantItemId || generateItemId("assistant");
        emitNotification("codex/event/agent_message", {
          threadId,
          turnId: activeTurnId,
          itemId,
          message: agentText,
        });
        emitNotification("item/completed", {
          threadId,
          turnId: activeTurnId,
          itemId,
          item: {
            id: itemId,
            itemId,
            type: "assistant_message",
            role: "assistant",
            text: agentText,
            content: [{ type: "text", text: agentText }],
          },
        });
      }
      if (reasoningItemId && reasoningAccumulator) {
        emitNotification("item/completed", {
          threadId,
          turnId: activeTurnId,
          itemId: reasoningItemId,
          item: {
            id: reasoningItemId,
            itemId: reasoningItemId,
            type: "reasoning",
            text: reasoningAccumulator,
          },
        });
      }

      if (lastUsage) {
        emitNotification("thread/tokenUsage/updated", {
          threadId,
          tokenUsage: {
            inputTokens: numberOr(lastUsage.input_tokens, 0),
            outputTokens: numberOr(lastUsage.output_tokens, 0),
            cachedInputTokens: numberOr(lastUsage.cache_read_input_tokens, 0),
            cachedCreationInputTokens: numberOr(lastUsage.cache_creation_input_tokens, 0),
            totalCostUsd: numberOr(message.total_cost_usd, 0),
          },
        });
      }

      if (readString(message.subtype) === "error" || message.is_error === true) {
        emitErrorNotification(activeTurnId, readString(message.error?.message) || "claude reported a turn error");
      }

      emitTurnCompleted(activeTurnId);
    }

    resetTurnState();
    return null;
  }

  // ── tool_use / tool_result mapping ─────────────────────────────────────
  function emitToolUseStart(part) {
    const toolUseId = readString(part.id) || generateItemId("tool");
    const toolName = readString(part.name);
    const input = part.input && typeof part.input === "object" ? part.input : {};
    if (!threadId || !activeTurnId) return;
    if (pendingToolCalls.has(toolUseId)) return; // de-dup if assistant frame appears twice

    if (toolName === "Bash") {
      const command = readString(input.command);
      const cwd = readString(input.cwd) || sessionCwd || "";
      pendingToolCalls.set(toolUseId, { kind: "bash", toolName, command, cwd });
      emitNotification("codex/event/exec_command_begin", {
        threadId, turnId: activeTurnId,
        call_id: toolUseId, command, cwd, status: "running",
      });
      return;
    }

    if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
      const filePath = readString(input.file_path) || readString(input.path) || "";
      pendingToolCalls.set(toolUseId, { kind: "file_read", toolName, filePath });
      emitNotification("item/started", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: toolName === "Read" ? "file_read" : "tool_call",
          tool: toolName, name: toolName,
          file_path: filePath, path: filePath,
          query: readString(input.pattern) || readString(input.query) || "",
        },
      });
      return;
    }

    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const filePath = readString(input.file_path) || readString(input.path) || "";
      pendingToolCalls.set(toolUseId, { kind: "file_change", toolName, filePath });
      emitNotification("item/started", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: "file_change",
          tool: toolName, name: toolName,
          file_path: filePath, path: filePath,
        },
      });
      return;
    }

    pendingToolCalls.set(toolUseId, {
      kind: "background", toolName, command: toolName, cwd: sessionCwd || "",
    });
    emitNotification("codex/event/background_event", {
      threadId, turnId: activeTurnId,
      call_id: toolUseId, message: describeToolForUi(toolName, input),
    });
  }

  function emitToolResult(part) {
    const toolUseId = readString(part.tool_use_id);
    if (!toolUseId) return;
    const call = pendingToolCalls.get(toolUseId);
    if (!call) return;

    const output = readToolResultText(part.content);
    const errored = part.is_error === true;

    if (call.kind === "bash") {
      if (output) {
        emitNotification("codex/event/exec_command_output_delta", {
          threadId, turnId: activeTurnId,
          call_id: toolUseId, command: call.command, cwd: call.cwd,
          chunk: output,
        });
      }
      emitNotification("codex/event/exec_command_end", {
        threadId, turnId: activeTurnId,
        call_id: toolUseId, command: call.command, cwd: call.cwd,
        status: errored ? "error" : "completed",
        output: output || "",
      });
    } else if (call.kind === "file_read") {
      if (output) {
        emitNotification("item/toolCall/outputDelta", {
          threadId, turnId: activeTurnId, itemId: toolUseId,
          delta: output,
        });
      }
      emitNotification("item/completed", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: call.toolName === "Read" ? "file_read" : "tool_call",
          tool: call.toolName, name: call.toolName,
          file_path: call.filePath, path: call.filePath,
          status: errored ? "error" : "completed",
          output: output || "",
        },
      });
    } else if (call.kind === "file_change") {
      if (output) {
        emitNotification("item/fileChange/outputDelta", {
          threadId, turnId: activeTurnId, itemId: toolUseId,
          delta: output,
        });
      }
      emitNotification("item/completed", {
        threadId, turnId: activeTurnId, itemId: toolUseId,
        item: {
          id: toolUseId, itemId: toolUseId,
          type: "file_change",
          tool: call.toolName, name: call.toolName,
          file_path: call.filePath, path: call.filePath,
          status: errored ? "error" : "completed",
        },
      });
    }

    pendingToolCalls.delete(toolUseId);
  }

  function readToolResultText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const entry of content) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "text" && typeof entry.text === "string") {
        parts.push(entry.text);
      }
    }
    return parts.join("");
  }

  function describeToolForUi(toolName, input) {
    switch (toolName) {
      case "Read":      return `Reading ${shortPathOf(input)}`;
      case "Write":     return `Writing ${shortPathOf(input)}`;
      case "Edit":      return `Editing ${shortPathOf(input)}`;
      case "Glob":      return `Searching for ${readString(input.pattern) || "files"}`;
      case "Grep":      return `Grep ${readString(input.pattern) || ""}`;
      case "WebFetch":  return `Fetching ${readString(input.url) || "URL"}`;
      case "WebSearch": return `Searching the web`;
      default:          return `Running ${toolName}`;
    }
  }

  function shortPathOf(input) {
    const p = readString(input.file_path) || readString(input.path) || "";
    if (!p) return "file";
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  function locateSessionFile(targetThreadId) {
    if (!targetThreadId) return "";
    const projectsDir = path.join(claudeHome(), "projects");
    let entries;
    try {
      entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const candidate = path.join(projectsDir, dirent.name, `${targetThreadId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return "";
  }

  function listThreadSummaries() {
    const projectsDir = path.join(claudeHome(), "projects");
    let projects;
    try {
      projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let files;
      try {
        files = fs.readdirSync(path.join(projectsDir, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = file.name.slice(0, -".jsonl".length);
        let stat;
        try {
          stat = fs.statSync(path.join(projectsDir, project.name, file.name));
        } catch {
          continue;
        }
        summaries.push({
          id,
          threadId: id,
          thread_id: id,
          status: "idle",
          updatedAt: stat.mtimeMs,
          createdAt: stat.birthtimeMs || stat.ctimeMs,
        });
      }
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries.slice(0, 200);
  }

  function claudeHome() {
    return env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  }

  // ── per-turn CLI flag publishing ───────────────────────────────────────
  function publishTurnArgsForParams(params) {
    const args = [];
    const model = readString(params?.model)
      || readString(params?.modelId)
      || readString(params?.modelID);
    if (model) args.push("--model", model);

    const effort = readString(params?.effort)
      || readString(params?.reasoning_effort);
    if (effort) {
      const mapped = mapCodexEffortToClaude(effort.toLowerCase());
      if (mapped) args.push("--effort", mapped);
    }

    const collaborationMode = readString(params?.collaborationMode?.mode);
    if (collaborationMode === "plan") {
      args.push("--permission-mode", "plan");
    } else {
      const explicitMode = readString(params?.permissionMode);
      const permissionMode = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]
        .includes(explicitMode) ? explicitMode : "";
      // In --print mode there is no TTY for Claude to prompt on. The
      // `default` mode would block forever waiting for an approval that
      // never comes. Fall back to `acceptEdits` so file-edit tool calls
      // proceed; iOS clients can override per-turn via `permissionMode`.
      args.push("--permission-mode", permissionMode || "acceptEdits");
    }

    try { transport?.setTurnArgs?.(args); } catch { /* best-effort */ }
  }

  // ── thread/generateTitle (heuristic from first user message) ───────────
  // Spawning a fresh `claude --print` for title-only generation would be
  // expensive and depends on auth state. The iOS app already does its own
  // automatic title pass; here we just produce a deterministic seed so the
  // request does not hang.
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

  // Codex's reasoning_effort levels (`minimal|low|medium|high`) overlap but
  // do not match Claude's `--effort` levels (`low|medium|high|xhigh|max`).
  // Map cleanly so iOS picker selections drive Claude's actual flag instead
  // of being silently dropped.
  function mapCodexEffortToClaude(level) {
    switch (level) {
      case "minimal":
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
      case "very_high":
      case "very-high":
        return "xhigh";
      case "max":
      case "maximum":
        return "max";
      default:
        return "";
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function buildClaudeUserMessageLine(params) {
    const items = Array.isArray(params?.input) ? params.input : [];
    const contentParts = [];
    let textBuffer = "";
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const t = readString(item.type);
      if (t === "text") {
        const text = readString(item.text);
        if (text) textBuffer += textBuffer ? `\n${text}` : text;
      } else if (t === "image") {
        const url = readString(item.image_url) || readString(item.url);
        if (!url) continue;
        contentParts.push({
          type: "image",
          source: imageSourceFromUrl(url),
        });
      } else if (t === "skill") {
        const name = readString(item.name) || readString(item.id);
        if (name) textBuffer += `\n[skill: ${name}]`;
      } else if (t === "mention") {
        const name = readString(item.name);
        const p = readString(item.path);
        if (name && p) textBuffer += `\n@${name} (${p})`;
      }
    }
    if (textBuffer) {
      contentParts.unshift({ type: "text", text: textBuffer });
    }
    if (contentParts.length === 0) return "";
    const wire = {
      type: "user",
      message: {
        role: "user",
        // Claude accepts string or array content; arrays are required when
        // images are present.
        content: contentParts.length === 1 && contentParts[0].type === "text"
          ? contentParts[0].text
          : contentParts,
      },
    };
    return JSON.stringify(wire);
  }

  function imageSourceFromUrl(url) {
    if (url.startsWith("data:")) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(url);
      if (match) {
        return {
          type: "base64",
          media_type: match[1],
          data: match[2],
        };
      }
    }
    return { type: "url", url };
  }

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

function mergeUsage(prev, next) {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    input_tokens: numberOr(next.input_tokens, prev.input_tokens),
    output_tokens: numberOr(next.output_tokens, prev.output_tokens),
    cache_read_input_tokens: numberOr(next.cache_read_input_tokens, prev.cache_read_input_tokens),
    cache_creation_input_tokens: numberOr(next.cache_creation_input_tokens, prev.cache_creation_input_tokens),
  };
}

module.exports = {
  createClaudeTranslator,
};
