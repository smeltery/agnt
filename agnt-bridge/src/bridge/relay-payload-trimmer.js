// FILE: relay-payload-trimmer.js
// Purpose: Sibling of turns-list-pager. Where the pager shrinks
//          `thread/turns/list` *responses*, this module shrinks
//          `thread/read` *payloads* — full thread snapshots that ship
//          history.turns wholesale. The trim ladder is:
//            1. fits under cap → no-op
//            2. drop oldest turns down to the recent-N target, then peel
//               turns one at a time, each pass prepending a synthetic
//               `agnt-history-compacted-*` summary turn so the iPhone
//               still sees the gap
//            3. if only the newest turn is left and it's still over cap,
//               drop items off the front of that turn one at a time
//            4. if a single item is left, text-tail-truncate it
//            5. if that still doesn't fit, hard-compact the item with
//               `compactHistoryItemForRelay`
//          Used by `sanitizeThreadHistoryImagesForRelay` for
//          single-thread payloads and `sanitizeThreadTurnsListForRelay`
//          for paged-list payloads.
// Layer: Bridge support (pure)
// Exports:
//   - trimThreadPayloadForRelay
//   - trimTurnsListPayloadForRelay
//   - buildRelayHistoryCompactionTurn (re-exported for tests)
//   - RELAY_HISTORY_RECENT_TURN_TARGET
// Depends on: ./turns-list-pager (compactHistoryItemForRelay,
//             truncateRelayTextTail, byte+text-tail caps)

const {
  RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
  RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
  compactHistoryItemForRelay,
  truncateRelayTextTail,
} = require("./turns-list-pager");

const RELAY_HISTORY_RECENT_TURN_TARGET = 40;

function readString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value) {
  const str = readString(value).trim();
  return str.length > 0 ? str : "";
}

function trimThreadPayloadForRelay(parsed, explicitThread = undefined, options = {}) {
  const thread = explicitThread ?? parsed?.result?.thread;
  if (!parsed || !thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    return null;
  }

  const preOmittedTurnCount = Math.max(0, options.preOmittedTurnCount ?? 0);
  const compactionIdSource = options.compactionIdSource ?? null;

  let workingThread = thread;
  let encoded = encodeRelayThreadPayload(parsed, workingThread);
  if (encoded == null) {
    return null;
  }

  if (Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    if (preOmittedTurnCount <= 0) {
      return explicitThread === undefined ? null : encoded;
    }
    const compactedThread = buildRelayHistoryCompactedThread(
      thread,
      buildRelayCompactedHistoryTurns(thread.turns, thread.turns, preOmittedTurnCount, compactionIdSource),
      preOmittedTurnCount,
      thread.turns.length
    );
    return encodeRelayThreadPayload(parsed, compactedThread) ?? encoded;
  }

  const turns = thread.turns;
  let trimmedTurns = turns.length > RELAY_HISTORY_RECENT_TURN_TARGET
    ? turns.slice(-RELAY_HISTORY_RECENT_TURN_TARGET)
    : turns.slice();
  while (trimmedTurns.length > 1) {
    if (trimmedTurns.length === turns.length) {
      trimmedTurns = trimmedTurns.slice(1);
    }
    const candidateThread = buildRelayHistoryCompactedThread(
      thread,
      buildRelayCompactedHistoryTurns(turns, trimmedTurns, preOmittedTurnCount, compactionIdSource),
      preOmittedTurnCount + Math.max(0, turns.length - trimmedTurns.length),
      trimmedTurns.length
    );
    encoded = encodeRelayThreadPayload(parsed, candidateThread);
    if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return encoded;
    }
    workingThread = candidateThread;
    trimmedTurns = trimmedTurns.slice(1);
  }

  const newestTurn = trimmedTurns[0];
  if (!newestTurn || typeof newestTurn !== "object" || !Array.isArray(newestTurn.items)) {
    return encodeRelayThreadPayload(parsed, workingThread);
  }

  let trimmedItems = newestTurn.items.slice();
  while (trimmedItems.length > 1) {
    trimmedItems = trimmedItems.slice(1);
    const compactedTurnPrefix = buildRelayHistoryCompactionTurn(
      preOmittedTurnCount + Math.max(0, turns.length - 1),
      1,
      compactionIdSource ?? thread
    );
    const candidateThread = buildRelayHistoryCompactedThread(
      thread,
      compactedTurnPrefix ? [compactedTurnPrefix, {
        ...newestTurn,
        items: trimmedItems,
      }] : [{
        ...newestTurn,
        items: trimmedItems,
      }],
      preOmittedTurnCount + Math.max(0, turns.length - 1),
      1
    );
    encoded = encodeRelayThreadPayload(parsed, candidateThread);
    if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return encoded;
    }
    workingThread = candidateThread;
  }

  const mostRecentItem = trimmedItems[0];
  if (!mostRecentItem || typeof mostRecentItem !== "object") {
    return encodeRelayThreadPayload(parsed, workingThread);
  }

  const truncatedItem = truncateHistoryItemTextForRelay(
    mostRecentItem,
    RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS
  );
  let candidateThread = buildRelayHistoryCompactedThread(
    thread,
    [
      ...buildRelayCompactedHistoryTurns(turns, [newestTurn], preOmittedTurnCount, compactionIdSource).slice(0, -1),
      {
        ...newestTurn,
        items: [truncatedItem],
      },
    ],
    preOmittedTurnCount + Math.max(0, turns.length - 1),
    1
  );
  encoded = encodeRelayThreadPayload(parsed, candidateThread);
  if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    return encoded;
  }

  candidateThread = buildRelayHistoryCompactedThread(
    thread,
    [
      ...buildRelayCompactedHistoryTurns(turns, [newestTurn], preOmittedTurnCount, compactionIdSource).slice(0, -1),
      {
        ...newestTurn,
        items: [compactHistoryItemForRelay(mostRecentItem, RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS)],
      },
    ],
    preOmittedTurnCount + Math.max(0, turns.length - 1),
    1
  );
  return encodeRelayThreadPayload(parsed, candidateThread);
}

function trimTurnsListPayloadForRelay(parsed, turnsKey, originalRawMessage = null) {
  const result = parsed?.result;
  const turns = result?.[turnsKey];
  if (!parsed || !result || !Array.isArray(turns)) {
    return originalRawMessage ?? JSON.stringify(parsed);
  }

  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    return originalRawMessage ?? encoded;
  }

  let fallbackCompactedPayload = null;
  for (const maxChars of [
    RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
    Math.floor(RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS / 4),
    1_000,
    0,
  ]) {
    const compactedTurns = turns.map((turn) => compactTurnsListTurnForRelay(turn, maxChars));
    const compactedPayload = JSON.stringify({
      ...parsed,
      result: {
        ...result,
        [turnsKey]: compactedTurns,
        agntPageCompactedForRelay: true,
      },
    });
    fallbackCompactedPayload = compactedPayload;
    if (Buffer.byteLength(compactedPayload, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return compactedPayload;
    }
  }

  return fallbackCompactedPayload ?? (originalRawMessage ?? encoded);
}

function compactTurnsListTurnForRelay(turn, maxChars) {
  if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
    return turn;
  }

  return {
    ...turn,
    items: turn.items.map((item) => compactHistoryItemForRelay(item, maxChars)),
    agntPageCompactedForRelay: true,
  };
}

function buildRelayHistoryCompactedThread(thread, turns, omittedTurnCount, keptTurnCount) {
  return {
    ...thread,
    turns,
    historyTailTruncatedForRelay: true,
    agntHistoryCompacted: omittedTurnCount > 0,
    agntOmittedTurnCount: omittedTurnCount,
    agntKeptTurnCount: keptTurnCount,
  };
}

function buildRelayCompactedHistoryTurns(allTurns, keptTurns, preOmittedTurnCount = 0, idSourceOverride = null) {
  const omittedTurnCount = preOmittedTurnCount + Math.max(0, allTurns.length - keptTurns.length);
  const compactionTurn = buildRelayHistoryCompactionTurn(
    omittedTurnCount,
    keptTurns.length,
    idSourceOverride ?? allTurns[0]
  );
  return compactionTurn ? [compactionTurn, ...keptTurns] : keptTurns;
}

function buildRelayHistoryCompactionTurn(omittedTurnCount, keptTurnCount, idSource = {}) {
  if (omittedTurnCount <= 0) {
    return null;
  }

  const baseId = normalizeNonEmptyString(idSource?.id)
    || normalizeNonEmptyString(idSource?.turnId)
    || normalizeNonEmptyString(idSource?.turn_id)
    || "history";
  const text = [
    "Earlier conversation compacted for mobile loading.",
    "",
    `Older turns omitted: ${omittedTurnCount}`,
    `Recent turns kept: ${keptTurnCount}`,
    "Full history remains available on the Mac runtime.",
  ].join("\n");

  return {
    id: `agnt-history-compacted-${baseId}`,
    agntSynthetic: true,
    agntHistoryCompacted: true,
    agntOmittedTurnCount: omittedTurnCount,
    agntKeptTurnCount: keptTurnCount,
    items: [
      {
        id: `agnt-history-compacted-item-${baseId}`,
        type: "assistant_message",
        role: "assistant",
        text,
        agntSynthetic: true,
        agntHistoryCompacted: true,
      },
    ],
  };
}

function encodeRelayThreadPayload(parsed, thread) {
  try {
    return JSON.stringify({
      ...parsed,
      result: {
        ...parsed.result,
        thread,
      },
    });
  } catch {
    return null;
  }
}

function truncateHistoryItemTextForRelay(item, maxChars) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  let didChange = false;
  let nextItem = item;
  const textKeys = ["text", "message", "summary", "output", "outputText", "output_text"];

  for (const key of textKeys) {
    if (typeof item[key] === "string" && item[key].length > maxChars) {
      nextItem = {
        ...nextItem,
        [key]: truncateRelayTextTail(item[key], maxChars),
      };
      didChange = true;
    }
  }

  if (Array.isArray(item.content)) {
    const nextContent = item.content.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }

      const truncatedEntry = truncateHistoryItemTextForRelay(entry, maxChars);
      if (truncatedEntry !== entry) {
        didChange = true;
      }
      return truncatedEntry;
    });

    if (didChange) {
      nextItem = {
        ...nextItem,
        content: nextContent,
      };
    }
  }

  return didChange
    ? {
      ...nextItem,
      relayTextTailTruncated: true,
    }
    : item;
}

module.exports = {
  RELAY_HISTORY_RECENT_TURN_TARGET,
  trimThreadPayloadForRelay,
  trimTurnsListPayloadForRelay,
  buildRelayHistoryCompactionTurn,
};
