// FILE: rollout-watch.js
// Purpose: Shared rollout-file lookup/watch helpers for CLI inspection, desktop refresh, and usage fallbacks.
// Layer: CLI helper
// Exports: watchThreadRollout, createThreadRolloutActivityWatcher
// Depends on: fs, os, path, ./session-state

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readLastActiveThread } = require("../bridge/session-state");
const {
  findRecentRolloutFileForContextRead,
  findRecentRolloutFileForWatch,
  findRolloutFileForThread,
  invalidateRolloutLookupCache,
} = require("./rollout/file-lookup");
const {
  contextUsageFromTokenCountPayload,
  readLatestContextWindowUsage: readLatestContextWindowUsageFromRoot,
  readRolloutUsageChunk,
} = require("./rollout/usage");

const DEFAULT_WATCH_INTERVAL_MS = 1_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT = 2;
const DEFAULT_INITIAL_USAGE_SCAN_BYTES = 128 * 1024;

// Polls one rollout file until it materializes and then reports size growth.
function createThreadRolloutActivityWatcher({
  threadId,
  turnId = "",
  intervalMs = DEFAULT_WATCH_INTERVAL_MS,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  initialUsageScanBytes = DEFAULT_INITIAL_USAGE_SCAN_BYTES,
  now = () => Date.now(),
  fsModule = fs,
  transientErrorRetryLimit = DEFAULT_TRANSIENT_ERROR_RETRY_LIMIT,
  onEvent = () => {},
  onUsage = () => {},
  onIdle = () => {},
  onTimeout = () => {},
  onError = () => {},
} = {}) {
  const resolvedThreadId = resolveThreadId(threadId);
  const sessionsRoot = resolveSessionsRoot();
  const startedAt = now();

  let isStopped = false;
  let rolloutPath = null;
  let lastSize = null;
  let lastGrowthAt = startedAt;
  let transientErrorCount = 0;
  let usageScanOffset = 0;
  let partialUsageLine = "";
  let lastUsageSignature = null;

  const tick = () => {
    if (isStopped) {
      return;
    }

    try {
      const currentTime = now();

      if (!rolloutPath) {
        if (currentTime - startedAt >= lookupTimeoutMs) {
          onTimeout({ threadId: resolvedThreadId });
          stop();
          return;
        }

        rolloutPath = findRecentRolloutFileForWatch(sessionsRoot, {
          threadId: resolvedThreadId,
          fsModule,
          startedAt,
          turnId,
        });
        if (!rolloutPath) {
          transientErrorCount = 0;
          return;
        }

        // The rollout file just materialized: bust the shared lookup cache so
        // any other lookup racing this one (e.g. the desktop mirror context
        // read for the same thread) sees it immediately instead of waiting
        // out the cache TTL.
        invalidateRolloutLookupCache({ root: sessionsRoot, threadId: resolvedThreadId, fsModule });

        lastSize = readFileSize(rolloutPath, fsModule);
        lastGrowthAt = currentTime;
        transientErrorCount = 0;
        const initialScanStart = Math.max(0, lastSize - initialUsageScanBytes);
        const initialUsageResult = readRolloutUsageChunk({
          filePath: rolloutPath,
          start: initialScanStart,
          endExclusive: lastSize,
          carry: "",
          fsModule,
          skipLeadingPartial: initialScanStart > 0,
        });
        usageScanOffset = lastSize;
        partialUsageLine = initialUsageResult.partialLine;
        emitUsageIfChanged(initialUsageResult.usage, "materialized");
        onEvent({
          reason: "materialized",
          threadId: resolvedThreadId,
          rolloutPath,
          size: lastSize,
        });
        return;
      }

      const nextSize = readFileSize(rolloutPath, fsModule);
      transientErrorCount = 0;
      if (nextSize > lastSize) {
        lastSize = nextSize;
        lastGrowthAt = currentTime;
        const usageResult = readRolloutUsageChunk({
          filePath: rolloutPath,
          start: usageScanOffset,
          endExclusive: nextSize,
          carry: partialUsageLine,
          fsModule,
        });
        usageScanOffset = nextSize;
        partialUsageLine = usageResult.partialLine;
        emitUsageIfChanged(usageResult.usage, "growth");
        onEvent({
          reason: "growth",
          threadId: resolvedThreadId,
          rolloutPath,
          size: nextSize,
        });
        return;
      }

      if (currentTime - lastGrowthAt >= idleTimeoutMs) {
        onIdle({
          threadId: resolvedThreadId,
          rolloutPath,
          size: lastSize,
        });
        stop();
      }
    } catch (error) {
      if (isRetryableFilesystemError(error) && transientErrorCount < transientErrorRetryLimit) {
        transientErrorCount += 1;
        return;
      }

      onError(error);
      stop();
    }
  };

  const intervalId = setInterval(tick, intervalMs);
  tick();

  // Emits only when the rollout produced a newer token-count snapshot.
  function emitUsageIfChanged(usage, reason) {
    if (!usage) {
      return;
    }

    const nextSignature = `${usage.tokensUsed}|${usage.tokenLimit}`;
    if (nextSignature === lastUsageSignature) {
      return;
    }

    lastUsageSignature = nextSignature;
    onUsage({
      reason,
      threadId: resolvedThreadId,
      rolloutPath,
      usage,
    });
  }

  function stop() {
    if (isStopped) {
      return;
    }

    isStopped = true;
    clearInterval(intervalId);
  }

  return {
    stop,
    get threadId() {
      return resolvedThreadId;
    },
  };
}

function watchThreadRollout(threadId = "") {
  const resolvedThreadId = resolveThreadId(threadId);
  const sessionsRoot = resolveSessionsRoot();
  const rolloutPath = findRolloutFileForThread(sessionsRoot, resolvedThreadId);

  if (!rolloutPath) {
    throw new Error(`No rollout file found for thread ${resolvedThreadId}.`);
  }

  let offset = fs.statSync(rolloutPath).size;
  let partialLine = "";

  console.log(`[agnt] Watching thread ${resolvedThreadId}`);
  console.log(`[agnt] Rollout file: ${rolloutPath}`);
  console.log("[agnt] Waiting for new persisted events... (Ctrl+C to stop)");

  const onChange = (current, previous) => {
    if (current.size <= previous.size) {
      return;
    }

    const stream = fs.createReadStream(rolloutPath, {
      start: offset,
      end: current.size - 1,
      encoding: "utf8",
    });

    let chunkBuffer = "";
    stream.on("data", (chunk) => {
      chunkBuffer += chunk;
    });

    stream.on("end", () => {
      offset = current.size;
      const combined = partialLine + chunkBuffer;
      const lines = combined.split("\n");
      partialLine = lines.pop() || "";

      for (const line of lines) {
        const formatted = formatRolloutLine(line);
        if (formatted) {
          console.log(formatted);
        }
      }
    });
  };

  fs.watchFile(rolloutPath, { interval: 700 }, onChange);

  const cleanup = () => {
    fs.unwatchFile(rolloutPath, onChange);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function resolveThreadId(threadId) {
  if (threadId && typeof threadId === "string") {
    return threadId;
  }

  const last = readLastActiveThread();
  if (last?.threadId) {
    return last.threadId;
  }

  throw new Error("No thread id provided and no remembered agnt thread found.");
}

function resolveSessionsRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function formatRolloutLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const timestamp = formatTimestamp(parsed.timestamp);
  const payload = parsed.payload || {};

  if (parsed.type === "event_msg") {
    const eventType = payload.type;
    if (eventType === "user_message") {
      return `${timestamp} Phone: ${previewText(payload.message)}`;
    }
    if (eventType === "agent_message") {
      return `${timestamp} Codex: ${previewText(payload.message)}`;
    }
    if (eventType === "task_started") {
      return `${timestamp} Task started`;
    }
    if (eventType === "task_complete") {
      return `${timestamp} Task complete`;
    }
  }

  return null;
}

// Reads the newest usable token-count snapshot for a specific thread/turn from recent rollout files.
function readLatestContextWindowUsage(options = {}) {
  return readLatestContextWindowUsageFromRoot({
    ...options,
    resolveSessionsRoot,
  });
}

function formatTimestamp(value) {
  if (!value || typeof value !== "string") {
    return "[time?]";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "[time?]";
  }

  return `[${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}]`;
}

function previewText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117)}...`;
}

function readFileSize(filePath, fsModule = fs) {
  return fsModule.statSync(filePath).size;
}

function isRetryableFilesystemError(error) {
  return ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error?.code);
}

module.exports = {
  watchThreadRollout,
  createThreadRolloutActivityWatcher,
  contextUsageFromTokenCountPayload,
  readLatestContextWindowUsage,
  resolveSessionsRoot,
  findRolloutFileForThread,
  findRecentRolloutFileForContextRead,
  invalidateRolloutLookupCache,
};
