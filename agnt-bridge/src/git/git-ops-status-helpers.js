// FILE: git-ops-status-helpers.js
// Purpose: Private git probe helpers used by git-ops.js status/branch flows.

const {
  parseBranchFromStatus,
  parseTrackingRef,
  trackingRemoteName,
} = require("./git-ops-parsing");

const STATUS_UPSTREAM_FETCH_TTL_MS = 15_000;
const statusUpstreamFetchCache = new Map();

function createGitOpsStatusHelpers({ git }) {
  async function isInsideGitWorkTree(cwd) {
    try {
      const output = await git(cwd, "rev-parse", "--is-inside-work-tree");
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  async function revListCounts(cwd) {
    const output = await git(cwd, "rev-list", "--left-right", "--count", "HEAD...@{u}");
    const parts = output.trim().split(/\s+/);
    return {
      ahead: parseInt(parts[0], 10) || 0,
      behind: parseInt(parts[1], 10) || 0,
    };
  }

  // Keeps Update eligibility based on the current upstream ref, not stale local fetch data.
  async function refreshStatusUpstreamIfNeeded(cwd, tracking, repoRoot) {
    const parsedTracking = parseTrackingRef(tracking);
    if (!parsedTracking) {
      return false;
    }

    const cacheKey = `${repoRoot || cwd}\0${parsedTracking.remote}\0${parsedTracking.branch}`;
    const now = Date.now();
    const lastFetchAt = statusUpstreamFetchCache.get(cacheKey) || 0;
    if (now - lastFetchAt < STATUS_UPSTREAM_FETCH_TTL_MS) {
      return false;
    }

    statusUpstreamFetchCache.set(cacheKey, now);
    if (statusUpstreamFetchCache.size > 200) {
      statusUpstreamFetchCache.clear();
      statusUpstreamFetchCache.set(cacheKey, now);
    }

    await git(
      cwd,
      "fetch",
      "--quiet",
      parsedTracking.remote,
      `+refs/heads/${parsedTracking.branch}:refs/remotes/${parsedTracking.remote}/${parsedTracking.branch}`
    );
    return true;
  }

  async function currentBranchFromStatus(cwd) {
    const output = await git(cwd, "status", "--porcelain=v1", "-b");
    const branchLine = output.trim().split("\n").filter(Boolean)[0] || "";
    return parseBranchFromStatus(branchLine);
  }

  async function pushRemoteAvailable(cwd, tracking) {
    const remoteName = trackingRemoteName(tracking) || "origin";
    return remoteExists(cwd, remoteName);
  }

  async function remoteExists(cwd, remoteName) {
    try {
      const output = await git(cwd, "config", "--get", `remote.${remoteName}.url`);
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  async function remoteBranchExists(cwd, branchName) {
    try {
      await git(cwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  async function detectDefaultBranch(cwd, branches) {
    try {
      const ref = await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
      const defaultBranch = ref.trim().replace("refs/remotes/origin/", "");
      if (defaultBranch) return defaultBranch;
    } catch {
      // origin/HEAD not recorded - fall through to remote/local probes.
    }

    if (await remoteBranchExists(cwd, "main")) return "main";
    if (await remoteBranchExists(cwd, "master")) return "master";

    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
    return branches[0] || null;
  }

  return {
    currentBranchFromStatus,
    detectDefaultBranch,
    isInsideGitWorkTree,
    pushRemoteAvailable,
    refreshStatusUpstreamIfNeeded,
    remoteBranchExists,
    revListCounts,
  };
}

module.exports = { createGitOpsStatusHelpers };
