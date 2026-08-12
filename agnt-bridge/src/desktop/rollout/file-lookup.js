// FILE: rollout/file-lookup.js
// Purpose: Locate Codex rollout JSONL files for watchers, context reads, and history recovery.

const fs = require("fs");
const path = require("path");

const DEFAULT_TURN_LOOKUP_SCAN_BYTES = 16 * 1024;
const DEFAULT_THREAD_LOOKUP_SCAN_BYTES = 512 * 1024;
const DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT = 128;
const DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT = 24;
const DEFAULT_RECENT_ROLLOUT_LOOKBACK_MS = 15 * 60 * 1000;
const ROLLOUT_CANDIDATE_CACHE_TTL_MS = 2_000;
const ROLLOUT_THREAD_POSITIVE_CACHE_TTL_MS = 2_000;
const ROLLOUT_THREAD_NEGATIVE_CACHE_TTL_MS = 1_500;
const ROLLOUT_LOOKUP_CACHE_MAX_ROOTS = 32;
const ROLLOUT_THREAD_MEMO_MAX_SIZE = 2_000;
const ROLLOUT_THREAD_CONTENT_CACHE_MAX_SIZE = 4_000;
const rolloutLookupCachesByFsModule = new WeakMap();

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
    now = () => Date.now(),
  } = {}
) {
  const candidates = collectRecentRolloutFiles(root, {
    fsModule,
    candidateLimit,
    modifiedAfterMs: startedAt > 0 ? (startedAt - lookbackMs) : 0,
    now,
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
      now,
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
    now = () => Date.now(),
  } = {}
) {
  const currentTime = now();
  const cache = rolloutLookupCacheForFsModule(fsModule);
  const threadMemoKey = threadId && !turnId
    ? rolloutThreadMemoKey(root, threadId)
    : "";
  if (threadMemoKey) {
    const positive = cache.positiveThreadPaths.get(threadMemoKey);
    if (positive) {
      if (positive.expiresAt > currentTime && fsModule.existsSync(positive.filePath)) {
        return positive.filePath;
      }
      cache.positiveThreadPaths.delete(threadMemoKey);
    }

    const negativeExpiresAt = cache.negativeThreadLookups.get(threadMemoKey) || 0;
    if (negativeExpiresAt > currentTime) {
      return null;
    }
    cache.negativeThreadLookups.delete(threadMemoKey);
  }

  const candidates = collectRecentRolloutFiles(root, {
    fsModule,
    candidateLimit,
    modifiedAfterMs: 0,
    now,
  });
  if (candidates.length === 0) {
    rememberNegativeThreadLookup(cache, threadMemoKey, currentTime);
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
      now,
    });
    if (threadScopedRollout) {
      rememberPositiveThreadPath(cache, threadMemoKey, threadScopedRollout, currentTime);
      return threadScopedRollout;
    }

    for (const candidate of candidates) {
      if (rolloutFileContainsThreadId(candidate.filePath, threadId, {
        fsModule,
        scanBytes: threadLookupScanBytes,
      })) {
        rememberPositiveThreadPath(cache, threadMemoKey, candidate.filePath, currentTime);
        return candidate.filePath;
      }
    }
  }

  rememberNegativeThreadLookup(cache, threadMemoKey, currentTime);
  return null;
}

// Keeps the fast "recent files first" path, but falls back to a full-tree scan
// so older valid thread rollouts still recover after many newer sessions exist.
function findPreferredRolloutFileForThread(
  root,
  candidates,
  threadId,
  {
    fsModule = fs,
    now = () => Date.now(),
  } = {}
) {
  const recentMatch = findMostRecentRolloutFileForThread(candidates, threadId);
  if (recentMatch) {
    return recentMatch;
  }

  return findNewestRolloutFileForThread(root, threadId, { fsModule, now });
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

// Uses the complete sorted candidate set when the recent slice missed the
// thread, still preferring the newest matching rollout instead of the first hit.
function findNewestRolloutFileForThread(
  root,
  threadId,
  {
    fsModule = fs,
    now = () => Date.now(),
  } = {}
) {
  if (!threadId) {
    return null;
  }

  return findMostRecentRolloutFileForThread(
    collectRecentRolloutFiles(root, {
      fsModule,
      candidateLimit: Number.POSITIVE_INFINITY,
      modifiedAfterMs: 0,
      now,
    }),
    threadId
  );
}

// Caches the sorted, unfiltered candidate list per root for a short TTL so a
// burst of lookups (context reads, turns-list fallback, mirror polling) pays
// for one tree walk instead of one per call. Filtering/slicing stays outside
// the cache so different callers can share the same cached scan.
function collectRecentRolloutFiles(
  root,
  {
    fsModule = fs,
    candidateLimit = DEFAULT_RECENT_ROLLOUT_CANDIDATE_LIMIT,
    modifiedAfterMs = 0,
    now = () => Date.now(),
  } = {}
) {
  const cache = rolloutLookupCacheForFsModule(fsModule);
  const currentTime = now();
  const cached = cache.candidatesByRoot.get(root);
  let candidates = cached?.candidates;
  if (!cached || currentTime - cached.createdAt >= ROLLOUT_CANDIDATE_CACHE_TTL_MS) {
    candidates = scanRolloutFiles(root, fsModule);
    cache.candidatesByRoot.delete(root);
    cache.candidatesByRoot.set(root, {
      candidates,
      createdAt: currentTime,
    });
    evictOldestCacheEntries(cache.candidatesByRoot, ROLLOUT_LOOKUP_CACHE_MAX_ROOTS);
  }

  const filtered = modifiedAfterMs > 0
    ? candidates.filter(({ mtimeMs }) => mtimeMs >= modifiedAfterMs)
    : candidates;
  return filtered.slice(0, candidateLimit);
}

function scanRolloutFiles(root, fsModule) {
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
      candidates.push({
        filePath: fullPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  candidates.sort(
    (lhs, rhs) => rhs.mtimeMs - lhs.mtimeMs
      || path.basename(rhs.filePath).localeCompare(path.basename(lhs.filePath))
      || rhs.filePath.localeCompare(lhs.filePath)
  );
  return candidates;
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
  const cache = rolloutLookupCacheForFsModule(fsModule);
  const cacheKey = `${filePath}\0${threadId}\0${stat.size}\0${scanBytes}`;
  if (cache.threadContentMatches.has(cacheKey)) {
    return cache.threadContentMatches.get(cacheKey);
  }
  const chunk = readFileSlice(
    filePath,
    Math.max(0, stat.size - Math.min(stat.size, scanBytes)),
    stat.size,
    fsModule
  );
  if (!chunk) {
    rememberThreadContentMatch(cache, cacheKey, false);
    return false;
  }

  const matches = (
    chunk.includes(`"thread_id":"${threadId}"`)
      || chunk.includes(`"threadId":"${threadId}"`)
      || chunk.includes(`"conversation_id":"${threadId}"`)
      || chunk.includes(`"conversationId":"${threadId}"`)
  );
  rememberThreadContentMatch(cache, cacheKey, matches);
  return matches;
}

function rolloutLookupCacheForFsModule(fsModule) {
  let cache = rolloutLookupCachesByFsModule.get(fsModule);
  if (!cache) {
    cache = {
      candidatesByRoot: new Map(),
      positiveThreadPaths: new Map(),
      negativeThreadLookups: new Map(),
      threadContentMatches: new Map(),
    };
    rolloutLookupCachesByFsModule.set(fsModule, cache);
  }
  return cache;
}

function rolloutThreadMemoKey(root, threadId) {
  return `${root}\0${threadId}`;
}

function rememberPositiveThreadPath(cache, memoKey, filePath, currentTime) {
  if (!memoKey) {
    return;
  }
  cache.negativeThreadLookups.delete(memoKey);
  cache.positiveThreadPaths.delete(memoKey);
  cache.positiveThreadPaths.set(memoKey, {
    filePath,
    expiresAt: currentTime + ROLLOUT_THREAD_POSITIVE_CACHE_TTL_MS,
  });
  evictOldestCacheEntries(cache.positiveThreadPaths, ROLLOUT_THREAD_MEMO_MAX_SIZE);
}

function rememberNegativeThreadLookup(cache, memoKey, currentTime) {
  if (!memoKey) {
    return;
  }
  cache.negativeThreadLookups.delete(memoKey);
  cache.negativeThreadLookups.set(
    memoKey,
    currentTime + ROLLOUT_THREAD_NEGATIVE_CACHE_TTL_MS
  );
  evictOldestCacheEntries(cache.negativeThreadLookups, ROLLOUT_THREAD_MEMO_MAX_SIZE);
}

function rememberThreadContentMatch(cache, cacheKey, matches) {
  cache.threadContentMatches.set(cacheKey, matches);
  evictOldestCacheEntries(
    cache.threadContentMatches,
    ROLLOUT_THREAD_CONTENT_CACHE_MAX_SIZE
  );
}

function evictOldestCacheEntries(cache, maxSize) {
  while (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}

// Lets callers who learn a new rollout file exists (e.g. a watcher that just
// found a freshly materialized file) drop the cached candidate list/thread
// memo immediately instead of waiting out the TTL. Dropping the whole
// fsModule cache (no root) supports tests that want a clean slate.
function invalidateRolloutLookupCache({
  root = "",
  threadId = "",
  fsModule = fs,
} = {}) {
  const cache = rolloutLookupCachesByFsModule.get(fsModule);
  if (!cache) {
    return;
  }
  if (!root) {
    rolloutLookupCachesByFsModule.delete(fsModule);
    return;
  }

  cache.candidatesByRoot.delete(root);
  if (!threadId) {
    return;
  }
  const memoKey = rolloutThreadMemoKey(root, threadId);
  cache.positiveThreadPaths.delete(memoKey);
  cache.negativeThreadLookups.delete(memoKey);
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
  invalidateRolloutLookupCache,
  readFileSlice,
};
