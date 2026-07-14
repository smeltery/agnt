// FILE: delta-notifications.js
// Purpose: Applies streaming item delta notifications to Desktop conversation turns.
// Layer: CLI helper
// Depends on: ../desktop-ipc-shared, ./turn-resolution

const {
  normalizeToken,
  readString,
} = require("../desktop-ipc-shared");
const {
  resolveTurnIdForParams,
} = require("./turn-resolution");

function applyDeltaNotification(conversation, method, params, {
  ensureTurn,
  fallbackTurnIdsByThreadId = null,
  allowOptimisticFallback = true,
  now = () => Date.now(),
} = {}) {
  const turn = ensureTurn(conversation, resolveTurnIdForParams({
    conversation,
    params,
    fallbackTurnIdsByThreadId,
    allowOptimisticFallback,
    now,
  }), { now, allowLastTurnFallback: allowOptimisticFallback });
  if (!turn) {
    return;
  }
  const itemId = readString(params.itemId) || readString(params.item_id);
  if (!itemId) {
    return;
  }
  const delta = typeof params.delta === "string" ? params.delta : "";
  if (!delta) {
    return;
  }

  turn.firstTurnWorkItemStartedAtMs = turn.firstTurnWorkItemStartedAtMs || now();

  if (method === "item/agentMessage/delta") {
    const item = ensureItemOfType(turn, itemId, () => ({
      type: "agentMessage",
      id: itemId,
      text: "",
      phase: null,
      memoryCitation: null,
    }));
    item.text = `${item.text || ""}${delta}`;
    turn.finalAssistantStartedAtMs = turn.finalAssistantStartedAtMs || now();
    return;
  }

  if (method === "item/plan/delta") {
    const item = ensureItemOfType(turn, itemId, () => ({
      type: "plan",
      id: itemId,
      text: "",
    }));
    item.text = `${item.text || ""}${delta}`;
    return;
  }

  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    const item = ensureItemOfType(turn, itemId, () => ({
      type: "reasoning",
      id: itemId,
      summary: [],
      content: [],
    }));
    if (method === "item/reasoning/summaryTextDelta") {
      const index = Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
      item.summary = growArray(item.summary, index, "");
      item.summary[index] = `${item.summary[index] || ""}${delta}`;
    } else {
      const index = Number.isInteger(params.contentIndex) ? params.contentIndex : 0;
      item.content = growArray(item.content, index, "");
      item.content[index] = `${item.content[index] || ""}${delta}`;
    }
    return;
  }

  if (method === "item/fileChange/outputDelta") {
    const item = ensureItemOfType(turn, itemId, () => ({
      type: "fileChange",
      id: itemId,
      changes: [],
      status: "inProgress",
      aggregatedOutput: "",
    }));
    item.aggregatedOutput = `${item.aggregatedOutput || ""}${delta}`;
    return;
  }

  const item = ensureItemOfType(turn, itemId, () => ({
    type: "commandExecution",
    id: itemId,
    command: "",
    cwd: conversation.cwd || "/",
    processId: null,
    source: "exec",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: "",
    exitCode: null,
    durationMs: null,
  }));
  item.aggregatedOutput = `${item.aggregatedOutput || ""}${delta}`;
}

function ensureItemOfType(turn, itemId, createItem) {
  let item = turn.items.find((candidate) => readString(candidate?.id) === itemId);
  if (!item) {
    item = createItem();
    turn.items.push(item);
  }
  return item;
}

function growArray(value, index, fillValue) {
  const next = Array.isArray(value) ? value : [];
  while (next.length <= index) {
    next.push(fillValue);
  }
  return next;
}

function isFileChangeLikeItemType(value) {
  const itemType = normalizeToken(value);
  return itemType === "filechange" || itemType === "diff";
}

module.exports = {
  applyDeltaNotification,
  isFileChangeLikeItemType,
};
