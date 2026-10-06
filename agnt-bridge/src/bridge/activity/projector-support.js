const { normalizeToken, readString } = require("../../desktop/desktop-ipc-shared");
const DESKTOP_IPC_SOURCE = "desktop-ipc";
const MAX_TERMINAL_TURN_IDS = 64;
const MAX_DISPLAY_TEXT_CHARS = 160;

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/fileRead/requestApproval",
  "item/permissions/requestApproval",
]);
const USER_INPUT_METHODS = new Set([
  "item/tool/requestUserInput",
  "tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
function projectDesktopThreadActivity(threadId, state, sourceGeneration) {
  const rawState = state && typeof state === "object" ? state : {};
  const turns = Array.isArray(rawState.turns) ? rawState.turns : [];
  const requests = Array.isArray(rawState.requests) ? rawState.requests : [];
  const activeTurnIds = [];
  const activeTurns = [];
  let runningWithoutTurnId = false;
  for (const turn of turns) {
    if (!isActiveStatus(turn?.status)) {
      continue;
    }
    const turnId = desktopTurnId(turn);
    if (turnId) {
      activeTurnIds.push(turnId);
      activeTurns.push(compactObject({ turnId, startedAtMs: desktopTimestampMs(turn, "started") }));
    } else {
      runningWithoutTurnId = true;
    }
  }
  const approvalCount = requests.filter(isPendingApprovalRequest).length;
  const userInputCount = requests.filter(isPendingUserInputRequest).length;
  const runtimeStatus = rawState.threadRuntimeStatus || rawState.status;
  // Explicit runtime idle can invalidate stale inProgress history, but cannot
  // turn that history into evidence of successful completion.
  const explicitIdle = normalizeRuntime(runtimeStatus) === "idle";
  if (explicitIdle) {
    activeTurnIds.length = 0;
    activeTurns.length = 0;
    runningWithoutTurnId = false;
  }
  const runtime = activeTurnIds.length > 0 || runningWithoutTurnId
    ? "active"
    : normalizeRuntime(runtimeStatus);
  runningWithoutTurnId ||= runtime === "active" && activeTurnIds.length === 0;
  return compactEntry({
    threadId,
    source: DESKTOP_IPC_SOURCE,
    title: readString(rawState.title) || readString(rawState.name),
    cwd: readString(rawState.cwd) || readString(rawState.current_working_directory),
    runtime,
    activeTurnIds,
    activeTurns,
    runningWithoutTurnId,
    ...attentionFields(approvalCount, userInputCount, runtimeActiveFlags(runtimeStatus)),
    desktopUnread: projectDesktopUnread(rawState),
    lastOutcome: projectLatestDesktopOutcome(turns),
    latestItem: projectLatestDesktopItem(turns, runtime),
    freshness: "current",
    sourceGeneration: positiveInteger(sourceGeneration),
  });
}

function projectLatestDesktopOutcome(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnId = desktopTurnId(turn);
    const outcome = normalizeOutcome(turn?.status, turn?.error);
    if (!turnId || !outcome) {
      continue;
    }
    return compactObject({
      turnId,
      outcome,
      startedAtMs: desktopTimestampMs(turn, "started"),
      completedAtMs: desktopTimestampMs(turn, "completed"),
    });
  }
  return null;
}

function projectLatestDesktopItem(turns, runtime) {
  const turn = (runtime === "active" && turns.findLast((candidate) => isActiveStatus(candidate?.status)))
    || turns.at(-1);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = projectSemanticItem(items[itemIndex], {
      turnId: desktopTurnId(turn),
    });
    if (item) {
      return item;
    }
  }
  return null;
}

function projectSemanticItem(item, { turnId = "", lifecycle = "", lifecycleAtMs = null } = {}) {
  const itemId = readString(item?.id) || readString(item?.itemId) || readString(item?.item_id);
  const descriptor = semanticItemDescriptor(item?.type);
  if (!itemId || !descriptor) {
    return null;
  }
  const timingKey = lifecycle === "started"
    ? "startedAtMs"
    : lifecycle === "completed" ? "completedAtMs" : "";
  return compactObject({
    itemId,
    turnId,
    kind: descriptor.kind,
    label: descriptor.label,
    ...(timingKey && lifecycleAtMs != null ? { [timingKey]: lifecycleAtMs } : {}),
  });
}

function semanticItemDescriptor(type) {
  const token = normalizeToken(type);
  if (!token || token === "usermessage" || token === "hookprompt") {
    return null;
  }
  if (token === "reasoning" || token === "plan" || token === "todolist") {
    return { kind: "thinking", label: "Thinking" };
  }
  if (token.includes("command") || token.includes("exec")) {
    return { kind: "command", label: "Running command" };
  }
  if (token.includes("filechange") || token.includes("patch") || token.includes("apply")) {
    return { kind: "fileChange", label: "Editing files" };
  }
  if (token === "agentmessage" || token === "assistantmessage" || token === "message") {
    return { kind: "response", label: "Writing response" };
  }
  return { kind: "tool", label: "Using a tool" };
}

function projectTurnOutcome(turnId, turn, params, startedAtMs = null) {
  return compactObject({
    turnId,
    outcome: normalizeOutcome(turn.status || params.status, turn.error || params.error) || "completed",
    startedAtMs: timestampSecondsToMs(turn.startedAt ?? turn.started_at) ?? startedAtMs,
    completedAtMs: timestampSecondsToMs(turn.completedAt ?? turn.completed_at),
  });
}

function projectDesktopUnread(state) {
  const hasUnreadField = typeof state.hasUnreadTurn === "boolean"
    || typeof state.has_unread_turn === "boolean";
  const rawCount = state.unreadMessageCount ?? state.unread_message_count;
  const normalizedCount = finiteNumber(rawCount);
  const hasCountField = normalizedCount != null;
  if (!hasUnreadField && !hasCountField) {
    return null;
  }
  const unreadMessageCount = hasCountField ? Math.max(0, Math.floor(normalizedCount)) : 0;
  return {
    hasUnreadTurn: Boolean(state.hasUnreadTurn ?? state.has_unread_turn) || unreadMessageCount > 0,
    unreadMessageCount,
  };
}

function runtimeForAppServerState(state) {
  if (hasRunningWork(state)) {
    return "active";
  }
  return state.runtimeStatus === "active" ? "unknown" : state.runtimeStatus;
}

function normalizeRuntime(status) {
  const token = normalizeToken(typeof status === "object" ? status?.type : status);
  if (token === "active" || token === "running" || token === "inprogress" || token === "processing") {
    return "active";
  }
  if (token === "idle") {
    return "idle";
  }
  if (token === "systemerror" || token === "error" || token === "failed") {
    return "systemError";
  }
  return "unknown";
}

function normalizeOutcome(status, error) {
  const token = normalizeToken(status);
  if (token === "failed" || token === "error" || error) {
    return "failed";
  }
  if (["interrupted", "cancelled", "canceled", "stopped"].includes(token)) {
    return "interrupted";
  }
  if (token === "completed" || token === "complete" || token === "success" || token === "succeeded") {
    return "completed";
  }
  return "";
}

function isActiveStatus(status) {
  return normalizeRuntime(status) === "active";
}

function isPendingApprovalRequest(request) {
  return request?.completed !== true && APPROVAL_METHODS.has(readString(request?.method));
}

function isPendingUserInputRequest(request) {
  return request?.completed !== true && USER_INPUT_METHODS.has(readString(request?.method));
}

function runtimeActiveFlags(status) {
  if (normalizeRuntime(status) !== "active" || !Array.isArray(status?.activeFlags)) {
    return [];
  }
  return status.activeFlags.map(normalizeToken).filter((flag) => (
    flag === "waitingonapproval" || flag === "waitingonuserinput"
  )).sort();
}

function attentionFields(approvalCount, userInputCount, flags = []) {
  return {
    approvalRequired: approvalCount > 0 || flags.includes("waitingonapproval"),
    approvalRequestCount: approvalCount,
    userInputRequired: userInputCount > 0 || flags.includes("waitingonuserinput"),
    userInputRequestCount: userInputCount,
  };
}

function appServerThreadId(message) {
  const params = message?.params || {};
  return readString(params.threadId)
    || readString(params.thread_id)
    || readString(params.conversationId)
    || readString(params.conversation_id)
    || readString(params.thread?.id);
}

function turnIdentity(params, turn) {
  return readString(turn?.id)
    || readString(turn?.turnId)
    || readString(turn?.turn_id)
    || readString(params?.turnId)
    || readString(params?.turn_id);
}

function desktopTurnId(turn) {
  return readString(turn?.id) || readString(turn?.turnId) || readString(turn?.turn_id);
}

function desktopTimestampMs(turn, phase) {
  const prefix = phase === "started" ? "started" : "completed";
  return finiteNumber(
    turn?.[`${prefix}AtMs`]
      ?? turn?.[`turn${prefix[0].toUpperCase()}${prefix.slice(1)}AtMs`]
      ?? turn?.[`${prefix}_at_ms`]
      ?? turn?.[`turn_${prefix}_at_ms`]
  ) ?? timestampSecondsToMs(turn?.[`${prefix}At`] ?? turn?.[`${prefix}_at`]);
}

function timestampSecondsToMs(value) {
  const timestamp = finiteNumber(value);
  return timestamp == null ? null : timestamp * 1000;
}

function finiteNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function rememberTerminalTurn(state, turnId) {
  state.terminalTurnIds.delete(turnId);
  state.terminalTurnIds.add(turnId);
  while (state.terminalTurnIds.size > MAX_TERMINAL_TURN_IDS) {
    const oldestTurnId = state.terminalTurnIds.keys().next().value;
    state.terminalTurnIds.delete(oldestTurnId);
    state.turnOrderById.delete(oldestTurnId);
    state.turnStartedAtMsById.delete(oldestTurnId);
  }
}

function rememberAppServerState(states, state, maxThreads) {
  states.delete(state.threadId);
  states.set(state.threadId, state);
  while (states.size > maxThreads) {
    const evictable = [...states.values()].find((candidate) => !isProtectedAppState(candidate));
    if (!evictable) {
      return;
    }
    states.delete(evictable.threadId);
  }
}

function isProtectedAppState(state) {
  return hasRunningWork(state)
    || state.activeFlags.length > 0
    || state.approvalRequestIds.size > 0
    || state.userInputRequestIds.size > 0;
}

function hasRunningWork(state) {
  return state.activeTurnIds.size > 0 || state.runningWithoutTurnId;
}

function hasKnownTerminalWork(state) {
  return state.settledTurnlessWork
    || state.terminalTurnIds.size > 0
    || state.lastOutcome != null;
}

function replaceString(target, key, value) {
  const nextValue = key === "title" ? truncateDisplayText(readString(value)) : readString(value);
  if (!nextValue || target[key] === nextValue) {
    return false;
  }
  target[key] = nextValue;
  return true;
}

function truncateDisplayText(value) {
  if (value.length <= MAX_DISPLAY_TEXT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_DISPLAY_TEXT_CHARS - 1).trimEnd()}…`;
}

function compactEntry(entry) {
  return compactObject({
    ...entry,
    title: truncateDisplayText(readString(entry.title)),
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
  );
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

module.exports = { APPROVAL_METHODS, USER_INPUT_METHODS, projectDesktopThreadActivity, projectLatestDesktopOutcome, projectLatestDesktopItem, projectSemanticItem, semanticItemDescriptor, projectTurnOutcome, projectDesktopUnread, runtimeForAppServerState, normalizeRuntime, normalizeOutcome, isActiveStatus, isPendingApprovalRequest, isPendingUserInputRequest, runtimeActiveFlags, attentionFields, appServerThreadId, turnIdentity, desktopTurnId, desktopTimestampMs, timestampSecondsToMs, finiteNumber, positiveInteger, rememberTerminalTurn, rememberAppServerState, isProtectedAppState, hasRunningWork, hasKnownTerminalWork, replaceString, truncateDisplayText, compactEntry, compactObject, sameJSON };
