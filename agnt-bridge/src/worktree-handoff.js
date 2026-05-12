// FILE: worktree-handoff.js
// Purpose: Moves or copies local changes between a workspace cwd and a
//          freshly created worktree. agnt's `gitCreateWorktree`,
//          `gitCreateManagedWorktree`, and `gitTransferManagedHandoff` use
//          this to keep iOS-driven worktree creation seamless — the user's
//          uncommitted changes follow the branch into the new worktree
//          (or get copied so both sides see them).
// Layer: bridge utility — factory takes the few git primitives it needs
//        (`git`, `gitError`, `diffPatchForUntrackedFiles`) so this module
//        has no implicit coupling back to git-handler.js's other internals.
// Exports: createWorktreeHandoff (factory), plus the pure path/text helpers
//          (`gitPathspecArgs`, `normalizeGitPathspec`, `ensureTrailingNewline`,
//          `resolveWorktreeChangeTransfer`) that don't need any deps.
//
// Why a module: this used to be 9 git-touching helpers
// (`stashChangesForWorktreeHandoff`, `captureLocalChangesPatch`,
// `findStashRefByLabel`, `applyWorktreeHandoffStash`,
// `applyCopiedLocalChangesToWorktree`, `restoreWorktreeHandoffStash`,
// `rollbackFailedHandoffTransfer`, `cleanupManagedWorktree`,
// `scopedProjectChanges`) plus four pure path helpers, all sitting in the
// middle of git-handler.js next to unrelated git plumbing. Together they
// form a coherent unit: stash → apply → rollback / clean. Lifting them
// makes the move-vs-copy semantics visible in one place and lets the
// factory be tested in isolation with a fake `git`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 *   — git-handler's shell-out helper. Identical contract: returns stdout
 *     on success, rejects with a git CLI error on failure.
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 *   — git-handler's tagged-error builder. Errors thrown from this module
 *     carry `errorCode` so the iOS app can render the right reason.
 * @param {(cwd: string, filePaths: string[]) => Promise<string>}
 *   deps.diffPatchForUntrackedFiles
 *   — git-handler's helper that materializes a patch for files that aren't
 *     yet tracked. Used by `captureLocalChangesPatch` to keep new files
 *     in the handoff.
 */
function createWorktreeHandoff({ git, gitError, diffPatchForUntrackedFiles }) {
  // ── stash-based handoff (the default "move" path) ──────────────────────

  // Stash all changes — tracked + untracked — under a unique label so we
  // can find the ref deterministically across an opaque `git stash` index.
  async function stashChangesForWorktreeHandoff(cwd, pathspecArgs = []) {
    const stashLabel = `agnt-worktree-handoff-${randomBytes(6).toString("hex")}`;
    const output = await git(
      cwd,
      "stash",
      "push",
      "--include-untracked",
      "--message",
      stashLabel,
      ...pathspecArgs
    );
    if (output.includes("No local changes")) {
      return null;
    }

    const stashRef = await findStashRefByLabel(cwd, stashLabel);
    if (!stashRef) {
      throw gitError("create_worktree_failed", "Could not prepare local changes for the worktree handoff.");
    }
    return stashRef;
  }

  // git stash's stash@{N} index isn't stable when other stashes land in
  // parallel; resolve by label instead so we don't pop the wrong entry.
  async function findStashRefByLabel(cwd, stashLabel) {
    const output = await git(cwd, "stash", "list", "--format=%gd%x00%s");
    const records = output
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const record of records) {
      const [ref, summary] = record.split("\0");
      if (ref && summary?.includes(stashLabel)) {
        return ref.trim();
      }
    }
    return null;
  }

  async function applyWorktreeHandoffStash(cwd, stashRef, options = {}) {
    const dropAfterApply = options.dropAfterApply === true;
    try {
      if (dropAfterApply) {
        await git(cwd, "stash", "apply", stashRef);
        await git(cwd, "stash", "drop", stashRef);
      } else {
        await git(cwd, "stash", "pop", stashRef);
      }
    } catch (err) {
      throw gitError(
        "create_worktree_failed",
        err.message || "Could not apply local changes in the new worktree."
      );
    }
  }

  // Best-effort: if the destination apply fails we try to restore the
  // source side so the user doesn't lose work. Failures here are swallowed
  // because the primary error (the destination apply) is what should
  // surface.
  async function restoreWorktreeHandoffStash(cwd, stashRef) {
    try {
      await git(cwd, "stash", "pop", stashRef);
    } catch {
      // intentional — see comment above.
    }
  }

  // ── patch-based handoff (the "copy" path) ──────────────────────────────

  // Build a single unified diff covering tracked changes + untracked files
  // so the destination worktree can replay it with `git apply`. Used when
  // the caller asked for `changeTransfer: "copy"` instead of "move".
  async function captureLocalChangesPatch(cwd, pathspecArgs = []) {
    const trackedPatch = await git(cwd, "diff", "--binary", "--find-renames", "HEAD", ...pathspecArgs);
    const porcelain = await git(cwd, "status", "--porcelain=v1", ...pathspecArgs);
    const untrackedPaths = porcelain
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.substring(3).trim())
      .filter(Boolean);
    const untrackedPatch = await diffPatchForUntrackedFiles(cwd, untrackedPaths);
    return [trackedPatch, untrackedPatch]
      .filter((patch) => typeof patch === "string" && patch.trim())
      .map(ensureTrailingNewline)
      .join("\n");
  }

  async function applyCopiedLocalChangesToWorktree(cwd, patch) {
    if (!patch.trim()) return;

    const patchFilePath = path.join(os.tmpdir(), `agnt-worktree-copy-${randomBytes(6).toString("hex")}.patch`);
    fs.writeFileSync(patchFilePath, ensureTrailingNewline(patch), "utf8");

    try {
      await git(cwd, "apply", "--binary", "--whitespace=nowarn", patchFilePath);
    } catch (err) {
      throw gitError(
        "create_worktree_failed",
        err.message || "Could not copy local changes into the new worktree."
      );
    } finally {
      fs.rmSync(patchFilePath, { force: true });
    }
  }

  // ── rollback / cleanup ─────────────────────────────────────────────────

  // Used after a failed transfer to put the destination back in a clean
  // state. Best-effort on every step — we prefer surfacing the original
  // transfer error to the user instead of a cascaded restore failure.
  async function rollbackFailedHandoffTransfer(cwd, pathspecArgs = []) {
    if (pathspecArgs.length > 0) {
      try {
        await git(cwd, "restore", "--source=HEAD", "--staged", "--worktree", ...pathspecArgs);
      } catch {
        // best effort — see comment above
      }

      try {
        await git(cwd, "clean", "-fd", ...pathspecArgs);
      } catch {
        // best effort — see comment above
      }
      return;
    }

    try {
      await git(cwd, "reset", "--hard", "HEAD");
    } catch {
      // best effort
    }

    try {
      await git(cwd, "clean", "-fd");
    } catch {
      // best effort
    }
  }

  async function cleanupManagedWorktree(repoRoot, worktreeRootPath, branchName = null) {
    try {
      await git(repoRoot, "worktree", "remove", "--force", worktreeRootPath);
    } catch {
      // Fall back to the directory rm below.
    }

    if (branchName) {
      try {
        await git(repoRoot, "branch", "-D", branchName);
      } catch {
        // Best-effort branch deletion; Git may refuse on safety grounds.
      }
    }

    fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
  }

  // ── scope helpers ──────────────────────────────────────────────────────

  // For repos held in a parent worktree-of-worktrees, the bridge scopes
  // changes to the current project subdirectory so multiple parallel
  // workspaces in the same repo don't pull each other's edits.
  async function scopedProjectChanges(repoRoot, projectRelativePath) {
    const pathspecArgs = gitPathspecArgs(projectRelativePath);
    const porcelain = await git(repoRoot, "status", "--porcelain=v1", ...pathspecArgs);
    const fileLines = porcelain
      .trim()
      .split("\n")
      .filter(Boolean);

    return {
      dirty: fileLines.length > 0,
      fileLines,
      pathspecArgs,
    };
  }

  return {
    applyCopiedLocalChangesToWorktree,
    applyWorktreeHandoffStash,
    captureLocalChangesPatch,
    cleanupManagedWorktree,
    findStashRefByLabel,
    restoreWorktreeHandoffStash,
    rollbackFailedHandoffTransfer,
    scopedProjectChanges,
    stashChangesForWorktreeHandoff,
  };
}

// ── pure helpers (no factory needed) ──────────────────────────────────────

// "copy" → copy changes into the new worktree, leave Local dirty.
// "none" → skip the change transfer entirely.
// anything else (incl. undefined) → "move", the historic default.
function resolveWorktreeChangeTransfer(rawValue) {
  const normalizedValue = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
  if (normalizedValue === "copy") return "copy";
  if (normalizedValue === "none") return "none";
  return "move";
}

// Convert a project-relative path into pathspec args for git. Empty input
// returns an empty array so the caller can `...pathspecArgs` it without
// branching.
function gitPathspecArgs(projectRelativePath) {
  const normalizedPath = normalizeGitPathspec(projectRelativePath);
  if (!normalizedPath) return [];
  return ["--", normalizedPath];
}

function normalizeGitPathspec(projectRelativePath) {
  if (typeof projectRelativePath !== "string") return "";
  const trimmedPath = projectRelativePath.trim();
  if (!trimmedPath) return "";
  return trimmedPath.split(path.sep).join("/");
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

module.exports = {
  createWorktreeHandoff,
  ensureTrailingNewline,
  gitPathspecArgs,
  normalizeGitPathspec,
  resolveWorktreeChangeTransfer,
};
