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
  return { invalidate, refresh, stop() { stopped = true; invalidate(); } };
}

module.exports = { createOpencodeStreamRecovery };
