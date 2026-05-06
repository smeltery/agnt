// FILE: providers/claude/translate.js
// Purpose: Codex JSON-RPC <-> Claude Code stream-json protocol shim. Lets the
//          existing iOS app drive the `claude --output-format stream-json
//          --input-format stream-json --verbose` CLI without changes.
// Layer: provider plugin (claude)
// Exports: createClaudeTranslator
// Depends on: crypto, fs, path
//
// Design notes:
//   - The bridge speaks Codex JSON-RPC. The Claude CLI speaks stream-json:
//     stdin lines are `{type:"user", message:{...}}`, stdout lines are
//     `{type:"system"|"assistant"|"user"|"result", ...}`. This translator runs
//     in both directions and synthesizes JSON-RPC responses for Codex-only
//     methods that Claude does not handle (`thread/start`, `thread/read`,
//     `thread/turns/list`, `thread/contextWindow/read`, ...).
//   - One translator instance per bridge connection. State lives in closure:
//       threadId  : the synthetic Codex-style id we hand to the iOS app
//       sessionId : Claude's actual session_id (assigned at first system.init)
//       activeTurnId / pendingTurnRequestId / activeAssistantItemId / ...
//   - Claude does not pre-create sessions; the very first turn implicitly
//     creates one. We synthesize a `thread/start` response with a placeholder
//     threadId, then map that threadId to whatever session_id Claude reports
//     in the `system.init` line of the next turn.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PROTO_VERSION = "1.0.0-claude-shim";

function createClaudeTranslator({ injectInbound, transport: _transport, env = process.env } = {}) {
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
        emitNotification("turn/failed", {
          threadId,
          turnId: activeTurnId,
          id: activeTurnId,
          error: { message: "claude transport closed before turn completed" },
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

    if (method === "thread/generateTitle" || method === "thread/name/set") {
      // Local-only behavior; the iOS bridge already routes most of these
      // through git-handler. Acknowledge so the request does not hang.
      if (id != null) {
        injectResponse(id, { ok: true });
      }
      return null;
    }

    if (method === "thread/compact/start") {
      // Claude manages context internally; report no-op completion.
      if (id != null) {
        injectResponse(id, { ok: true, compacted: false });
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
      return null;
    }
    return null;
  }

  // ── outbound handlers ──────────────────────────────────────────────────
  function handleThreadStart(request) {
    const params = request?.params || {};
    const requestedCwd = readString(params.cwd) || readString(params.workingDirectory) || "";
    if (requestedCwd) sessionCwd = requestedCwd;

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
    const incomingThreadId = readString(params.threadId) || readString(params.thread_id);
    if (incomingThreadId) {
      threadId = incomingThreadId;
    }
    if (!threadId) {
      threadId = generateThreadId();
    }
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

    const reconstructed = reconstructThreadFromRollout(targetThreadId);
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
    const reconstructed = reconstructThreadFromRollout(targetThreadId);
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
    if (subtype !== "init") return null;

    const newSessionId = readString(message.session_id);
    if (newSessionId && !sessionId) {
      sessionId = newSessionId;
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
    }

    if (activeTurnId && !didEmitTurnStarted) {
      emitTurnStarted(activeTurnId);
    }
    return null;
  }

  function handleAssistant(message) {
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;

    const messageId = readString(inner.id);
    if (messageId) lastAssistantMessageId = messageId;
    const usage = inner.usage && typeof inner.usage === "object" ? inner.usage : null;
    if (usage) lastUsage = usage;

    const content = Array.isArray(inner.content) ? inner.content : [];
    if (content.length === 0) return null;

    if (!activeTurnId) {
      // Defensive: a stray assistant frame with no active turn shouldn't crash
      // the bridge. Synthesize a turn so deltas still surface.
      activeTurnId = generateTurnId();
    }
    if (!didEmitTurnStarted) {
      emitTurnStarted(activeTurnId);
    }

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partType = readString(part.type);

      if (partType === "text") {
        const text = readString(part.text);
        if (!text) continue;
        if (!activeAssistantItemId) {
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
        }
        emitNotification("item/agentMessage/delta", {
          threadId,
          turnId: activeTurnId,
          itemId: activeAssistantItemId,
          delta: text,
        });
        assistantTextAccumulator += text;
        continue;
      }

      if (partType === "thinking") {
        const reasoning = readString(part.thinking) || readString(part.text);
        if (!reasoning) continue;
        if (!reasoningItemId) {
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
        }
        emitNotification("item/reasoning/textDelta", {
          threadId,
          turnId: activeTurnId,
          itemId: reasoningItemId,
          delta: reasoning,
        });
        reasoningAccumulator += reasoning;
        continue;
      }

      if (partType === "tool_use") {
        emitToolUseStart(part);
        continue;
      }
    }

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

    if (toolName === "Bash") {
      const command = readString(input.command);
      const cwd = readString(input.cwd) || sessionCwd || "";
      pendingToolCalls.set(toolUseId, {
        kind: "bash",
        toolName,
        command,
        cwd,
      });
      emitNotification("codex/event/exec_command_begin", {
        threadId,
        turnId: activeTurnId,
        call_id: toolUseId,
        command,
        cwd,
        status: "running",
      });
      return;
    }

    pendingToolCalls.set(toolUseId, {
      kind: "background",
      toolName,
      command: toolName,
      cwd: sessionCwd || "",
    });
    emitNotification("codex/event/background_event", {
      threadId,
      turnId: activeTurnId,
      call_id: toolUseId,
      message: describeToolForUi(toolName, input),
    });
  }

  function emitToolResult(part) {
    const toolUseId = readString(part.tool_use_id);
    if (!toolUseId) return;
    const call = pendingToolCalls.get(toolUseId);
    if (!call) return;

    const output = readToolResultText(part.content);

    if (call.kind === "bash") {
      if (output) {
        emitNotification("codex/event/exec_command_output_delta", {
          threadId,
          turnId: activeTurnId,
          call_id: toolUseId,
          command: call.command,
          cwd: call.cwd,
          chunk: output,
        });
      }
      emitNotification("codex/event/exec_command_end", {
        threadId,
        turnId: activeTurnId,
        call_id: toolUseId,
        command: call.command,
        cwd: call.cwd,
        status: part.is_error === true ? "error" : "completed",
        output: output || "",
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

  // ── rollout reconstruction (best-effort thread/read & turns/list) ──────
  function reconstructThreadFromRollout(targetThreadId) {
    const sessionFile = locateSessionFile(targetThreadId);
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
    reasoningItemId = "";
    reasoningAccumulator = "";
    didEmitTurnStarted = false;
    pendingToolCalls.clear();
  }

  function generateThreadId() {
    return `thr_${crypto.randomBytes(12).toString("hex")}`;
  }

  function generateTurnId() {
    return `turn_${crypto.randomBytes(12).toString("hex")}`;
  }

  function generateItemId(kind) {
    return `${kind}_${crypto.randomBytes(10).toString("hex")}`;
  }

  function emitNotification(method, params) {
    injectInbound(JSON.stringify({ method, params }));
  }

  function injectResponse(id, result) {
    injectInbound(JSON.stringify({ id, result }));
  }

  function respondError(id, code, message) {
    if (id == null) return;
    injectInbound(JSON.stringify({ id, error: { code, message } }));
  }
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
  createClaudeTranslator,
};
