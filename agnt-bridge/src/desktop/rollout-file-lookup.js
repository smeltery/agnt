// FILE: rollout-file-lookup.js
// Purpose: Locate Codex rollout JSONL files for watchers, context reads, and history recovery.

const fs = require("fs");
const path = require("path");

const DEFAULT_TURN_LOOKUP_SCAN_BYTES = 16 * 1024;
const DEFAULT_THREAD_LOOKUP_SCAN_BYTES = 512 * 1024;
const DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT = 128;
const DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT = 24;
const DEFAULT_RECENT_ROLLOUT_LOOKBACK_MS = 15 * 60 * 1000;

function findRolloutFileForThread(root, threadId, { fsModule = fs } = {}) {
  if (!fsModule.existsSync(root)) {
    return null;
  }

  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fsModule.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.includes(threadId) && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        return fullPath;
      }
    }
  }

  return null;
}

// Chooses the rollout file for the active bridge turn, preferring turn_id and then the thread-scoped file.
function findRecentRolloutFileForWatch(
  root,
  {
    threadId = "",
    turnId = "",
    startedAt = 0,
    fsModule = fs,
    candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT,
    lookbackMs = DEFAULT_RECENT_ROLLOUT_LOOKBACK_MS,
    turnLookupScanBytes = DEFAULT_TURN_LOOKUP_SCAN_BYTES,
  } = {}
) {
  const candidates = collectRecentRolloutFiles(root, {
    fsModule,
    candidateLimit,
    modifiedAfterMs: startedAt > 0 ? (startedAt - lookbackMs) : 0,
  });
  if (candidates.length === 0) {
    return null;
  }

  if (turnId) {
    for (const candidate of candidates) {
      if (rolloutFileContainsTurnId(candidate.filePath, turnId, {
        fsModule,
        scanBytes: turnLookupScanBytes,
      })) {
        return candidate.filePath;
      }
    }
  }

  if (threadId) {
    const threadScopedRollout = findPreferredRolloutFileForThread(root, candidates, threadId, {
      fsModule,
    });
    if (threadScopedRollout) {
      return threadScopedRollout;
    }
  }

  return null;
}

// Picks the rollout file tied back to a thread/turn for on-demand reads without crossing into another thread.
function findRecentRolloutFileForContextRead(
  root,
  {
    threadId = "",
    turnId = "",
    fsModule = fs,
    candidateLimit = DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT,
    turnLookupScanBytes = DEFAULT_TURN_LOOKUP_SCAN_BYTES,
    threadLookupScanBytes = DEFAULT_THREAD_LOOKUP_SCAN_BYTES,
  } = {}
) {
  const candidates = collectRecentRolloutFiles(root, {
    fsModule,
    candidateLimit,
    modifiedAfterMs: 0,
  });
  if (candidates.length === 0) {
    return null;
  }

  if (turnId) {
    for (const candidate of candidates) {
      if (rolloutFileContainsTurnId(candidate.filePath, turnId, {
        fsModule,
        scanBytes: turnLookupScanBytes,
      })) {
        return candidate.filePath;
      }
    }
  }

  if (threadId) {
    const threadScopedRollout = findPreferredRolloutFileForThread(root, candidates, threadId, {
      fsModule,
    });
    if (threadScopedRollout) {
      return threadScopedRollout;
    }

    for (const candidate of candidates) {
      if (rolloutFileContainsThreadId(candidate.filePath, threadId, {
        fsModule,
        scanBytes: threadLookupScanBytes,
      })) {
        return candidate.filePath;
      }
    }
  }

  return null;
}

// Keeps the fast "recent files first" path, but falls back to a full-tree scan
// so older valid thread rollouts still recover after many newer sessions exist.
function findPreferredRolloutFileForThread(root, candidates, threadId, { fsModule = fs } = {}) {
  const recentMatch = findMostRecentRolloutFileForThread(candidates, threadId);
  if (recentMatch) {
    return recentMatch;
  }

  return findNewestRolloutFileForThread(root, threadId, { fsModule });
}

// Prefers the newest filename-scoped rollout for a thread instead of the first
// filesystem hit, which can be an older stale session for the same thread.
function findMostRecentRolloutFileForThread(candidates, threadId) {
  if (!Array.isArray(candidates) || !threadId) {
    return null;
  }

  const match = candidates.find(({ filePath }) => path.basename(filePath).includes(threadId));
  return match?.filePath || null;
}

// Scans the whole sessions tree only when the recent candidate window missed the
// thread, still preferring the newest matching rollout instead of the first hit.
function findNewestRolloutFileForThread(root, threadId, { fsModule = fs } = {}) {
  if (!threadId || !fsModule.existsSync(root)) {
    return null;
  }

  const stack = [root];
  let newestMatch = null;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fsModule.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()
        || !entry.name.startsWith("rollout-")
        || !entry.name.endsWith(".jsonl")
        || !entry.name.includes(threadId)) {
        continue;
      }

      const stat = fsModule.statSync(fullPath);
      if (!newestMatch || stat.mtimeMs > newestMatch.mtimeMs) {
        newestMatch = {
          filePath: fullPath,
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  }

  return newestMatch?.filePath || null;
}

function collectRecentRolloutFiles(
  root,
  {
    fsModule = fs,
    candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT,
    modifiedAfterMs = 0,
  } = {}
) {
  if (!fsModule.existsSync(root)) {
    return [];
  }

  const stack = [root];
  const candidates = [];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fsModule.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()
        || !entry.name.startsWith("rollout-")
        || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const stat = fsModule.statSync(fullPath);
      if (modifiedAfterMs > 0 && stat.mtimeMs < modifiedAfterMs) {
        continue;
      }

      candidates.push({
        filePath: fullPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  candidates.sort((lhs, rhs) => rhs.mtimeMs - lhs.mtimeMs);
  return candidates.slice(0, candidateLimit);
}

function rolloutFileContainsTurnId(
  filePath,
  turnId,
  {
    fsModule = fs,
    scanBytes = DEFAULT_TURN_LOOKUP_SCAN_BYTES,
  } = {}
) {
  if (!filePath || !turnId) {
    return false;
  }

  const stat = fsModule.statSync(filePath);
  const chunk = readFileSlice(
    filePath,
    0,
    Math.min(stat.size, scanBytes),
    fsModule
  );
  if (!chunk) {
    return false;
  }

  return chunk.includes(`"turn_id":"${turnId}"`) || chunk.includes(`"turnId":"${turnId}"`);
}

function rolloutFileContainsThreadId(
  filePath,
  threadId,
  {
    fsModule = fs,
    scanBytes = DEFAULT_THREAD_LOOKUP_SCAN_BYTES,
  } = {}
) {
  if (!filePath || !threadId) {
    return false;
  }

  const stat = fsModule.statSync(filePath);
  const chunk = readFileSlice(
    filePath,
    Math.max(0, stat.size - Math.min(stat.size, scanBytes)),
    stat.size,
    fsModule
  );
  if (!chunk) {
    return false;
  }

  return (
    chunk.includes(`"thread_id":"${threadId}"`)
      || chunk.includes(`"threadId":"${threadId}"`)
      || chunk.includes(`"conversation_id":"${threadId}"`)
      || chunk.includes(`"conversationId":"${threadId}"`)
  );
}

function readFileSlice(filePath, start, endExclusive, fsModule = fs) {
  const length = Math.max(0, endExclusive - start);
  if (length === 0) {
    return "";
  }

  const fileHandle = fsModule.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fsModule.readSync(fileHandle, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fsModule.closeSync(fileHandle);
  }
}

module.exports = {
  DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT,
  DEFAULT_RECENT_ROLLOUT_LOOKBACK_MS,
  findRecentRolloutFileForContextRead,
  findRecentRolloutFileForWatch,
  findRolloutFileForThread,
  readFileSlice,
};
