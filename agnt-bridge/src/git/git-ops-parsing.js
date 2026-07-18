// FILE: git-ops-parsing.js
// Purpose: Pure parsing and state helpers shared by git ops and contract tests.

function parseBranchFromStatus(line) {
  // "## main...origin/main" or "## main" or "## HEAD (no branch)"
  const match = line.match(/^## (.+?)(?:\.{3}|$)/);
  if (!match) return null;
  const branch = match[1].trim();
  if (branch.startsWith("No commits yet on ")) {
    return branch.substring("No commits yet on ".length).trim() || null;
  }
  if (branch === "HEAD (no branch)" || branch.includes("HEAD detached")) return null;
  return branch;
}

function parseTrackingFromStatus(line) {
  const match = line.match(/\.{3}(.+?)(?:\s|$)/);
  return match ? match[1].trim() : null;
}

function computeState(dirty, ahead, behind, detached, noUpstream) {
  if (detached) return "detached_head";
  if (noUpstream) return "no_upstream";
  if (dirty && behind > 0) return "dirty_and_behind";
  if (dirty) return "dirty";
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind_only";
  if (ahead > 0) return "ahead_only";
  return "up_to_date";
}

function nonRepositoryStatus(cwd) {
  return {
    isRepo: false,
    repoRoot: null,
    branch: null,
    tracking: null,
    dirty: false,
    hasHeadCommit: false,
    hasPushRemote: false,
    ahead: 0,
    behind: 0,
    localOnlyCommitCount: 0,
    state: "not_initialized",
    canPush: false,
    publishedToRemote: false,
    files: [],
    diff: { additions: 0, deletions: 0, binaryFiles: 0 },
  };
}

function gitInitBranchFlagUnsupported(error) {
  const message = error?.message || "";
  return message.includes("unknown switch `b'")
    || message.includes("unknown option `b'")
    || message.includes("usage: git init");
}

function trackingRemoteName(tracking) {
  const trimmed = typeof tracking === "string" ? tracking.trim() : "";
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) return null;
  return trimmed.slice(0, slashIndex);
}

function parseTrackingRef(tracking) {
  if (typeof tracking !== "string") {
    return null;
  }

  const separatorIndex = tracking.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === tracking.length - 1) {
    return null;
  }

  return {
    remote: tracking.slice(0, separatorIndex),
    branch: tracking.slice(separatorIndex + 1),
  };
}

function parseOwnerRepo(remoteUrl) {
  const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function normalizeBranchListEntry(rawLine) {
  const trimmed = typeof rawLine === "string" ? rawLine.trim() : "";
  if (!trimmed) return null;

  const isCurrent = trimmed.startsWith("* ");
  const isCheckedOutElsewhere = trimmed.startsWith("+ ");
  const name = trimmed.replace(/^[*+]\s+/, "").trim();

  if (!name) return null;

  return { isCurrent, isCheckedOutElsewhere, name };
}

module.exports = {
  computeState,
  gitInitBranchFlagUnsupported,
  nonRepositoryStatus,
  normalizeBranchListEntry,
  parseBranchFromStatus,
  parseOwnerRepo,
  parseTrackingFromStatus,
  parseTrackingRef,
  trackingRemoteName,
};
