const { numberOr, readString } = require("../_shared/translator-utils");
const { mapMessagesToTurns, mapSessionToSummary, mapSessionToThread } = require("./mappers");

function createOpencodeThreadHandlers({ emitNotification, injectResponse, respondError, state, transport }) {
async function handleThreadStart(request) {
  try {
    const res = await transport.httpRequest("POST", "/session", {});
    const sessionId = readString(res?.json?.id);
    if (!sessionId) {
      respondError(request?.id, -32603, `opencode POST /session returned no id (status ${res?.status})`);
      return;
    }
    state.activeThreadId = sessionId;
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

async function handleThreadRead(request) {
  const params = request?.params || {};
  const targetThreadId = readString(params.threadId)
    || readString(params.thread_id)
    || state.activeThreadId;
  if (!targetThreadId) {
    respondError(request?.id, -32602, "thread/read requires a threadId");
    return;
  }
  state.activeThreadId = targetThreadId;
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
    || state.activeThreadId;
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
    || state.activeThreadId;
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
    || state.activeThreadId;
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
    || state.activeThreadId;
  if (!targetThreadId) {
    injectResponse(request.id, { threadId: state.activeThreadId, contextWindow: null });
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


  return {
    handleThreadStart,
    handleThreadRead,
    handleThreadTurnsList,
    handleThreadCompact,
    handleThreadFork,
    handleContextWindowRead,
    handleThreadList,
  };
}

module.exports = {
  createOpencodeThreadHandlers,
};
