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
// Layer: Bridge support
// Exports:
//   - sanitizeThreadHistoryImagesForRelay (entry)
//   - augmentRelayThreadWithJsonlMetadata (helper — re-exported for tests)
//   - sanitizeThreadTurnsListForRelay (entry — re-exported for tests)
//   - sanitizeRelayHistoryTurns (helper — re-exported for tests)
//   - sanitizeRelayHistoryTurn (helper — re-exported for tests)
// Depends on:
//   - fs
//   - ./relay-image-sanitizer (annotateImageGenerationHistoryItem,
//     sanitizeInlineHistoryImageContentItem, sanitizeCompactionHistoryItem)
//   - ./relay-payload-trimmer (trimThreadPayloadForRelay,
//     trimTurnsListPayloadForRelay)

const fs = require("fs");

const {
  annotateImageGenerationHistoryItem,
  sanitizeInlineHistoryImageContentItem,
  sanitizeCompactionHistoryItem,
} = require("./relay-image-sanitizer");
const {
  RELAY_HISTORY_RECENT_TURN_TARGET,
  trimThreadPayloadForRelay,
  trimTurnsListPayloadForRelay,
} = require("./relay-payload-trimmer");
const {
  RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
} = require("./turns-list-pager");
const {
  findRecentRolloutFileForContextRead,
  resolveSessionsRoot,
} = require("../desktop/rollout-watch");
const {
  parseSessionJsonlMetadata,
} = require("../providers/codex/session-jsonl-history");
const {
  historyItemUserText,
  isContextualUserText,
  isUserRoleHistoryItem,
} = require("./contextual-user-items");

const JSONL_THREAD_CWD_CACHE_MAX_ENTRIES = 200;
const JSONL_THREAD_CWD_CACHE_TTL_MS = 5 * 60_000;
const JSONL_THREAD_EMPTY_CWD_CACHE_TTL_MS = 30_000;
const jsonlThreadCwdCacheByThread = new Map();

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

function sanitizeThreadHistoryImagesForRelay(rawMessage, requestMethod, requestContext = {}) {
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
  const shouldAugmentJsonlMetadata = requestContext.activeProviderId === "codex";
  const didPreTrimTurnWindow = Buffer.byteLength(rawMessage, "utf8") > RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES
    && thread.turns.length > RELAY_HISTORY_RECENT_TURN_TARGET;
  const workingTurns = didPreTrimTurnWindow
    ? thread.turns.slice(-RELAY_HISTORY_RECENT_TURN_TARGET)
    : thread.turns;
  const workingThread = didPreTrimTurnWindow
    ? { ...thread, turns: workingTurns }
    : thread;
  const trimOptions = didPreTrimTurnWindow
    ? {
      preOmittedTurnCount: thread.turns.length - workingTurns.length,
      compactionIdSource: thread.turns[0],
    }
    : {};
  const { thread: threadWithJsonlMetadata, didAugment: didAugmentThreadMetadata } = shouldAugmentJsonlMetadata
    ? augmentRelayThreadWithJsonlMetadata(workingThread, threadId, requestContext)
    : { thread: workingThread, didAugment: false };
  const { turns: sanitizedTurns, didSanitize } = sanitizeRelayHistoryTurns(workingTurns, threadId);

  if (!didSanitize && !didPreTrimTurnWindow && !didAugmentThreadMetadata) {
    const trimmedPayload = trimThreadPayloadForRelay(parsed, thread);
    return trimmedPayload == null ? rawMessage : trimmedPayload;
  }

  const sanitizedPayload = JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      thread: {
        ...threadWithJsonlMetadata,
        turns: sanitizedTurns,
      },
    },
  });

  return trimThreadPayloadForRelay(parseJSON(sanitizedPayload), null, trimOptions) ?? sanitizedPayload;
}

function sanitizeLiveContextualUserItemForRelay(rawMessage) {
  const parsed = parseJSON(rawMessage);
  const method = readString(parsed?.method);
  if (method !== "item/started" && method !== "item/completed") {
    return rawMessage;
  }

  const item = parsed?.params?.item;
  if (!isUserRoleHistoryItem(item)) {
    return rawMessage;
  }

  return isContextualUserText(historyItemUserText(item)) ? null : rawMessage;
}

function augmentRelayThreadWithJsonlMetadata(thread, threadId = "", {
  resolveSessionsRootImpl = resolveSessionsRoot,
  findRecentRolloutFileForContextReadImpl = findRecentRolloutFileForContextRead,
  parseSessionJsonlMetadataImpl = parseSessionJsonlMetadata,
  fsModule = fs,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const cwd = readJsonlThreadCwd(threadId, {
    resolveSessionsRootImpl,
    findRecentRolloutFileForContextReadImpl,
    parseSessionJsonlMetadataImpl,
    fsModule,
    now,
    logger,
  });
  if (!cwd || !thread || typeof thread !== "object") {
    return { thread, didAugment: false };
  }

  if (normalizeNonEmptyString(thread.cwd) === cwd
    && normalizeNonEmptyString(thread.current_working_directory) === cwd) {
    return { thread, didAugment: false };
  }

  return {
    thread: {
      ...thread,
      cwd,
      current_working_directory: cwd,
    },
    didAugment: true,
  };
}

function readJsonlThreadCwd(threadId, {
  resolveSessionsRootImpl,
  findRecentRolloutFileForContextReadImpl,
  parseSessionJsonlMetadataImpl,
  fsModule,
  now,
  logger,
}) {
  const normalizedThreadId = normalizeNonEmptyString(threadId);
  if (!normalizedThreadId) {
    return "";
  }

  const sessionsRoot = resolveSessionsRootImpl();
  const cacheKey = `${sessionsRoot}\0${normalizedThreadId}`;

  try {
    const rolloutPath = findRecentRolloutFileForContextReadImpl(sessionsRoot, { threadId: normalizedThreadId, fsModule });
    if (!rolloutPath) {
      const cachedMiss = jsonlThreadCwdCacheByThread.get(cacheKey);
      if (cachedMiss && !cachedMiss.rolloutPath) {
        const ttlMs = JSONL_THREAD_EMPTY_CWD_CACHE_TTL_MS;
        if (now() - cachedMiss.checkedAt <= ttlMs) {
          return cachedMiss.cwd;
        }
      }
      rememberJsonlThreadCwdCache(cacheKey, {
        rolloutPath: "",
        mtimeMs: 0,
        size: 0,
        checkedAt: now(),
        cwd: "",
      });
      return "";
    }

    const stat = fsModule.statSync(rolloutPath);
    const cached = jsonlThreadCwdCacheByThread.get(cacheKey);
    if (
      cached
      && cached.rolloutPath === rolloutPath
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
    ) {
      const ttlMs = cached.cwd ? JSONL_THREAD_CWD_CACHE_TTL_MS : JSONL_THREAD_EMPTY_CWD_CACHE_TTL_MS;
      if (now() - cached.checkedAt <= ttlMs) {
        return cached.cwd;
      }
    }

    const metadata = parseSessionJsonlMetadataImpl(fsModule.readFileSync(rolloutPath, "utf8"));
    const cwd = normalizeNonEmptyString(metadata?.cwd);
    rememberJsonlThreadCwdCache(cacheKey, {
      rolloutPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      checkedAt: now(),
      cwd,
    });
    return cwd;
  } catch (error) {
    jsonlThreadCwdCacheByThread.delete(cacheKey);
    logger.warn?.(`[agnt] thread jsonl metadata augmentation failed for ${normalizedThreadId}: ${error.message}`);
    return "";
  }
}

function rememberJsonlThreadCwdCache(cacheKey, entry) {
  jsonlThreadCwdCacheByThread.set(cacheKey, entry);
  while (jsonlThreadCwdCacheByThread.size > JSONL_THREAD_CWD_CACHE_MAX_ENTRIES) {
    const oldestKey = jsonlThreadCwdCacheByThread.keys().next().value;
    if (oldestKey == null) {
      break;
    }
    jsonlThreadCwdCacheByThread.delete(oldestKey);
  }
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
  const sanitizedItems = turn.items.filter((item) => {
    if (!isUserRoleHistoryItem(item)) {
      return true;
    }
    const shouldKeep = !isContextualUserText(historyItemUserText(item));
    if (!shouldKeep) {
      turnDidChange = true;
    }
    return shouldKeep;
  }).map((item) => {
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
  augmentRelayThreadWithJsonlMetadata,
  sanitizeLiveContextualUserItemForRelay,
  sanitizeThreadHistoryImagesForRelay,
  sanitizeThreadTurnsListForRelay,
  sanitizeRelayHistoryTurns,
  sanitizeRelayHistoryTurn,
};
