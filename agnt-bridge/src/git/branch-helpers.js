// FILE: branch-helpers.js
// Purpose: Branch / ref validation + worktree-path helpers shared across
//          git-ops, worktree-actions, pr-creation, draft-actions, and
//          diff-helpers.
// Layer: bridge utility — factory takes the git primitives + the
//        scoped-worktree-path helper as deps so this module has no
//        implicit coupling back to git-handler.js's other internals.
// Exports: createBranchHelpers (factory), plus the three pure helpers
//          (normalizeWorktreeBranchRef, normalizeCreatedBranchName,
//          resolveBaseBranchName) for direct contract testing.
//
// Why a module: these eight helpers used to be scattered across
// git-handler.js between the dispatcher and the path utilities. They
// share a domain (branch names + ref paths + worktree-path tables)
// and they're already injected into every extracted module via the
// factory pattern; lifting them into their own file makes the
// shared-helper graph easier to read and shrinks git-handler.js's
// connective tissue.

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 * @param {(worktreeRootPath: string, projectRelativePath: string) => string} deps.scopedWorktreePath
 *   — used by parseWorktreePathByBranch so each branch-to-path entry
 *     points at the correct project subdirectory inside the worktree.
 * @returns {{
 *   refExists: Function,
 *   localBranchExists: Function,
 *   assertValidCreatedBranchName: Function,
 *   gitWorktreePathByBranch: Function,
 *   parseWorktreePathByBranch: Function,
 * }}
 */
function createBranchHelpers({ git, gitError, scopedWorktreePath }) {
  // ── ref existence ──────────────────────────────────────────────────────

  async function refExists(cwd, refName) {
    try {
      await git(cwd, "show-ref", "--verify", "--quiet", refName);
      return true;
    } catch {
      return false;
    }
  }

  async function localBranchExists(cwd, branchName) {
    try {
      await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  // ── created-branch validation ──────────────────────────────────────────

  async function assertValidCreatedBranchName(cwd, branchName) {
    try {
      await git(cwd, "check-ref-format", "--branch", branchName);
    } catch {
      throw gitError("invalid_branch_name", `Branch '${branchName}' is not a valid Git branch name.`);
    }
  }

  // ── worktree-path table ────────────────────────────────────────────────

  async function gitWorktreePathByBranch(cwd, options = {}) {
    const output = await git(cwd, "worktree", "list", "--porcelain");
    return parseWorktreePathByBranch(output, options);
  }

  // Parses `git worktree list --porcelain` into a {branchName: scopedPath}
  // map. The porcelain format separates records with blank lines and tags
  // each line with a key prefix; we pick out the worktree path and the
  // branch ref. `scopedWorktreePath` re-anchors the path under the
  // project-relative subdirectory so the iOS app's worktree links open the
  // right place when the user is working inside a sub-project.
  function parseWorktreePathByBranch(output, options = {}) {
    const worktreePathByBranch = {};
    const records = typeof output === "string" ? output.split("\n\n") : [];
    const projectRelativePath = typeof options.projectRelativePath === "string"
      ? options.projectRelativePath
      : "";

    for (const record of records) {
      const lines = record
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) continue;

      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const worktreePath = worktreeLine?.slice("worktree ".length).trim();
      const branchName = normalizeWorktreeBranchRef(branchLine?.slice("branch ".length).trim());

      if (!worktreePath || !branchName) continue;

      worktreePathByBranch[branchName] = scopedWorktreePath(worktreePath, projectRelativePath);
    }

    return worktreePathByBranch;
  }

  return {
    refExists,
    localBranchExists,
    assertValidCreatedBranchName,
    gitWorktreePathByBranch,
    parseWorktreePathByBranch,
  };
}

// ── pure helpers (no factory needed) ──────────────────────────────────────

// Normalizes `git worktree list --porcelain` branch lines so the UI never
// sees the leading `refs/heads/` prefix.
function normalizeWorktreeBranchRef(rawRef) {
  const trimmed = typeof rawRef === "string" ? rawRef.trim() : "";
  if (!trimmed.startsWith("refs/heads/")) {
    return null;
  }
  const branchName = trimmed.slice("refs/heads/".length).trim();
  return branchName || null;
}

// Cleans up user-entered branch names: trims whitespace, converts internal
// whitespace inside each path segment into Git-friendly dashes, and
// prefixes `agnt/` so every bridge-created branch is namespaced.
function normalizeCreatedBranchName(rawName) {
  const trimmed = typeof rawName === "string" ? rawName.trim() : "";
  if (!trimmed) return "";

  // Keep slash-separated branch groups, but normalize whitespace inside
  // each segment into a Git-friendly dash.
  const normalized = trimmed
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, "-"))
    .join("/");

  if (normalized.startsWith("agnt/")) return normalized;
  return `agnt/${normalized}`;
}

// Picks the user-supplied base branch when one is provided, otherwise
// falls back to the repo's default branch.
function resolveBaseBranchName(rawBaseBranch, fallbackBranch) {
  const trimmedBaseBranch = typeof rawBaseBranch === "string" ? rawBaseBranch.trim() : "";
  if (trimmedBaseBranch) return trimmedBaseBranch;
  return typeof fallbackBranch === "string" && fallbackBranch.trim() ? fallbackBranch.trim() : "";
}

module.exports = {
  createBranchHelpers,
  normalizeCreatedBranchName,
  normalizeWorktreeBranchRef,
  resolveBaseBranchName,
};
