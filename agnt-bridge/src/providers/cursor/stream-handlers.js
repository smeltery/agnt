const {
  emitAssistantItemStarted,
  generateItemId,
  generateThreadId,
  generateTurnId,
  readString,
} = require("../_shared/translator-utils");

function createCursorStreamHandlers({
  emitNotification,
  emitTurnCompleted,
  emitTurnStarted,
  emitErrorNotification,
  resetTurnState,
  state,
  transport,
}) {
function handleSystem(message) {
  const subtype = readString(message.subtype);
  if (subtype !== "init") return null;

  const initCwd = readString(message.cwd);
  if (initCwd) state.sessionCwd = initCwd;

  if (!state.threadId) state.threadId = generateThreadId();

  if (!state.didEmitThreadStarted) {
    state.didEmitThreadStarted = true;
    emitNotification("thread/started", {
      threadId: state.threadId,
      thread_id: state.threadId,
      thread: {
        id: state.threadId,
        threadId: state.threadId,
        thread_id: state.threadId,
        cwd: state.sessionCwd,
      },
    });
    emitNotification("thread/initialized", {
      threadId: state.threadId,
      thread_id: state.threadId,
      provider: "cursor",
      model: readString(message.model),
      permissionMode: readString(message.permissionMode),
      cwd: state.sessionCwd,
      // cursor-agent does not advertise its tool list in the init frame;
      // surface a default set so the iOS UI has something to render.
      tools: ["read", "write", "edit", "shell", "grep", "glob", "ls"],
      slashCommands: [],
      skills: [],
      agents: [],
    });
  }

  if (state.activeTurnId && !state.didEmitTurnStarted) emitTurnStarted(state.activeTurnId);
  return null;
}

function handleAssistant(message) {
  const inner = message.message;
  if (!inner || typeof inner !== "object") return null;
  const content = Array.isArray(inner.content) ? inner.content : [];
  if (content.length === 0) return null;

  if (!state.activeTurnId) state.activeTurnId = generateTurnId();
  if (!state.didEmitTurnStarted) emitTurnStarted(state.activeTurnId);

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
    if (state.assistantTextAccumulator && text.startsWith(state.assistantTextAccumulator)) {
      delta = text.slice(state.assistantTextAccumulator.length);
    }
    if (!delta) continue;

    const itemId = ensureAssistantItemId();
    emitNotification("item/agentMessage/delta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId,
      delta,
    });
    state.assistantTextAccumulator = text.startsWith(state.assistantTextAccumulator)
      ? text
      : state.assistantTextAccumulator + delta;
  }
  return null;
}

function handleToolCall(message) {
  const subtype = readString(message.subtype);
  const callId = readString(message.call_id) || generateItemId("tool");
  const payload = message.tool_call && typeof message.tool_call === "object"
    ? message.tool_call
    : {};

  if (!state.threadId) state.threadId = generateThreadId();
  if (!state.activeTurnId) state.activeTurnId = generateTurnId();
  if (!state.didEmitTurnStarted) emitTurnStarted(state.activeTurnId);

  const descriptor = describeToolCall(payload);
  if (!descriptor) return null;

  if (subtype === "started") {
    if (state.pendingToolCalls.has(callId)) return null; // de-dup
    state.pendingToolCalls.set(callId, descriptor);
    emitToolStart(callId, descriptor);
    return null;
  }

  if (subtype === "completed") {
    const stored = state.pendingToolCalls.get(callId) || descriptor;
    const errored = readString(descriptor.status) === "error" || descriptor.errored === true;
    emitToolEnd(callId, stored, descriptor.output || "", errored);
    state.pendingToolCalls.delete(callId);
    return null;
  }

  return null;
}

function handleResult(message) {
  const finalText = readString(message.result);

  if (state.activeTurnId && state.threadId) {
    const agentText = state.assistantTextAccumulator || finalText || "";
    if (agentText) {
      const itemId = state.activeAssistantItemId || generateItemId("assistant");
      emitNotification("codex/event/agent_message", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId,
        message: agentText,
      });
      emitNotification("item/completed", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
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
      emitErrorNotification(state.activeTurnId, finalText || "cursor reported a turn error");
    }

    emitTurnCompleted(state.activeTurnId);
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
          cwd: readString(args.cwd) || state.sessionCwd || "",
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
      threadId: state.threadId,
      turnId: state.activeTurnId,
      call_id: callId,
      command: descriptor.command || "",
      cwd: descriptor.cwd || "",
      status: "running",
    });
    return;
  }

  if (descriptor.kind === "file_read") {
    emitNotification("item/started", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
    threadId: state.threadId,
    turnId: state.activeTurnId,
    call_id: callId,
    message: descriptor.displayName || `Running ${descriptor.toolName || "tool"}`,
  });
}

function emitToolEnd(callId, descriptor, output, errored) {
  if (descriptor.kind === "shell") {
    if (output) {
      emitNotification("codex/event/exec_command_output_delta", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        call_id: callId,
        command: descriptor.command || "",
        cwd: descriptor.cwd || "",
        chunk: output,
      });
    }
    emitNotification("codex/event/exec_command_end", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId: callId,
        delta: output,
      });
    }
    emitNotification("item/completed", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId: callId,
        delta: output,
      });
    }
    emitNotification("item/completed", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
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
    threadId: state.threadId,
    turnId: state.activeTurnId,
    call_id: callId,
    message: errored
      ? `Failed: ${descriptor.displayName || descriptor.toolName || "tool"}`
      : `Done: ${descriptor.displayName || descriptor.toolName || "tool"}`,
  });
}

function ensureAssistantItemId() {
  if (state.activeAssistantItemId) return state.activeAssistantItemId;
  state.activeAssistantItemId = generateItemId("assistant");
  emitAssistantItemStarted({
    emitNotification,
    threadId: state.threadId,
    turnId: state.activeTurnId,
    itemId: state.activeAssistantItemId,
  });
  return state.activeAssistantItemId;
}


  return {
    handleSystem,
    handleAssistant,
    handleToolCall,
    handleResult,
  };
}

module.exports = {
  createCursorStreamHandlers,
};
