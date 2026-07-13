// FILE: rollout-live-mirror-bootstrap.js
// Purpose: Replays existing desktop rollout content for live mirror bootstrap.
// Layer: CLI helper
// Exports: bootstrapFromExistingRollout, terminalEventClosesTrackedTurn
// Depends on: rollout-live-mirror-utils

const {
  createNotification,
  isDesktopRolloutOrigin,
  readFileSlice,
  readString,
  safeParseJSON,
} = require("./rollout-live-mirror-utils");

const TERMINAL_TASK_EVENT_TYPES = new Set(["task_complete", "turn_aborted", "error"]);

function terminalEventClosesTrackedTurn(eventTurnId, trackedTurnId) {
  return !eventTurnId || !trackedTurnId || eventTurnId === trackedTurnId;
}

function bootstrapFromExistingRollout({
  rolloutPath,
  fileSize,
  state,
  fsModule,
  sendApplicationResponse,
  processRolloutLines,
  nowMs = Date.now(),
  staleActiveRunMaxAgeMs,
}) {
  const initialContents = readFileSlice(rolloutPath, 0, fileSize, fsModule);
  if (!initialContents) {
    return;
  }

  const activeRunLines = [];
  let insideActiveRun = false;
  let activeTurnId = null;
  let latestTerminalRun = null;
  let pendingUserPreludeLine = null;

  for (const rawLine of initialContents.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const parsed = safeParseJSON(line);
    if (!parsed) {
      continue;
    }

    if (parsed.type === "session_meta") {
      populateBootstrapSessionMetaState(state, parsed.payload);
    }

    const taskEventType = parsed?.type === "event_msg"
      ? readString(parsed?.payload?.type)
      : "";
    if (taskEventType === "user_message") {
      pendingUserPreludeLine = line;
    }
    if (taskEventType === "task_started") {
      insideActiveRun = true;
      activeTurnId = readString(parsed?.payload?.turn_id)
        || readString(parsed?.payload?.turnId)
        || "";
      latestTerminalRun = null;
      activeRunLines.length = 0;
      if (pendingUserPreludeLine) {
        activeRunLines.push(pendingUserPreludeLine);
      }
      activeRunLines.push(line);
      continue;
    }

    if (!insideActiveRun) {
      continue;
    }

    activeRunLines.push(line);
    if (TERMINAL_TASK_EVENT_TYPES.has(taskEventType)) {
      const terminalTurnId = readString(parsed?.payload?.turn_id)
        || readString(parsed?.payload?.turnId);
      if (terminalEventClosesTrackedTurn(terminalTurnId, activeTurnId)) {
        latestTerminalRun = terminalRunFromEvent(parsed, activeTurnId);
        insideActiveRun = false;
        activeTurnId = "";
        activeRunLines.length = 0;
        pendingUserPreludeLine = null;
      }
    }
  }

  if (!isDesktopRolloutOrigin(state.sessionMeta)) {
    state.isDesktopOrigin = false;
    return;
  }

  state.isDesktopOrigin = true;
  if (activeRunLines.length === 0 && latestTerminalRun) {
    sendApplicationResponse(JSON.stringify(terminalCatchUpNotification(state.threadId, latestTerminalRun)));
    return;
  }

  if (activeTurnId) {
    state.activeTurnId = activeTurnId;
  }

  if (
    activeRunLines.length > 0
    && isRolloutFileStale(rolloutPath, fsModule, nowMs, staleActiveRunMaxAgeMs)
  ) {
    state.suppressLiveActivityUntilGrowth = true;
    processRolloutLines(activeRunLines, state, () => {});
    return;
  }

  processRolloutLines(activeRunLines, state, sendApplicationResponse);
}

function populateBootstrapSessionMetaState(state, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  state.sessionMeta = {
    originator: readString(payload.originator),
    source: readString(payload.source),
    cwd: readString(payload.cwd),
  };
}

function isRolloutFileStale(rolloutPath, fsModule, nowMs, staleActiveRunMaxAgeMs) {
  try {
    const modifiedAtMs = fsModule.statSync(rolloutPath).mtimeMs;
    return Number.isFinite(modifiedAtMs) && nowMs - modifiedAtMs >= staleActiveRunMaxAgeMs;
  } catch {
    return false;
  }
}

function terminalRunFromEvent(entry, fallbackTurnId = "") {
  const payload = entry?.payload || {};
  const eventType = readString(payload.type);
  if (!TERMINAL_TASK_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const turnId = readString(payload.turn_id)
    || readString(payload.turnId)
    || readString(fallbackTurnId);
  if (!turnId) {
    return null;
  }

  return {
    eventType,
    turnId,
    message: readString(payload.message),
  };
}

function terminalCatchUpNotification(threadId, terminalRun) {
  const params = {
    threadId,
    turnId: terminalRun.turnId,
    id: terminalRun.turnId,
    agntRolloutTerminalCatchUp: true,
  };
  if (terminalRun.eventType === "turn_aborted") {
    params.status = "aborted";
  } else if (terminalRun.eventType === "error") {
    params.status = "failed";
    if (terminalRun.message) {
      params.error = { message: terminalRun.message };
    }
  }
  return createNotification("turn/completed", params);
}

module.exports = {
  bootstrapFromExistingRollout,
  terminalEventClosesTrackedTurn,
};
