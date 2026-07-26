// FILE: turn-state-probe.js
// Purpose: Helpers for stabilizing the lightweight running-turn probe.
// Layer: Bridge support
// Depends on: ../desktop/desktop-ipc-shared

const {
  isThreadTurnStateProbeRequest,
  readString,
} = require("../desktop/desktop-ipc-shared");

function annotateTurnStateProbeWithMirrorActiveTurn(request, response, getMirrorActiveTurnId) {
  if (!isThreadTurnStateProbeRequest(request)) {
    return response;
  }

  const params = request?.params || {};
  const threadId = readString(params.threadId) || readString(params.thread_id);
  const mirrorActiveTurnId = threadId ? getMirrorActiveTurnId?.(threadId) : null;
  const result = response?.result;
  if (!mirrorActiveTurnId || !result || typeof result !== "object" || Array.isArray(result)) {
    return response;
  }

  return {
    ...response,
    result: {
      ...result,
      agntMirrorActiveTurnId: mirrorActiveTurnId,
    },
  };
}

module.exports = {
  annotateTurnStateProbeWithMirrorActiveTurn,
};
