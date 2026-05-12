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

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  buildTurnOverlapError,
  createFrameEmitter,
  generateItemId,
  generateThreadId,
  generateTurnId,
  readString,
  safeParseJson,
} = require("../_shared/translator-utils");

const PROTO_VERSION = "1.0.0-cursor-shim";

function createCursorTranslator({ injectInbound, transport, env = process.env } = {}) {
  const { emitNotification, injectResponse, respondError } = createFrameEmitter(injectInbound);

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

  return {
    outbound,
    inbound,
    handleStarted() {},
    handleClose() {
      // Surface a synthetic turn/failed if a turn is mid-flight when the CLI
      // exits — otherwise the iOS app's spinner stays forever.
      if (activeTurnId && threadId) {
        emitNotification("turn/failed", {
          threadId,
          turnId: activeTurnId,
          id: activeTurnId,
          error: { message: "cursor transport closed before turn completed" },
        });
        emitNotification("turn/completed", {
          threadId,
          turnId: activeTurnId,
          id: activeTurnId,
        });
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

    if (type === "system") return handleSystem(parsed);
    if (type === "assistant") return handleAssistant(parsed);
    if (type === "tool_call") return handleToolCall(parsed);
    if (type === "result") return handleResult(parsed);
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

    const reconstructed = reconstructThreadFromChats(targetThreadId);
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
    const reconstructed = reconstructThreadFromChats(targetThreadId);
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
  function handleSystem(message) {
    const subtype = readString(message.subtype);
    if (subtype !== "init") return null;

    const initCwd = readString(message.cwd);
    if (initCwd) sessionCwd = initCwd;

    if (!threadId) threadId = generateThreadId();

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
        provider: "cursor",
        model: readString(message.model),
        permissionMode: readString(message.permissionMode),
        cwd: sessionCwd,
        // cursor-agent does not advertise its tool list in the init frame;
        // surface a default set so the iOS UI has something to render.
        tools: ["read", "write", "edit", "shell", "grep", "glob", "ls"],
        slashCommands: [],
        skills: [],
        agents: [],
      });
    }

    if (activeTurnId && !didEmitTurnStarted) emitTurnStarted(activeTurnId);
    return null;
  }

  function handleAssistant(message) {
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;
    const content = Array.isArray(inner.content) ? inner.content : [];
    if (content.length === 0) return null;

    if (!activeTurnId) activeTurnId = generateTurnId();
    if (!didEmitTurnStarted) emitTurnStarted(activeTurnId);

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (readString(part.type) !== "text") continue;
      const text = readString(part.text);
      if (!text) continue;

      // cursor-agent emits assistant frames as it streams; each frame's text
      // is the latest snapshot. To produce stable deltas, slice off whatever
      // we already emitted. If the new text doesn't start with the previous
      // accumulator (e.g. the model rewrote a chunk), treat the whole frame
      // as a new delta — losing a pretty rendering once is better than
      // dropping content silently.
      let delta = text;
      if (assistantTextAccumulator && text.startsWith(assistantTextAccumulator)) {
        delta = text.slice(assistantTextAccumulator.length);
      }
      if (!delta) continue;

      const itemId = ensureAssistantItemId();
      emitNotification("item/agentMessage/delta", {
        threadId,
        turnId: activeTurnId,
        itemId,
        delta,
      });
      assistantTextAccumulator = text.startsWith(assistantTextAccumulator)
        ? text
        : assistantTextAccumulator + delta;
    }
    return null;
  }

  function handleToolCall(message) {
    const subtype = readString(message.subtype);
    const callId = readString(message.call_id) || generateItemId("tool");
    const payload = message.tool_call && typeof message.tool_call === "object"
      ? message.tool_call
      : {};

    if (!threadId) threadId = generateThreadId();
    if (!activeTurnId) activeTurnId = generateTurnId();
    if (!didEmitTurnStarted) emitTurnStarted(activeTurnId);

    const descriptor = describeToolCall(payload);
    if (!descriptor) return null;

    if (subtype === "started") {
      if (pendingToolCalls.has(callId)) return null; // de-dup
      pendingToolCalls.set(callId, descriptor);
      emitToolStart(callId, descriptor);
      return null;
    }

    if (subtype === "completed") {
      const stored = pendingToolCalls.get(callId) || descriptor;
      const errored = readString(descriptor.status) === "error" || descriptor.errored === true;
      emitToolEnd(callId, stored, descriptor.output || "", errored);
      pendingToolCalls.delete(callId);
      return null;
    }

    return null;
  }

  function handleResult(message) {
    const finalText = readString(message.result);

    if (activeTurnId && threadId) {
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

      if (message.is_error === true || readString(message.subtype) === "error") {
        emitErrorNotification(activeTurnId, finalText || "cursor reported a turn error");
      }

      emitTurnCompleted(activeTurnId);
    }

    resetTurnState();
    return null;
  }

  // ── tool_call mapping ──────────────────────────────────────────────────
  // cursor-agent's tool_call payload is a discriminated union. We pluck the
  // first non-empty key (readToolCall, writeToolCall, ...) and produce a
  // descriptor the bridge knows how to render.
  function describeToolCall(payload) {
    const entries = Object.entries(payload || {});
    for (const [key, value] of entries) {
      if (!value || typeof value !== "object") continue;
      const args = value.args && typeof value.args === "object" ? value.args : value;
      switch (key) {
        case "readToolCall":
          return {
            kind: "file_read",
            toolName: "read",
            filePath: readString(args.path),
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "writeToolCall":
          return {
            kind: "file_change",
            toolName: "write",
            filePath: readString(args.path),
            output: "",
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "editToolCall":
          return {
            kind: "file_change",
            toolName: "edit",
            filePath: readString(args.path),
            output: "",
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "shellToolCall": {
          const cmd = readString(args.command);
          return {
            kind: "shell",
            toolName: "shell",
            command: cmd,
            cwd: readString(args.cwd) || sessionCwd || "",
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        }
        case "grepToolCall":
          return {
            kind: "tool_call",
            toolName: "grep",
            displayName: `grep ${readString(args.pattern) || ""}`.trim(),
            filePath: readString(args.path),
            query: readString(args.pattern),
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "globToolCall":
          return {
            kind: "tool_call",
            toolName: "glob",
            displayName: `glob ${readString(args.globPattern) || ""}`.trim(),
            filePath: readString(args.targetDirectory),
            query: readString(args.globPattern),
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "lsToolCall":
          return {
            kind: "tool_call",
            toolName: "ls",
            displayName: `ls ${readString(args.path) || ""}`.trim(),
            filePath: readString(args.path),
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        case "function":
          return {
            kind: "background",
            toolName: readString(value.name) || "function",
            displayName: `Running ${readString(value.name) || "function"}`,
            output: readString(value.result) || readString(value.output),
            status: readString(value.status),
            errored: value.is_error === true,
          };
        default:
          continue;
      }
    }
    return null;
  }

  function emitToolStart(callId, descriptor) {
    if (descriptor.kind === "shell") {
      emitNotification("codex/event/exec_command_begin", {
        threadId,
        turnId: activeTurnId,
        call_id: callId,
        command: descriptor.command || "",
        cwd: descriptor.cwd || "",
        status: "running",
      });
      return;
    }

    if (descriptor.kind === "file_read") {
      emitNotification("item/started", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "file_read",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
        },
      });
      return;
    }

    if (descriptor.kind === "file_change") {
      emitNotification("item/started", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "file_change",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
        },
      });
      return;
    }

    if (descriptor.kind === "tool_call") {
      emitNotification("item/started", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "tool_call",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
          query: descriptor.query || "",
        },
      });
      return;
    }

    emitNotification("codex/event/background_event", {
      threadId,
      turnId: activeTurnId,
      call_id: callId,
      message: descriptor.displayName || `Running ${descriptor.toolName || "tool"}`,
    });
  }

  function emitToolEnd(callId, descriptor, output, errored) {
    if (descriptor.kind === "shell") {
      if (output) {
        emitNotification("codex/event/exec_command_output_delta", {
          threadId,
          turnId: activeTurnId,
          call_id: callId,
          command: descriptor.command || "",
          cwd: descriptor.cwd || "",
          chunk: output,
        });
      }
      emitNotification("codex/event/exec_command_end", {
        threadId,
        turnId: activeTurnId,
        call_id: callId,
        command: descriptor.command || "",
        cwd: descriptor.cwd || "",
        status: errored ? "error" : "completed",
        output: output || "",
      });
      return;
    }

    if (descriptor.kind === "file_read") {
      if (output) {
        emitNotification("item/toolCall/outputDelta", {
          threadId,
          turnId: activeTurnId,
          itemId: callId,
          delta: output,
        });
      }
      emitNotification("item/completed", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "file_read",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
          status: errored ? "error" : "completed",
          output: output || "",
        },
      });
      return;
    }

    if (descriptor.kind === "file_change") {
      emitNotification("item/completed", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "file_change",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
          status: errored ? "error" : "completed",
        },
      });
      return;
    }

    if (descriptor.kind === "tool_call") {
      if (output) {
        emitNotification("item/toolCall/outputDelta", {
          threadId,
          turnId: activeTurnId,
          itemId: callId,
          delta: output,
        });
      }
      emitNotification("item/completed", {
        threadId,
        turnId: activeTurnId,
        itemId: callId,
        item: {
          id: callId,
          itemId: callId,
          type: "tool_call",
          tool: descriptor.toolName,
          name: descriptor.toolName,
          file_path: descriptor.filePath || "",
          path: descriptor.filePath || "",
          query: descriptor.query || "",
          status: errored ? "error" : "completed",
          output: output || "",
        },
      });
      return;
    }

    // background
    emitNotification("codex/event/background_event", {
      threadId,
      turnId: activeTurnId,
      call_id: callId,
      message: errored
        ? `Failed: ${descriptor.displayName || descriptor.toolName || "tool"}`
        : `Done: ${descriptor.displayName || descriptor.toolName || "tool"}`,
    });
  }

  function ensureAssistantItemId() {
    if (activeAssistantItemId) return activeAssistantItemId;
    activeAssistantItemId = generateItemId("assistant");
    emitNotification("item/started", {
      threadId,
      turnId: activeTurnId,
      itemId: activeAssistantItemId,
      item: {
        id: activeAssistantItemId,
        itemId: activeAssistantItemId,
        type: "assistant_message",
        role: "assistant",
      },
    });
    return activeAssistantItemId;
  }

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

  // ── thread reconstruction from ~/.cursor/chats/*.jsonl ─────────────────
  function reconstructThreadFromChats(targetThreadId) {
    const sessionFile = locateSessionFile(targetThreadId);
    if (!sessionFile) return null;
    let raw;
    try { raw = fs.readFileSync(sessionFile, "utf8"); } catch { return null; }

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
          if (readString(part.type) !== "text") continue;
          const text = readString(part.text);
          if (!text) continue;
          currentTurn.items.push({
            id: readString(entry.uuid) || generateItemId("assistant"),
            type: "assistant_message",
            role: "assistant",
            text,
            content: [{ type: "text", text }],
          });
        }
      }
    }
    return {
      id: targetThreadId,
      threadId: targetThreadId,
      thread_id: targetThreadId,
      cwd: cwd || sessionCwd || process.cwd(),
      status: "idle",
      turns,
    };
  }

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

  function locateSessionFile(targetThreadId) {
    if (!targetThreadId) return "";
    const chatsDir = path.join(cursorHome(), "chats");
    const candidate = path.join(chatsDir, `${targetThreadId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
    return "";
  }

  function listThreadSummaries() {
    const chatsDir = path.join(cursorHome(), "chats");
    let files;
    try {
      files = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const summaries = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const id = file.name.slice(0, -".jsonl".length);
      let stat;
      try {
        stat = fs.statSync(path.join(chatsDir, file.name));
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
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries.slice(0, 200);
  }

  function cursorHome() {
    return env.CURSOR_HOME || path.join(os.homedir(), ".cursor");
  }

  // ── helpers ────────────────────────────────────────────────────────────
  function deriveTitleFromSeed(seed) {
    const trimmed = seed.replace(/\s+/g, " ").trim();
    if (!trimmed) return "New conversation";
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  }

  function emitTurnStarted(turnId) {
    didEmitTurnStarted = true;
    emitNotification("turn/started", {
      threadId,
      turnId,
      id: turnId,
      turn_id: turnId,
    });
  }

  function emitTurnCompleted(turnId) {
    emitNotification("turn/completed", {
      threadId,
      turnId,
      id: turnId,
      turn_id: turnId,
    });
  }

  function emitErrorNotification(turnId, errorMessage) {
    emitNotification("turn/failed", {
      threadId,
      turnId,
      id: turnId,
      error: { message: errorMessage },
    });
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
