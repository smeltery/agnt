const { generateItemId, numberOr, readString } = require("../_shared/translator-utils");

function createOpencodeStreamHandlers({ emitNotification, state, toolCallById, turnLifecycle }) {
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
    if (next > 0 && state.activeThreadId) {
      emitNotification("thread/status/changed", {
        threadId: state.activeThreadId,
        thread_id: state.activeThreadId,
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
    if (state.activeTurnId && state.activeThreadId) {
      turnLifecycle.emitTurnFailed(state.activeThreadId, state.activeTurnId, message);
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
  if (role !== "assistant" || !messageId || !state.activeTurnId || !state.activeThreadId) return;

  if (info.tokens && typeof info.tokens === "object") {
    state.lastTokenSnapshot = info.tokens;
  }

  if (state.activeAssistantMessageId === messageId) return;
  state.activeAssistantMessageId = messageId;
  emitNotification("item/started", {
    threadId: state.activeThreadId,
    turnId: state.activeTurnId,
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
  if (!state.activeTurnId || !state.activeThreadId) return;
  const part = props?.part;
  if (!part || typeof part !== "object") return;
  const partId = readString(part.id);
  const partType = readString(part.type);
  const messageId = readString(part.messageID) || state.activeAssistantMessageId;

  if (partType === "text") {
    const text = readString(part.text);
    if (!text) return;
    const itemId = messageId || mapPartItemId(partId, "assistant");
    const previous = state.partItemIds.get(partId);
    const delta = previous === undefined
      ? text
      : text.length > previous.length && text.startsWith(previous)
        ? text.slice(previous.length)
        : text;
    state.partItemIds.set(partId, text);
    emitNotification("item/agentMessage/delta", {
      threadId: state.activeThreadId,
      turnId: state.activeTurnId,
      itemId,
      delta,
    });
    return;
  }

  if (partType === "reasoning") {
    const reasoning = readString(part.text) || readString(part.reasoning);
    if (!reasoning) return;
    const itemId = mapPartItemId(partId, "thinking");
    const previous = state.partItemIds.get(partId);
    const delta = typeof previous === "string" && reasoning.length > previous.length && reasoning.startsWith(previous)
      ? reasoning.slice(previous.length)
      : reasoning;
    state.partItemIds.set(partId, reasoning);
    emitNotification("item/reasoning/textDelta", {
      threadId: state.activeThreadId,
      turnId: state.activeTurnId,
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
  if (!state.activeTurnId || !state.activeThreadId) return;
  const filePath = readString(part?.file_path) || readString(part?.path) || readString(part?.filepath);
  const diff = readString(part?.diff) || readString(part?.text) || "";
  if (!filePath && !diff) return;
  const itemId = partId || generateItemId("patch");
  emitNotification("turn/diff/updated", {
    threadId: state.activeThreadId,
    turnId: state.activeTurnId,
    diff: [{ file: filePath, patch: diff }],
  });
  if (!toolCallById.has(partId)) {
    toolCallById.set(partId, { kind: "file_change", toolName: "patch", filePath, itemId, wroteBegin: true });
    emitNotification("item/started", {
      threadId: state.activeThreadId, turnId: state.activeTurnId, itemId,
      item: {
        id: itemId, itemId,
        type: "file_change", tool: "patch", name: "patch",
        file_path: filePath, path: filePath,
      },
    });
  }
  if (diff) {
    emitNotification("item/fileChange/outputDelta", {
      threadId: state.activeThreadId, turnId: state.activeTurnId, itemId,
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
        threadId: state.activeThreadId, turnId: state.activeTurnId,
        call_id: record.itemId, command: record.command, cwd: record.cwd,
        status: "running",
      });
    }
    if (isTerminal) {
      if (output) {
        emitNotification("codex/event/exec_command_output_delta", {
          threadId: state.activeThreadId, turnId: state.activeTurnId,
          call_id: record.itemId, command: record.command, cwd: record.cwd,
          chunk: output,
        });
      }
      emitNotification("codex/event/exec_command_end", {
        threadId: state.activeThreadId, turnId: state.activeTurnId,
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
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
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
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
        delta: output,
      });
    }
    if (isTerminal) {
      emitNotification("item/completed", {
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
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
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
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
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
        delta: output,
      });
    }
    if (isTerminal) {
      emitNotification("item/completed", {
        threadId: state.activeThreadId, turnId: state.activeTurnId, itemId: record.itemId,
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
      threadId: state.activeThreadId, turnId: state.activeTurnId,
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
  if (!state.activeThreadId) return;
  emitNotification("turn/diff/updated", {
    threadId: state.activeThreadId,
    turnId: state.activeTurnId || "",
    diff: props?.diff || [],
  });
}

function handleSessionError(props) {
  const message = readString(props?.error?.message)
    || readString(props?.message)
    || "opencode session reported an error";
  if (state.activeTurnId && state.activeThreadId) {
    turnLifecycle.emitTurnFailed(state.activeThreadId, state.activeTurnId, message);
    turnLifecycle.emitTurnCompleted(state.activeThreadId, state.activeTurnId);
    state.didEmitTurnCompletedForActive = true;
    resetTurnState();
  }
}

function finalizeActiveTurn() {
  if (!state.activeTurnId || !state.activeThreadId || state.didEmitTurnCompletedForActive) return;
  if (state.activeAssistantMessageId) {
    const accumulator = collectAssistantText();
    if (accumulator) {
      emitNotification("codex/event/agent_message", {
        threadId: state.activeThreadId,
        turnId: state.activeTurnId,
        itemId: state.activeAssistantMessageId,
        message: accumulator,
      });
    }
    emitNotification("item/completed", {
      threadId: state.activeThreadId,
      turnId: state.activeTurnId,
      itemId: state.activeAssistantMessageId,
      item: {
        id: state.activeAssistantMessageId,
        itemId: state.activeAssistantMessageId,
        type: "assistant_message",
        role: "assistant",
        text: accumulator,
        content: accumulator ? [{ type: "text", text: accumulator }] : [],
      },
    });
  }
  if (state.lastTokenSnapshot) {
    emitNotification("thread/tokenUsage/updated", {
      threadId: state.activeThreadId,
      tokenUsage: {
        inputTokens: numberOr(state.lastTokenSnapshot.input, 0),
        outputTokens: numberOr(state.lastTokenSnapshot.output, 0),
        reasoningTokens: numberOr(state.lastTokenSnapshot.reasoning, 0),
        cachedInputTokens: numberOr(state.lastTokenSnapshot.cache?.read, 0),
        cachedCreationInputTokens: numberOr(state.lastTokenSnapshot.cache?.write, 0),
      },
    });
  }
  turnLifecycle.emitTurnCompleted(state.activeThreadId, state.activeTurnId);
  state.didEmitTurnCompletedForActive = true;
  resetTurnState();
}

function collectAssistantText() {
  let combined = "";
  for (const [, snapshot] of state.partItemIds) {
    if (typeof snapshot === "string") combined += snapshot;
  }
  return combined;
}

function resetTurnState() {
  state.activeTurnId = "";
  state.activeAssistantMessageId = "";
  state.partItemIds.clear();
  toolCallById.clear();
  state.didEmitTurnCompletedForActive = false;
}

function mapPartItemId(partId, kind) {
  if (!partId) return generateItemId(kind);
  const cached = state.partItemIds.get(`${partId}:itemId`);
  if (cached) return cached;
  const id = generateItemId(kind);
  state.partItemIds.set(`${partId}:itemId`, id);
  return id;
}

  return {
    handleSessionStatus,
    handleMessageUpdated,
    handleMessagePartUpdated,
    handleSessionUpdated,
    handleSessionDiff,
    handleSessionError,
    finalizeActiveTurn,
    resetTurnState,
  };
}

module.exports = {
  createOpencodeStreamHandlers,
};
