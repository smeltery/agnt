// FILE: rollout-usage.js
// Purpose: Read and parse context-window usage snapshots from rollout JSONL.

const fs = require("fs");
const {
  DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT,
  findRecentRolloutFileForContextRead,
  readFileSlice,
} = require("./rollout-file-lookup");

const DEFAULT_CONTEXT_READ_SCAN_BYTES = 512 * 1024;

// Extracts the latest usable context-window numbers from persisted token_count lines.
function readRolloutUsageChunk({
  filePath,
  start,
  endExclusive,
  carry = "",
  fsModule = fs,
  skipLeadingPartial = false,
} = {}) {
  if (!filePath || endExclusive <= start) {
    return { partialLine: carry, usage: null };
  }

  const chunk = readFileSlice(filePath, start, endExclusive, fsModule);
  if (!chunk) {
    return { partialLine: carry, usage: null };
  }

  const combined = `${carry}${chunk}`;
  const lines = combined.split("\n");
  const partialLine = lines.pop() || "";

  if (skipLeadingPartial && lines.length > 0) {
    lines.shift();
  }

  let latestUsage = null;
  for (const line of lines) {
    const usage = extractContextUsageFromRolloutLine(line);
    if (usage) {
      latestUsage = usage;
    }
  }

  return {
    partialLine,
    usage: latestUsage,
  };
}

function extractContextUsageFromRolloutLine(rawLine) {
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

  if (parsed?.type !== "event_msg") {
    return null;
  }

  const payload = parsed.payload;
  if (!payload || typeof payload !== "object" || payload.type !== "token_count") {
    return null;
  }

  return contextUsageFromTokenCountPayload(payload);
}

function contextUsageFromTokenCountPayload(payload) {
  const info = payload?.info;
  if (!info || typeof info !== "object") {
    return null;
  }

  // Prefer the last-turn snapshot over cumulative totals so the UI shows the
  // active context load, not the lifetime token count of the whole session file.
  const usageRoot = info.last_token_usage || info.lastTokenUsage || info.total_token_usage || info.totalTokenUsage;
  const tokenLimit = readPositiveInteger(
    info.model_context_window ?? info.modelContextWindow ?? info.context_window ?? info.contextWindow
  );
  if (!tokenLimit) {
    return null;
  }

  const tokensUsed = readPositiveInteger(usageRoot?.total_tokens ?? usageRoot?.totalTokens)
    ?? sumPositiveIntegers([
      usageRoot?.input_tokens ?? usageRoot?.inputTokens,
      usageRoot?.output_tokens ?? usageRoot?.outputTokens,
      usageRoot?.reasoning_output_tokens ?? usageRoot?.reasoningOutputTokens,
    ]);
  if (tokensUsed == null) {
    return null;
  }

  return {
    tokensUsed: Math.min(tokensUsed, tokenLimit),
    tokenLimit,
  };
}

function readPositiveInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return null;
}

function sumPositiveIntegers(values) {
  let total = 0;
  let foundValue = false;

  for (const value of values) {
    const parsed = readPositiveInteger(value);
    if (parsed == null) {
      continue;
    }

    foundValue = true;
    total += parsed;
  }

  return foundValue ? total : null;
}

// Reads the newest usable token-count snapshot for a specific thread/turn from recent rollout files.
function readLatestContextWindowUsage({
  threadId = "",
  turnId = "",
  fsModule = fs,
  scanBytes = DEFAULT_CONTEXT_READ_SCAN_BYTES,
  candidateLimit = DEFAULT_CONTEXT_READ_CANDIDATE_LIMIT,
  resolveSessionsRoot,
} = {}) {
  const rolloutRoot = resolveSessionsRoot();
  const rolloutPath = findRecentRolloutFileForContextRead(rolloutRoot, {
    threadId,
    turnId,
    fsModule,
    candidateLimit,
  });
  if (!rolloutPath) {
    return null;
  }

  const stat = fsModule.statSync(rolloutPath);
  const boundedStart = Math.max(0, stat.size - Math.min(stat.size, scanBytes));
  let result = readRolloutUsageChunk({
    filePath: rolloutPath,
    start: boundedStart,
    endExclusive: stat.size,
    fsModule,
    skipLeadingPartial: boundedStart > 0,
  });

  if (!result.usage && boundedStart > 0) {
    result = readRolloutUsageChunk({
      filePath: rolloutPath,
      start: 0,
      endExclusive: stat.size,
      fsModule,
    });
  }

  return result.usage
    ? {
        rolloutPath,
        usage: result.usage,
      }
    : null;
}

module.exports = {
  contextUsageFromTokenCountPayload,
  readLatestContextWindowUsage,
  readRolloutUsageChunk,
};
