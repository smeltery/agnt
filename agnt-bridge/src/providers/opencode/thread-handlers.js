const { listSessionCatalog } = require("./session-catalog");
const { pageByAnchor } = require("./pagination");
const { numberOr, readString } = require("../_shared/translator-utils");
const { mapMessagesToTurns, mapSessionToSummary, mapSessionToThread } = require("./mappers");

function createOpencodeThreadHandlers({ emitNotification, injectResponse, respondError, state, transport, recovery }) {
async function handleThreadStart(request) {
  try {
    const res = await transport.httpRequest("POST", "/session", {}, request?.params?.cwd);
    const sessionId = readString(res?.json?.id);
    if (!sessionId) {
      respondError(request?.id, -32603, `opencode POST /session returned no id (status ${res?.status})`);
      return;
    }
    if (!state.activeTurnId) state.activeThreadId = sessionId;
    transport.remember(res.json);
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
  if (!state.activeTurnId) state.activeThreadId = targetThreadId;
  const checkpoint = recovery.checkpoint();
  try {
    const sessionRes = await transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}`);
    transport.remember(sessionRes.json);
    const messagesRes = await transport.httpRequest("GET", `/session/${encodeURIComponent(targetThreadId)}/message${params.excludeTurns === true ? "?limit=1" : ""}`);
    const session = sessionRes?.json || null;
    const messages = Array.isArray(messagesRes?.json) ? messagesRes.json : [];
    const thread = mapSessionToThread(session, { id: targetThreadId });
    thread.turns = mapMessagesToTurns(messages);
    const latest = [...messages].reverse().find((message) => message.info?.model || message.info?.modelID)?.info;
    if (latest && !state.sessionSettings.has(targetThreadId)) {
      state.sessionSettings.set(targetThreadId, {
        providerID: latest.model?.providerID || latest.providerID,
        modelID: latest.model?.modelID || latest.modelID,
        variant: latest.variant || "",
      });
    }
    await recovery.restoreThread(targetThreadId, session, messages, checkpoint);
    if (state.activeThreadId === targetThreadId && state.activeTurnId) {
      thread.status = { type: "active" };
      const active = thread.turns.find((turn) => turn.id === state.activeTurnId);
      if (active) active.status = "inProgress";
      else thread.turns.push({ id: state.activeTurnId, status: "inProgress", items: [] });
    }
    if (params.excludeTurns === true) thread.turns = [];
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
    const history = mapMessagesToTurns(messages);
    if (state.activeThreadId === targetThreadId) {
      const active = history.find((turn) => turn.id === state.activeTurnId);
      if (active) active.status = "inProgress";
    }
    const page = pageByAnchor(history, params);
    const turns = page.data;
    if (request?.id != null) {
      injectResponse(request.id, {
        threadId: targetThreadId,
        thread_id: targetThreadId,
        turns,
        ...page,
        page: { turns, nextCursor: page.nextCursor, hasMore: page.hasMore },
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
      state.sessionSettings.get(targetThreadId) || {},
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
    const params = request?.params || {};
    const sessions = (await listSessionCatalog(transport)).filter((session) => !session.parentID
      && Boolean(session.time?.archived) === Boolean(params.archived));
    const sorted = sessions.sort((a, b) => numberOr(a?.time?.updated, 0) - numberOr(b?.time?.updated, 0))
      .map((session) => mapSessionToSummary(session));
    const page = pageByAnchor(sorted, { ...params, limit: params.limit || 200 }, "session");
    if (request?.id != null) injectResponse(request.id, { ...page, threads: page.data });

  } catch (err) {
    respondError(request?.id, -32603, `opencode thread/list failed: ${err?.message || err}`);
  }
}

async function handleThreadUpdate(request) {
  const id = readString(request.params?.threadId) || state.activeThreadId;
  if (!id) return respondError(request.id, -32602, "A threadId is required");
  try {
    const route = `/session/${encodeURIComponent(id)}`;
    if (request.method === "thread/generateTitle") {
      const response = await transport.httpRequest("GET", route);
      injectResponse(request.id, { title: readString(response.json?.title) });
      return;
    }
    const name = readString(request.params?.name) || readString(request.params?.title);
    if (request.method === "thread/name/set" && !name) throw new Error("Thread title is empty");
    const body = request.method === "thread/name/set" ? { title: name }
      : { time: { archived: request.method === "thread/archive" ? Date.now() : 0 } };
    const response = await transport.httpRequest("PATCH", route, body);
    injectResponse(request.id, { thread: mapSessionToThread(response.json, { id }) });
    emitNotification(request.method === "thread/name/set" ? "thread/name/updated"
      : request.method === "thread/archive" ? "thread/archived" : "thread/unarchived", { threadId: id, ...(name ? { name } : {}) });
  } catch (error) {
    respondError(request.id, -32603, error.message);
  }
}


  return {
    handleThreadStart,
    handleThreadUpdate,
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
