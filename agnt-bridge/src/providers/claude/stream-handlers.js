const {
  emitAssistantItemStarted,
  generateItemId,
  generateThreadId,
  generateTurnId,
  numberOr,
  readString,
} = require("../_shared/translator-utils");

function createClaudeStreamHandlers({
  emitErrorNotification,
  emitNotification,
  emitTurnCompleted,
  emitTurnStarted,
  resetTurnState,
  state,
  toolEmitter,
  transport,
}) {
  function handleSystem(message) {
    const subtype = readString(message.subtype);
    if (subtype === "status") return null;
    if (subtype !== "init") return null;

    const newSessionId = readString(message.session_id);
    if (newSessionId) {
      state.sessionId = newSessionId;
      try { transport?.setResumeSessionId?.(newSessionId); } catch { /* best-effort */ }
    }
    const initCwd = readString(message.cwd);
    if (initCwd) state.sessionCwd = initCwd;

    if (!state.threadId) {
      state.threadId = generateThreadId();
    }

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
        provider: "claude",
        model: readString(message.model),
        permissionMode: readString(message.permissionMode),
        cwd: state.sessionCwd,
        tools: Array.isArray(message.tools) ? message.tools.slice(0, 200) : [],
        slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands.slice(0, 200) : [],
        skills: Array.isArray(message.skills) ? message.skills.slice(0, 200) : [],
        agents: Array.isArray(message.agents) ? message.agents.slice(0, 100) : [],
        outputStyle: readString(message.output_style),
        version: readString(message.claude_code_version),
      });
    }

    if (state.activeTurnId && !state.didEmitTurnStarted) {
      emitTurnStarted(state.activeTurnId);
    }
    return null;
  }

  function handleStreamEvent(envelope) {
    const event = envelope?.event;
    if (!event || typeof event !== "object") return null;
    const evType = readString(event.type);

    if (evType === "message_start") {
      const inner = event.message;
      const messageId = inner && typeof inner === "object" ? readString(inner.id) : "";
      if (messageId && messageId !== state.lastAssistantMessageId) {
        state.lastAssistantMessageId = messageId;
        state.activeAssistantItemId = "";
        state.assistantTextAccumulator = "";
        state.reasoningItemId = "";
        state.reasoningAccumulator = "";
        state.blocksByIndex.clear();
      }
      return null;
    }

    if (evType === "content_block_start") {
      handleContentBlockStart(event);
      return null;
    }

    if (evType === "content_block_delta") {
      handleContentBlockDelta(event);
      return null;
    }

    if (evType === "message_delta") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
      if (usage) state.lastUsage = mergeUsage(state.lastUsage, usage);
      return null;
    }

    return null;
  }

  function handleAssistant(message) {
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;

    const messageId = readString(inner.id);
    if (messageId) state.lastAssistantMessageId = messageId;
    const usage = inner.usage && typeof inner.usage === "object" ? inner.usage : null;
    if (usage) state.lastUsage = mergeUsage(state.lastUsage, usage);

    const content = Array.isArray(inner.content) ? inner.content : [];
    if (content.length === 0) return null;

    if (!state.activeTurnId) {
      state.activeTurnId = generateTurnId();
    }
    if (!state.didEmitTurnStarted) {
      emitTurnStarted(state.activeTurnId);
    }

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const partType = readString(part.type);
      if (partType === "text") {
        emitAssistantTextFallback(part);
      } else if (partType === "thinking") {
        emitThinkingFallback(part);
      } else if (partType === "tool_use") {
        toolEmitter.emitToolUseStart(part);
      }
    }

    return null;
  }

  function handleRateLimitEvent(envelope) {
    const info = envelope?.rate_limit_info && typeof envelope.rate_limit_info === "object"
      ? envelope.rate_limit_info
      : null;
    if (!info || !state.threadId) return null;
    emitNotification("thread/status/changed", {
      threadId: state.threadId,
      thread_id: state.threadId,
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
    const inner = message.message;
    if (!inner || typeof inner !== "object") return null;
    const content = Array.isArray(inner.content) ? inner.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (readString(part.type) === "tool_result") {
        toolEmitter.emitToolResult(part);
      }
    }
    return null;
  }

  function handleResult(message) {
    const finalText = readString(message.result);
    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (usage) state.lastUsage = usage;
    const newSessionId = readString(message.session_id);
    if (newSessionId && !state.sessionId) state.sessionId = newSessionId;

    if (state.activeTurnId && state.threadId) {
      emitFinalAssistantItems({ finalText, message });
      if (readString(message.subtype) === "error" || message.is_error === true) {
        emitErrorNotification(state.activeTurnId, readString(message.error?.message) || "claude reported a turn error");
      }
      emitTurnCompleted(state.activeTurnId);
    }

    resetTurnState();
    return null;
  }

  function handleContentBlockStart(event) {
    const index = numberOr(event.index, -1);
    if (index < 0) return;
    const block = event.content_block || {};
    const blockType = readString(block.type);
    if (blockType === "text") {
      const itemId = ensureAssistantItemId();
      state.blocksByIndex.set(index, { kind: "text", itemId });
    } else if (blockType === "thinking") {
      const itemId = ensureReasoningItemId();
      state.blocksByIndex.set(index, { kind: "thinking", itemId });
    } else if (blockType === "tool_use") {
      state.blocksByIndex.set(index, {
        kind: "tool_use",
        toolUseId: readString(block.id),
        toolName: readString(block.name),
      });
    }
  }

  function handleContentBlockDelta(event) {
    const index = numberOr(event.index, -1);
    const block = state.blocksByIndex.get(index);
    if (!block) return;
    const delta = event.delta || {};
    const deltaType = readString(delta.type);

    if (deltaType === "text_delta" && block.kind === "text") {
      const text = readString(delta.text);
      if (!text) return;
      emitNotification("item/agentMessage/delta", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId: block.itemId,
        delta: text,
      });
      state.assistantTextAccumulator += text;
    } else if (deltaType === "thinking_delta" && block.kind === "thinking") {
      const text = readString(delta.thinking) || readString(delta.text);
      if (!text) return;
      emitNotification("item/reasoning/textDelta", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId: block.itemId,
        delta: text,
      });
      state.reasoningAccumulator += text;
    }
  }

  function emitAssistantTextFallback(part) {
    const text = readString(part.text);
    if (!text || state.assistantTextAccumulator.length >= text.length) return;
    const newText = text.startsWith(state.assistantTextAccumulator)
      ? text.slice(state.assistantTextAccumulator.length)
      : text;
    const itemId = ensureAssistantItemId();
    emitNotification("item/agentMessage/delta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId,
      delta: newText,
    });
    state.assistantTextAccumulator = text;
  }

  function emitThinkingFallback(part) {
    const reasoning = readString(part.thinking) || readString(part.text);
    if (!reasoning || state.reasoningAccumulator.length >= reasoning.length) return;
    const newReasoning = reasoning.startsWith(state.reasoningAccumulator)
      ? reasoning.slice(state.reasoningAccumulator.length)
      : reasoning;
    const itemId = ensureReasoningItemId();
    emitNotification("item/reasoning/textDelta", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId,
      delta: newReasoning,
    });
    state.reasoningAccumulator = reasoning;
  }

  function emitFinalAssistantItems({ finalText, message }) {
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

    if (state.reasoningItemId && state.reasoningAccumulator) {
      emitNotification("item/completed", {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        itemId: state.reasoningItemId,
        item: {
          id: state.reasoningItemId,
          itemId: state.reasoningItemId,
          type: "reasoning",
          text: state.reasoningAccumulator,
        },
      });
    }

    if (state.lastUsage) {
      emitNotification("thread/tokenUsage/updated", {
        threadId: state.threadId,
        tokenUsage: {
          inputTokens: numberOr(state.lastUsage.input_tokens, 0),
          outputTokens: numberOr(state.lastUsage.output_tokens, 0),
          cachedInputTokens: numberOr(state.lastUsage.cache_read_input_tokens, 0),
          cachedCreationInputTokens: numberOr(state.lastUsage.cache_creation_input_tokens, 0),
          totalCostUsd: numberOr(message.total_cost_usd, 0),
        },
      });
    }
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

  function ensureReasoningItemId() {
    if (state.reasoningItemId) return state.reasoningItemId;
    state.reasoningItemId = generateItemId("thinking");
    emitNotification("item/started", {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      itemId: state.reasoningItemId,
      item: {
        id: state.reasoningItemId,
        itemId: state.reasoningItemId,
        type: "reasoning",
      },
    });
    return state.reasoningItemId;
  }

  return {
    handleAssistant,
    handleRateLimitEvent,
    handleResult,
    handleStreamEvent,
    handleSystem,
    handleUser,
  };
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
  createClaudeStreamHandlers,
};
