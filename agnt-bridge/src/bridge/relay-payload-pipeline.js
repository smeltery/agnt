// FILE: relay-payload-pipeline.js
// Purpose: Orchestrator that glues the relay-image-sanitizer + relay-payload-
//          trimmer modules into the entry-point function bridge.js calls on
//          every relay-bound message. The pipeline:
//            1. For thread/turns/list responses → run the turns-list variant
//               that compacts every turn's items + trims to fit under cap.
//            2. For thread/read or thread/resume responses → walk turns,
//               annotate generated-image items with saved_path, elide inline
//               data: image URLs and bulky compaction blobs, then hand off
//               to trimThreadPayloadForRelay for the byte-cap shrink ladder.
//            3. For any other message → pass through unchanged.
//          Keeps bridge.js focused on orchestration by hiding the cross-
//          module wiring here.
// Layer: Bridge support (pure)
// Exports:
//   - sanitizeThreadHistoryImagesForRelay (entry)
//   - sanitizeThreadTurnsListForRelay (entry — re-exported for tests)
//   - sanitizeRelayHistoryTurns (helper — re-exported for tests)
//   - sanitizeRelayHistoryTurn (helper — re-exported for tests)
// Depends on:
//   - ./relay-image-sanitizer (annotateImageGenerationHistoryItem,
//     sanitizeInlineHistoryImageContentItem, sanitizeCompactionHistoryItem)
//   - ./relay-payload-trimmer (trimThreadPayloadForRelay,
//     trimTurnsListPayloadForRelay)

const {
  annotateImageGenerationHistoryItem,
  sanitizeInlineHistoryImageContentItem,
  sanitizeCompactionHistoryItem,
} = require("./relay-image-sanitizer");
const {
  trimThreadPayloadForRelay,
  trimTurnsListPayloadForRelay,
} = require("./relay-payload-trimmer");

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value) {
  const str = readString(value).trim();
  return str.length > 0 ? str : "";
}

function sanitizeThreadHistoryImagesForRelay(rawMessage, requestMethod) {
  if (requestMethod === "thread/turns/list") {
    return sanitizeThreadTurnsListForRelay(rawMessage);
  }

  if (requestMethod !== "thread/read" && requestMethod !== "thread/resume") {
    return rawMessage;
  }

  const parsed = parseJSON(rawMessage);
  const thread = parsed?.result?.thread;
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    return rawMessage;
  }

  const threadId = normalizeNonEmptyString(thread.id)
    || normalizeNonEmptyString(thread.threadId)
    || normalizeNonEmptyString(thread.thread_id);
  const { turns: sanitizedTurns, didSanitize } = sanitizeRelayHistoryTurns(thread.turns, threadId);

  if (!didSanitize) {
    const trimmedPayload = trimThreadPayloadForRelay(parsed, thread);
    return trimmedPayload == null ? rawMessage : trimmedPayload;
  }

  const sanitizedPayload = JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      thread: {
        ...thread,
        turns: sanitizedTurns,
      },
    },
  });

  return trimThreadPayloadForRelay(parseJSON(sanitizedPayload), null) ?? sanitizedPayload;
}

function sanitizeThreadTurnsListForRelay(rawMessage) {
  const parsed = parseJSON(rawMessage);
  const result = parsed?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return rawMessage;
  }

  const turnsKey = ["data", "items", "turns"].find((key) => Array.isArray(result[key]));
  if (!turnsKey) {
    return rawMessage;
  }

  const threadId = normalizeNonEmptyString(result.threadId)
    || normalizeNonEmptyString(result.thread_id)
    || normalizeNonEmptyString(result.thread?.id)
    || normalizeNonEmptyString(result.thread?.threadId)
    || normalizeNonEmptyString(result.thread?.thread_id);
  const { turns: sanitizedTurns, didSanitize } = sanitizeRelayHistoryTurns(result[turnsKey], threadId);
  const sanitizedParsed = didSanitize
    ? {
      ...parsed,
      result: {
        ...result,
        [turnsKey]: sanitizedTurns,
      },
    }
    : parsed;

  return trimTurnsListPayloadForRelay(sanitizedParsed, turnsKey, didSanitize ? null : rawMessage);
}

function sanitizeRelayHistoryTurns(turns, threadId = "") {
  let didSanitize = false;
  const sanitizedTurns = turns.map((turn) => {
    const sanitizedTurn = sanitizeRelayHistoryTurn(turn, threadId);
    if (sanitizedTurn !== turn) {
      didSanitize = true;
    }
    return sanitizedTurn;
  });

  return { turns: sanitizedTurns, didSanitize };
}

function sanitizeRelayHistoryTurn(turn, threadId = "") {
  if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
    return turn;
  }

  let turnDidChange = false;
  const turnThreadId = normalizeNonEmptyString(threadId)
    || normalizeNonEmptyString(turn.threadId)
    || normalizeNonEmptyString(turn.thread_id);
  const sanitizedItems = turn.items.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    let itemDidChange = false;
    let sanitizedItem = annotateImageGenerationHistoryItem(item, turnThreadId);
    if (sanitizedItem !== item) {
      itemDidChange = true;
    }

    if (Array.isArray(sanitizedItem.content)) {
      const sanitizedContent = sanitizedItem.content.map((contentItem) => {
        const sanitizedEntry = sanitizeInlineHistoryImageContentItem(contentItem);
        if (sanitizedEntry !== contentItem) {
          itemDidChange = true;
        }
        return sanitizedEntry;
      });

      if (itemDidChange) {
        sanitizedItem = {
          ...sanitizedItem,
          content: sanitizedContent,
        };
      }
    }

    const sanitizedCompactionItem = sanitizeCompactionHistoryItem(sanitizedItem);
    if (sanitizedCompactionItem !== sanitizedItem) {
      sanitizedItem = sanitizedCompactionItem;
      itemDidChange = true;
    }

    if (itemDidChange) {
      turnDidChange = true;
    }

    return itemDidChange ? sanitizedItem : item;
  });

  return turnDidChange
    ? {
      ...turn,
      items: sanitizedItems,
    }
    : turn;
}

module.exports = {
  sanitizeThreadHistoryImagesForRelay,
  sanitizeThreadTurnsListForRelay,
  sanitizeRelayHistoryTurns,
  sanitizeRelayHistoryTurn,
};
