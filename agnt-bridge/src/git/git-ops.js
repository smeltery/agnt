// FILE: git-ops.js
// Purpose: The bridge's user-facing git RPC methods — status, init, diff,
//          commit, push, pull, branches, checkout, log, create-branch,
//          stash family, reset-to-remote, remote-url, plus the
//          `gitBranchesWithStatus` combinator. Each is a thin wrapper over
//          the git CLI with the documented JSON-RPC return shape.
// Layer: bridge utility — factory takes the git primitives and shared
//        helpers it needs as deps so this module has no implicit coupling
//        back to git-handler.js's other internals.
// Exports: createGitOps (factory).
//
// Why a module: git-handler.js used to inline all 15 ops + 14 private
// parsing/state helpers across ~600 lines, interleaved with worktree
// orchestration, AI-draft entry points, and low-level git plumbing. The
// ops are the largest coherent unit — each one is a JSON-RPC handler the
// iOS app calls directly — so lifting them gives the file a much smaller
// surface and creates a clear seam for future ops to land in.

const fs = require("fs");
const path = require("path");
const {
  computeState,
  gitInitBranchFlagUnsupported,
  nonRepositoryStatus,
  normalizeBranchListEntry,
  parseBranchFromStatus,
  parseOwnerRepo,
  parseTrackingFromStatus,
  trackingRemoteName,
} = require("./git-ops-parsing");
const { createGitOpsStatusHelpers } = require("./git-ops-status-helpers");

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 * @param {(cwd: string, branchName: string) => Promise<boolean>} deps.localBranchExists
 *   — shared with the worktree entry points in git-handler.js
 * @param {(rawName: string) => string} deps.normalizeCreatedBranchName
 * @param {(cwd: string, branchName: string) => Promise<void>} deps.assertValidCreatedBranchName
 * @param {(cwd: string) => Promise<string|null>} deps.resolveRepoRoot
 * @param {(cwd: string) => Promise<string|null>} deps.resolveLocalCheckoutRoot
 * @param {(cwd: string, refName: string) => Promise<boolean>} deps.refExists
 * @param {(cwd: string, repoRoot: string|null) => string} deps.resolveProjectRelativePath
 * @param {(checkoutRoot: string, projectRelativePath: string) => string} deps.scopedLocalCheckoutPath
 * @param {(cwd: string, options?: { projectRelativePath?: string }) => Promise<object>} deps.gitWorktreePathByBranch
 * @param {(cwd: string, context: object) => Promise<{ additions: number, deletions: number, binaryFiles: number }>} deps.repoDiffTotals
 * @param {(cwd: string, context: object) => Promise<number>} deps.countLocalOnlyCommits
 * @param {(cwd: string, tracking: string|null) => Promise<string>} deps.resolveRepoDiffBase
 * @param {(cwd: string, baseRef: string) => Promise<string>} deps.gitDiffAgainstBase
 * @param {(cwd: string, filePaths: string[]) => Promise<string>} deps.diffPatchForUntrackedFiles
 */
function createGitOps({
  git,
  gitError,
  localBranchExists,
  normalizeCreatedBranchName,
  assertValidCreatedBranchName,
  resolveRepoRoot,
  resolveLocalCheckoutRoot,
  refExists,
  resolveProjectRelativePath,
  scopedLocalCheckoutPath,
  gitWorktreePathByBranch,
  repoDiffTotals,
  countLocalOnlyCommits,
  resolveRepoDiffBase,
  gitDiffAgainstBase,
  diffPatchForUntrackedFiles,
}) {
  const {
    currentBranchFromStatus,
    detectDefaultBranch,
    isInsideGitWorkTree,
    pushRemoteAvailable,
    refreshStatusUpstreamIfNeeded,
    remoteBranchExists,
    revListCounts,
  } = createGitOpsStatusHelpers({ git });

  // ── status / init / diff / commit ─────────────────────────────────────

  async function gitStatus(cwd) {
    if (!(await isInsideGitWorkTree(cwd))) {
      return nonRepositoryStatus(cwd);
    }

    const [porcelain, repoRoot] = await Promise.all([
      git(cwd, "status", "--porcelain=v1", "-b"),
      resolveRepoRoot(cwd).catch(() => null),
    ]);

    const lines = porcelain.trim().split("\n").filter(Boolean);
    const branchLine = lines[0] || "";
    const fileLines = lines.slice(1);

    const branch = parseBranchFromStatus(branchLine);
    const tracking = parseTrackingFromStatus(branchLine);
    const files = fileLines.map((line) => ({
      path: line.substring(3).trim(),
      status: line.substring(0, 2).trim(),
    }));

    await refreshStatusUpstreamIfNeeded(cwd, tracking, repoRoot).catch(() => false);
    const branchInfo = await revListCounts(cwd).catch(() => ({ ahead: 0, behind: 0 }));

    const dirty = files.length > 0;
    const { ahead, behind } = branchInfo;
    const detached = branchLine.includes("HEAD detached") || branchLine.includes("no branch");
    const noUpstream = tracking === null && !detached;
    const hasHeadCommit = await refExists(cwd, "HEAD").catch(() => false);
    const hasPushRemote = await pushRemoteAvailable(cwd, tracking).catch(() => false);
    const publishedToRemote = !detached && !!branch && await remoteBranchExists(cwd, branch).catch(() => false);
    const localOnlyCommitCount = await countLocalOnlyCommits(cwd, { detached }).catch(() => 0);
    const state = computeState(dirty, ahead, behind, detached, noUpstream);
    const canPush = hasPushRemote && hasHeadCommit && (ahead > 0 || noUpstream) && !detached;
    const diff = await repoDiffTotals(cwd, { tracking, fileLines })
      .catch(() => ({ additions: 0, deletions: 0, binaryFiles: 0 }));

    return {
      isRepo: true,
      repoRoot,
      branch,
      tracking,
      dirty,
      hasHeadCommit,
      hasPushRemote,
      ahead,
      behind,
      localOnlyCommitCount,
      state,
      canPush,
      publishedToRemote,
      files,
      diff,
    };
  }

  async function gitInit(cwd) {
    if (await isInsideGitWorkTree(cwd)) {
      throw gitError("already_git_repository", "This folder is already inside a Git repository.");
    }

    if (fs.existsSync(path.join(cwd, ".git"))) {
      throw gitError("git_metadata_exists", "A .git entry already exists in this folder.");
    }

    try {
      await git(cwd, "init", "-b", "main");
    } catch (err) {
      if (gitInitBranchFlagUnsupported(err)) {
        await git(cwd, "init");
        await git(cwd, "symbolic-ref", "HEAD", "refs/heads/main");
      } else {
        throw gitError("git_init_failed", err.message || "Git initialization failed.");
      }
    }

    return { status: await gitStatus(cwd) };
  }

  async function gitDiff(cwd) {
    const porcelain = await git(cwd, "status", "--porcelain=v1", "-b");
    const lines = porcelain.trim().split("\n").filter(Boolean);
    const branchLine = lines[0] || "";
    const fileLines = lines.slice(1);
    const tracking = parseTrackingFromStatus(branchLine);
    const baseRef = await resolveRepoDiffBase(cwd, tracking);
    const trackedPatch = await gitDiffAgainstBase(cwd, baseRef);
    const untrackedPaths = fileLines
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.substring(3).trim())
      .filter(Boolean);
    const untrackedPatch = await diffPatchForUntrackedFiles(cwd, untrackedPaths);
    const patch = [trackedPatch.trim(), untrackedPatch.trim()].filter(Boolean).join("\n\n").trim();
    return { patch };
  }

  async function gitCommit(cwd, params) {
    const message =
      typeof params.message === "string" && params.message.trim()
        ? params.message.trim()
        : "Changes from Codex";

    const statusCheck = await git(cwd, "status", "--porcelain");
    if (!statusCheck.trim()) {
      throw gitError("nothing_to_commit", "Nothing to commit.");
    }

    await git(cwd, "add", "-A");
    const output = await git(cwd, "commit", "-m", message);

    const hashMatch = output.match(/\[(\S+)\s+([a-f0-9]+)\]/);
    const hash = hashMatch ? hashMatch[2] : "";
    const branch = hashMatch ? hashMatch[1] : "";
    const summaryMatch = output.match(/\d+ files? changed/);
    const summary = summaryMatch ? summaryMatch[0] : output.split("\n").pop()?.trim() || "";

    return { hash, branch, summary };
  }

  // ── push / pull ────────────────────────────────────────────────────────

  async function gitPush(cwd) {
    try {
      const statusOutput = await git(cwd, "status", "--porcelain=v1", "-b");
      const branchLine = statusOutput.trim().split("\n").filter(Boolean)[0] || "";
      const tracking = parseTrackingFromStatus(branchLine);
      if (!(await pushRemoteAvailable(cwd, tracking))) {
        throw gitError("no_remote", "Add a Git remote before pushing.");
      }
      const remote = trackingRemoteName(tracking) || "origin";

      const branchOutput = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      const branch = branchOutput.trim();

      try {
        await git(cwd, "push");
      } catch (pushErr) {
        if (
          pushErr.message?.includes("no upstream") ||
          pushErr.message?.includes("has no upstream branch")
        ) {
          await git(cwd, "push", "--set-upstream", remote, branch);
        } else {
          throw pushErr;
        }
      }

      const status = await gitStatus(cwd);
      return { branch, remote, status };
    } catch (err) {
      if (err.errorCode) throw err;
      if (err.message?.includes("rejected")) {
        throw gitError("push_rejected", "Push rejected. Pull changes first.");
      }
      throw gitError("push_failed", err.message || "Push failed.");
    }
  }

  async function gitPull(cwd) {
    try {
      await git(cwd, "pull", "--rebase");
      const status = await gitStatus(cwd);
      return { success: true, status };
    } catch (err) {
      try {
        await git(cwd, "rebase", "--abort");
      } catch {
        // ignore abort errors
      }
      if (err.errorCode) throw err;
      throw gitError("pull_conflict", "Pull failed due to conflicts. Rebase aborted.");
    }
  }

  // ── branches / checkout / log / create ─────────────────────────────────

  async function gitBranches(cwd) {
    const [output, repoRoot, localCheckoutRoot] = await Promise.all([
      git(cwd, "branch", "--no-color"),
      resolveRepoRoot(cwd).catch(() => null),
      resolveLocalCheckoutRoot(cwd).catch(() => null),
    ]);
    const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
    const worktreePathByBranch = await gitWorktreePathByBranch(cwd, { projectRelativePath }).catch(() => ({}));
    const localCheckoutPath = scopedLocalCheckoutPath(localCheckoutRoot || repoRoot, projectRelativePath);
    const lines = output.trim().split("\n").filter(Boolean);

    let current = "";
    const branchSet = new Set();
    const branchesCheckedOutElsewhere = new Set();

    for (const line of lines) {
      const entry = normalizeBranchListEntry(line);
      if (!entry) continue;

      const { isCurrent, isCheckedOutElsewhere, name } = entry;

      if (name.includes("HEAD detached") || name === "(no branch)") {
        if (isCurrent) current = "HEAD";
        continue;
      }

      branchSet.add(name);
      if (isCheckedOutElsewhere) branchesCheckedOutElsewhere.add(name);
      if (isCurrent) current = name;
    }

    if (!current) {
      const unbornBranch = await currentBranchFromStatus(cwd).catch(() => null);
      if (unbornBranch) {
        current = unbornBranch;
        if (!branchSet.has(unbornBranch)) branchSet.add(unbornBranch);
      }
    }
    const resolvedBranches = [...branchSet].sort();
    const defaultBranch = await detectDefaultBranch(cwd, resolvedBranches);

    return {
      branches: resolvedBranches,
      branchesCheckedOutElsewhere: [...branchesCheckedOutElsewhere].sort(),
      worktreePathByBranch,
      localCheckoutPath,
      current,
      default: defaultBranch,
      defaultBranch,
    };
  }

  async function gitCheckout(cwd, params) {
    const branch = typeof params.branch === "string" ? params.branch.trim() : "";
    if (!branch) {
      throw gitError("missing_branch", "Branch name is required.");
    }

    try {
      await git(cwd, "switch", branch);
    } catch (err) {
      if (err.message?.includes("untracked working tree files would be overwritten")) {
        throw gitError(
          "checkout_conflict_untracked_collision",
          "Cannot switch branches: untracked files would be overwritten."
        );
      }
      if (err.message?.includes("local changes to the following files would be overwritten")) {
        throw gitError(
          "checkout_conflict_dirty_tree",
          "Cannot switch branches: tracked local changes would be overwritten."
        );
      }
      if (err.message?.includes("already used by worktree") || err.message?.includes("already checked out at")) {
        throw gitError(
          "checkout_branch_in_other_worktree",
          "Cannot switch branches: this branch is already open in another worktree."
        );
      }
      if (err.message?.includes("invalid reference") || err.message?.includes("unknown revision")) {
        throw gitError("branch_not_found", `Branch '${branch}' does not exist locally.`);
      }
      throw gitError("checkout_failed", err.message || "Checkout failed.");
    }

    const status = await gitStatus(cwd);
    return { current: status.branch || branch, tracking: status.tracking, status };
  }

  async function gitLog(cwd) {
    const output = await git(cwd, "log", "-20", "--format=%H%x00%s%x00%an%x00%aI");
    const commits = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author, date] = line.split("\0");
        return {
          hash: hash?.substring(0, 7) || "",
          message: message || "",
          author: author || "",
          date: date || "",
        };
      });
    return { commits };
  }

  async function gitCreateBranch(cwd, params) {
    const name = normalizeCreatedBranchName(params.name);
    if (!name) {
      throw gitError("missing_branch_name", "Branch name is required.");
    }
    await assertValidCreatedBranchName(cwd, name);

    // Keep create-branch local-first so we never fork history under a remote-only name.
    if (!(await localBranchExists(cwd, name)) && await remoteBranchExists(cwd, name)) {
      throw gitError(
        "branch_exists",
        `Branch '${name}' already exists on origin. Check it out locally instead of creating a new branch.`
      );
    }

    try {
      await git(cwd, "switch", "-c", name);
    } catch (err) {
      if (err.message?.includes("already exists")) {
        throw gitError("branch_exists", `Branch '${name}' already exists.`);
      }
      throw gitError("create_branch_failed", err.message || "Failed to create branch.");
    }

    const status = await gitStatus(cwd);
    return { branch: name, status };
  }

  // ── stash family / reset / remote-url ──────────────────────────────────

  async function gitStash(cwd) {
    const output = await git(cwd, "stash", "push", "--include-untracked");
    const saved = !output.includes("No local changes");
    return { success: saved, message: output.trim() };
  }

  async function gitStashPop(cwd) {
    try {
      const output = await git(cwd, "stash", "pop");
      return { success: true, message: output.trim() };
    } catch (err) {
      throw gitError("stash_pop_conflict", err.message || "Stash pop failed due to conflicts.");
    }
  }

  async function gitResetToRemote(cwd, params) {
    if (params.confirm !== "discard_runtime_changes") {
      throw gitError(
        "confirmation_required",
        'This action requires params.confirm === "discard_runtime_changes".'
      );
    }

    let hasUpstream = true;
    try {
      await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    } catch {
      hasUpstream = false;
    }

    if (hasUpstream) {
      await git(cwd, "fetch");
      await git(cwd, "reset", "--hard", "@{u}");
    } else {
      await git(cwd, "checkout", "--", ".");
    }
    await git(cwd, "clean", "-fd");

    const status = await gitStatus(cwd);
    return { success: true, status };
  }

  async function gitRemoteUrl(cwd) {
    const raw = (await git(cwd, "config", "--get", "remote.origin.url")).trim();
    const ownerRepo = parseOwnerRepo(raw);
    return { url: raw, ownerRepo };
  }

  // ── branches + status combinator ───────────────────────────────────────

  async function gitBranchesWithStatus(cwd) {
    const initialStatus = await gitStatus(cwd);
    if (initialStatus.isRepo === false) {
      return {
        branches: [],
        branchesCheckedOutElsewhere: [],
        worktreePathByBranch: {},
        localCheckoutPath: null,
        current: null,
        default: null,
        defaultBranch: null,
        status: initialStatus,
      };
    }

    const [branchResult, statusResult] = await Promise.all([
      gitBranches(cwd),
      gitStatus(cwd),
    ]);
    return { ...branchResult, status: statusResult };
  }

  return {
    gitBranches,
    gitBranchesWithStatus,
    gitCheckout,
    gitCommit,
    gitCreateBranch,
    gitDiff,
    gitInit,
    gitLog,
    gitPull,
    gitPush,
    gitRemoteUrl,
    gitResetToRemote,
    gitStash,
    gitStashPop,
    gitStatus,
  };
}

module.exports = {
  createGitOps,
  // Pure helpers exposed for direct contract testing.
  computeState,
  gitInitBranchFlagUnsupported,
  nonRepositoryStatus,
  normalizeBranchListEntry,
  parseBranchFromStatus,
  parseOwnerRepo,
  parseTrackingFromStatus,
  trackingRemoteName,
};
