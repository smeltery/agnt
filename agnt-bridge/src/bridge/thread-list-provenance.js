// FILE: bridge/thread-list-provenance.js
// Purpose: Restores fork/source provenance missing from Codex thread row responses.
// Layer: Bridge support
// Exports: createThreadListProvenanceEnricher

const fs = require("fs");
const { readSessionJsonlMetadataFromFile } = require("../providers/codex/session-jsonl-history");
const { forEachThreadRowInResponse } = require("./thread-row-enrichment");

const DEFAULT_MAX_ENTRIES = 4096;

function createThreadListProvenanceEnricher({
  fsModule = fs,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const cache = new Map();

  function readProvenance(threadId, filePath) {
    if (cache.has(threadId)) {
      const cached = cache.get(threadId);
      cache.delete(threadId);
      cache.set(threadId, cached);
      return cached;
    }

    let provenance = { forkedFromId: "", threadSource: "" };
    let readSessionMeta = false;
    try {
      const metadata = readSessionJsonlMetadataFromFile(filePath, { fsModule });
      readSessionMeta = Boolean(normalizeString(metadata?.threadId));
      provenance = {
        forkedFromId: normalizeString(metadata?.forkedFromId),
        threadSource: normalizeString(metadata?.threadSource),
      };
    } catch {
      // A rotated, half-written, or unreadable rollout leaves the row unchanged.
    }

    if (!readSessionMeta) {
      return provenance;
    }

    cache.set(threadId, provenance);
    while (cache.size > Math.max(1, maxEntries)) {
      cache.delete(cache.keys().next().value);
    }
    return provenance;
  }

  function attachToThread(thread) {
    const threadId = normalizeString(thread?.id) || normalizeString(thread?.threadId);
    const filePath = normalizeString(thread?.path) || normalizeString(thread?.rolloutPath);
    if (!thread || typeof thread !== "object" || !threadId || !filePath) {
      return thread;
    }
    if (normalizeString(thread.forkedFromId) && normalizeString(thread.threadSource)) {
      return thread;
    }

    const provenance = readProvenance(threadId, filePath);
    if (!normalizeString(thread.forkedFromId) && provenance.forkedFromId) {
      thread.forkedFromId = provenance.forkedFromId;
    }
    if (!normalizeString(thread.threadSource) && provenance.threadSource) {
      thread.threadSource = provenance.threadSource;
    }
    return thread;
  }

  function enrichResponse(method, envelope) {
    return forEachThreadRowInResponse(method, envelope, attachToThread);
  }

  return {
    attachToThread,
    enrichResponse,
    cacheSize: () => cache.size,
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createThreadListProvenanceEnricher,
};
