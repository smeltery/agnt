// FILE: desktop-ipc-projection-status.js
// Purpose: Normalizes Desktop IPC thread, turn, and item lifecycle statuses for mobile projection.
// Layer: CLI helper
// Exports: projection status helpers
// Depends on: ./desktop-ipc-shared

const {
  cloneJSON,
  normalizeToken,
} = require("./desktop-ipc-shared");

function activeTurnIdFromTurns(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (isActiveTurnStatus(turn.status)) {
      return turn.id;
    }
  }
  return null;
}

function resolveThreadStatus(rawState, activeTurnId) {
  const explicitStatus = rawState?.threadRuntimeStatus ?? rawState?.thread_runtime_status;
  if (explicitStatus != null) {
    return cloneJSON(explicitStatus);
  }
  if (activeTurnId) {
    return {
      type: "active",
      activeFlags: [],
    };
  }
  return {
    type: "idle",
  };
}

function normalizeTurnStatus(value) {
  const token = normalizeToken(value);
  if (token === "inprogress" || token === "running" || token === "active" || token === "processing") {
    return "inProgress";
  }
  if (token === "interrupted" || token === "cancelled" || token === "canceled" || token === "stopped") {
    return "interrupted";
  }
  if (token === "failed" || token === "error" || token === "systemerror") {
    return "failed";
  }
  return "completed";
}

function isActiveTurnStatus(value) {
  return normalizeToken(value) === "inprogress"
    || normalizeToken(value) === "running"
    || normalizeToken(value) === "active"
    || normalizeToken(value) === "processing";
}

// Items without an explicit status (messages, reasoning) are complete as
// delivered; only explicitly running items must stay open for streaming.
function isTerminalItemState(item) {
  const status = normalizeToken(item?.status);
  if (!status) {
    return true;
  }
  return status !== "inprogress"
    && status !== "running"
    && status !== "active"
    && status !== "processing"
    && status !== "pending"
    && status !== "queued";
}

module.exports = {
  activeTurnIdFromTurns,
  isActiveTurnStatus,
  isTerminalItemState,
  normalizeTurnStatus,
  resolveThreadStatus,
};
