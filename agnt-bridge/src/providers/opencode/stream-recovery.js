const { turnIdForMessage } = require("./mappers");

function createOpencodeStreamRecovery({ state, transport, streamHandlers }) {
  let revision = 0;
  let stopped = false;
  function invalidate() { revision += 1; }
  async function refresh() {
    const threadId = state.activeThreadId;
    const turnId = state.activeTurnId;
    if (!threadId || !turnId || !state.activeTurnAccepted || stopped) return;
    const expected = ++revision;
    const current = () => !stopped && revision === expected
      && state.activeThreadId === threadId && state.activeTurnId === turnId;
    try {
      const session = await transport.httpRequest("GET", `/session/${encodeURIComponent(threadId)}`);
      if (!current()) return;
      transport.remember(session.json);
      const [status, history] = await Promise.all([
        transport.httpRequest("GET", "/session/status", undefined, session.json?.directory),
        transport.httpRequest("GET", `/session/${encodeURIComponent(threadId)}/message`),
      ]);
      if (!current()) return;
      const messages = Array.isArray(history.json) ? history.json : [];
      // Only replay the current assistant; never replay an earlier turn as live output.
      const latestUser = messages.findLastIndex((message) => message?.info?.role === "user");
      const activeMessages = latestUser >= 0 && messages[latestUser].info.id === state.activeUserMessageId
        ? messages.slice(latestUser + 1) : [];
      for (const message of activeMessages) {
        if (message?.info?.role !== "assistant") continue;
        streamHandlers.handleMessageUpdated({ info: message.info });
        for (const part of message.parts || []) streamHandlers.handleMessagePartUpdated({ part });
      }
      if (!current() || !status.json || Array.isArray(status.json)) return;
      const type = status.json[threadId]?.type || "idle";
      streamHandlers.handleSessionStatus({ status: { type } });
    } catch {
      // An unavailable status snapshot is not evidence that the turn ended.
    }
  }
  async function restoreThread(threadId, session, messages, expected) {
    const current = () => !stopped && revision === expected && !state.activeTurnId
      && state.activeThreadId === threadId;
    if (!current()) return;
    try {
      const response = await transport.httpRequest("GET", "/session/status", undefined, session?.directory);
      if (!current() || !["busy", "retry"].includes(response.json?.[threadId]?.type)) return;
      // Metadata-only reads can contain just an assistant. Find the actual user anchor
      // before restoring ownership so Stop and overlap rejection use a stable turn ID.
      if (!messages.some((message) => message?.info?.role === "user")) {
        const history = await transport.httpRequest("GET", `/session/${encodeURIComponent(threadId)}/message`);
        if (!current()) return;
        messages = Array.isArray(history.json) ? history.json : [];
      }
      const index = messages.findLastIndex((message) => message?.info?.role === "user");
      const userId = messages[index]?.info?.id;
      if (!userId || !current()) return;
      state.activeTurnId = turnIdForMessage(userId);
      state.activeUserMessageId = userId;
      state.activeTurnAccepted = true;
      state.didEmitTurnCompletedForActive = false;
      streamHandlers.restoreTurnMessages(messages.slice(index));
    } catch {
      // Failed reads cannot establish ownership or prove a running turn completed.
    }
  }
  return { invalidate, refresh, restoreThread, checkpoint: () => ++revision,
    stop() { stopped = true; invalidate(); } };
}

module.exports = { createOpencodeStreamRecovery };
