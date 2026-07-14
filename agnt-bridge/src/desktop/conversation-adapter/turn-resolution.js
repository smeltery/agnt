// FILE: turn-resolution.js
// Purpose: Resolves app-server turn ids into stable Desktop conversation turn ids.
// Layer: CLI helper
// Depends on: crypto, ../desktop-ipc-shared

const { randomUUID } = require("crypto");

const {
  readString,
} = require("../desktop-ipc-shared");

function resolveTurnForConversation({
  conversation,
  turn,
  method,
  fallbackTurnIdsByThreadId,
  now = () => Date.now(),
} = {}) {
  const explicitTurnId = readTurnIdFromTurn(turn);
  if (explicitTurnId) {
    promoteFallbackTurnId(conversation, fallbackTurnIdsByThreadId, explicitTurnId);
    return turn;
  }

  const fallbackTurnId = readFallbackTurnId(conversation?.id, fallbackTurnIdsByThreadId)
    || (method === "turn/started" ? createSyntheticTurnId(conversation?.id, now) : "");
  if (!fallbackTurnId) {
    return turn;
  }
  fallbackTurnIdsByThreadId?.set(conversation.id, fallbackTurnId);
  if (method === "turn/completed") {
    fallbackTurnIdsByThreadId?.delete(conversation.id);
  }

  return {
    ...turn,
    id: fallbackTurnId,
    turnId: fallbackTurnId,
    agntSyntheticTurnId: true,
  };
}

function resolveTurnIdForParams({
  conversation,
  params,
  fallbackTurnIdsByThreadId,
  allowOptimisticFallback = true,
} = {}) {
  const explicitTurnId = readTurnIdFromParams(params);
  if (explicitTurnId) {
    promoteFallbackTurnId(conversation, fallbackTurnIdsByThreadId, explicitTurnId);
    return explicitTurnId;
  }
  const fallbackTurnId = readFallbackTurnId(conversation?.id, fallbackTurnIdsByThreadId);
  if (fallbackTurnId) {
    if (!allowOptimisticFallback && isOptimisticPendingTurnId(conversation, fallbackTurnId)) {
      return latestNonOptimisticTurnId(conversation) || "";
    }
    return fallbackTurnId;
  }
  if (!allowOptimisticFallback) {
    return latestNonOptimisticTurnId(conversation) || "";
  }
  return "";
}

function promoteFallbackTurnId(conversation, fallbackTurnIdsByThreadId, explicitTurnId) {
  const conversationId = readString(conversation?.id);
  const fallbackTurnId = readFallbackTurnId(conversationId, fallbackTurnIdsByThreadId);
  if (!conversationId || !fallbackTurnId || !explicitTurnId || fallbackTurnId === explicitTurnId) {
    fallbackTurnIdsByThreadId?.delete(conversationId);
    return;
  }

  const fallbackTurn = conversation.turns.find((candidate) => (
    readString(candidate?.turnId) || readString(candidate?.id)
  ) === fallbackTurnId);
  if (fallbackTurn) {
    fallbackTurn.id = explicitTurnId;
    fallbackTurn.turnId = explicitTurnId;
    delete fallbackTurn.agntSyntheticTurnId;
  }
  fallbackTurnIdsByThreadId?.delete(conversationId);
}

function readFallbackTurnId(threadId, fallbackTurnIdsByThreadId) {
  const normalizedThreadId = readString(threadId);
  return normalizedThreadId && fallbackTurnIdsByThreadId instanceof Map
    ? readString(fallbackTurnIdsByThreadId.get(normalizedThreadId))
    : "";
}

function isOptimisticPendingTurn(turn) {
  return turn?.agntOptimisticPendingTurn === true;
}

function isOptimisticPendingTurnId(conversation, turnId) {
  const normalizedTurnId = readString(turnId);
  if (!conversation || !normalizedTurnId || !Array.isArray(conversation.turns)) {
    return false;
  }
  return conversation.turns.some((turn) => (
    isOptimisticPendingTurn(turn)
      && (readString(turn?.turnId) || readString(turn?.id)) === normalizedTurnId
  ));
}

function latestNonOptimisticTurnId(conversation) {
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (isOptimisticPendingTurn(turn)) {
      continue;
    }
    const turnId = readString(turn?.turnId) || readString(turn?.id);
    if (turnId) {
      return turnId;
    }
  }
  return "";
}

function createSyntheticTurnId(threadId, now = () => Date.now()) {
  const normalizedThreadId = readString(threadId) || "thread";
  return `agnt-live-turn:${normalizedThreadId}:${now()}:${randomUUID()}`;
}

function readTurnIdFromParams(params) {
  return readString(params?.turnId)
    || readString(params?.turn_id)
    || readString(params?.turn?.id)
    || readString(params?.turn?.turnId)
    || readString(params?.turn?.turn_id);
}

function readTurnIdFromTurn(turn) {
  return readString(turn?.id)
    || readString(turn?.turnId)
    || readString(turn?.turn_id);
}

module.exports = {
  readTurnIdFromParams,
  readTurnIdFromTurn,
  resolveTurnForConversation,
  resolveTurnIdForParams,
};
