// FILE: worktree-actions.js
// Purpose: The bridge's worktree JSON-RPC entry points — create, create-
//          managed, transfer-managed-handoff, and remove. Each is an
//          orchestrator that combines git ops, the worktree-handoff state
//          machine, and path helpers into a single iOS-driven action.
// Layer: bridge utility — factory takes the many deps it needs so this
//        module has no implicit coupling back to git-handler.js's
//        internals.
// Exports: createWorktreeActions (factory).
//
// Why a module: these four entry points used to sit at module scope in
// git-handler.js (lines 373–682 originally), interleaved with everything
// else. They're heavy orchestrators — gitCreateWorktree alone is ~115
// lines — but the dep surface is well-defined: git ops + handoff helpers
// + path helpers + a handful of branch validators. Lifting them gives
// git-handler.js back the file structure of a router, and lets the
// orchestrators be reviewed as a coherent unit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 * @param {(cwd: string) => Promise<object>} deps.gitStatus
 * @param {(cwd: string) => Promise<object>} deps.gitBranches
 *
 * @param {(rawName: string) => string} deps.normalizeCreatedBranchName
 * @param {(cwd: string, branchName: string) => Promise<void>} deps.assertValidCreatedBranchName
 * @param {(cwd: string, branchName: string) => Promise<boolean>} deps.localBranchExists
 * @param {(rawBaseBranch: string|undefined, fallback: string|undefined) => string|null} deps.resolveBaseBranchName
 *
 * @param {(cwd: string) => Promise<string|null>} deps.resolveRepoRoot
 * @param {(cwd: string) => Promise<string|null>} deps.resolveLocalCheckoutRoot
 * @param {(cwd: string, repoRoot: string|null) => string} deps.resolveProjectRelativePath
 * @param {(worktreeRootPath: string, projectRelativePath: string) => string} deps.scopedWorktreePath
 * @param {(left: string, right: string) => boolean} deps.sameFilePath
 * @param {(candidatePath: string) => string|null} deps.normalizeExistingPath
 * @param {(candidatePath: string) => boolean} deps.isExistingDirectory
 * @param {(candidates: Array<unknown>) => string} deps.firstNonEmptyString
 * @param {(candidatePath: string) => boolean} deps.isManagedWorktreePath
 *
 * @param {object} deps.worktreeHandoff — output of createWorktreeHandoff(),
 *   carrying scopedProjectChanges + the stash/patch transfer helpers.
 * @param {(rawValue: unknown) => "move"|"copy"|"none"} deps.resolveWorktreeChangeTransfer
 *
 * @returns {{
 *   gitCreateWorktree: Function,
 *   gitCreateManagedWorktree: Function,
 *   gitTransferManagedHandoff: Function,
 *   gitRemoveWorktree: Function,
 * }}
 */
function createWorktreeActions({
  git,
  gitError,
  gitStatus,
  gitBranches,
  normalizeCreatedBranchName,
  assertValidCreatedBranchName,
  localBranchExists,
  resolveBaseBranchName,
  resolveRepoRoot,
  resolveLocalCheckoutRoot,
  resolveProjectRelativePath,
  scopedWorktreePath,
  sameFilePath,
  normalizeExistingPath,
  isExistingDirectory,
  firstNonEmptyString,
  isManagedWorktreePath,
  worktreeHandoff,
  resolveWorktreeChangeTransfer,
}) {
  const {
    scopedProjectChanges,
    captureLocalChangesPatch,
    stashChangesForWorktreeHandoff,
    applyWorktreeHandoffStash,
    applyCopiedLocalChangesToWorktree,
    cleanupManagedWorktree,
    restoreWorktreeHandoffStash,
    rollbackFailedHandoffTransfer,
  } = worktreeHandoff;

  // ── named-branch worktree (the default agnt parallel-thread flow) ──────

  async function gitCreateWorktree(cwd, params) {
    const branch = normalizeCreatedBranchName(params.name);
    if (!branch) {
      throw gitError("missing_branch_name", "Branch name is required.");
    }
    await assertValidCreatedBranchName(cwd, branch);

    const branchResult = await gitBranches(cwd);
    const repoRoot = await resolveRepoRoot(cwd);
    const status = await gitStatus(cwd);
    const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
    const changeScope = await scopedProjectChanges(repoRoot, projectRelativePath);
    const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.defaultBranch);
    const changeTransfer = resolveWorktreeChangeTransfer(params.changeTransfer);
    if (!baseBranch) {
      throw gitError("missing_base_branch", "Base branch is required.");
    }
    if (!(await localBranchExists(cwd, baseBranch))) {
      throw gitError(
        "missing_base_branch",
        `Base branch '${baseBranch}' is not available locally. Create or check out that branch first.`
      );
    }

    const currentBranch = typeof status.branch === "string" ? status.branch.trim() : "";
    const canCarryLocalChanges = changeScope.dirty && !!currentBranch && currentBranch === baseBranch;
    if (changeScope.dirty && changeTransfer !== "none" && !canCarryLocalChanges) {
      const currentBranchLabel = currentBranch || "the current branch";
      const transferVerb = changeTransfer === "copy" ? "copy" : "move";
      throw gitError(
        "dirty_worktree_base_mismatch",
        `Uncommitted changes can ${transferVerb} into a new worktree only from ${currentBranchLabel}. Switch the base branch to match or clean up local changes first.`
      );
    }

    const existingWorktreePath = branchResult.worktreePathByBranch[branch];
    if (existingWorktreePath) {
      if (sameFilePath(existingWorktreePath, cwd)) {
        throw gitError(
          "branch_already_open_here",
          `Branch '${branch}' is already open in this project.`
        );
      }

      return {
        branch,
        worktreePath: existingWorktreePath,
        alreadyExisted: true,
      };
    }

    const branchExists = await localBranchExists(cwd, branch);
    if (branchExists) {
      throw gitError(
        "branch_exists",
        `Branch '${branch}' already exists locally. Choose another name or open that branch instead.`
      );
    }

    const worktreeRootPath = allocateManagedWorktreePath(repoRoot, gitError);
    let handoffStashRef = null;
    let copiedLocalChangesPatch = "";
    let didCreateWorktree = false;

    try {
      if (canCarryLocalChanges) {
        if (changeTransfer === "copy") {
          copiedLocalChangesPatch = await captureLocalChangesPatch(repoRoot, changeScope.pathspecArgs);
        } else if (changeTransfer === "move") {
          handoffStashRef = await stashChangesForWorktreeHandoff(repoRoot, changeScope.pathspecArgs);
        }
      }

      await git(repoRoot, "worktree", "add", "-b", branch, worktreeRootPath, baseBranch);
      didCreateWorktree = true;

      if (handoffStashRef) {
        await applyWorktreeHandoffStash(worktreeRootPath, handoffStashRef);
      }
      if (copiedLocalChangesPatch) {
        await applyCopiedLocalChangesToWorktree(worktreeRootPath, copiedLocalChangesPatch);
      }
    } catch (err) {
      if (didCreateWorktree) {
        await cleanupManagedWorktree(repoRoot, worktreeRootPath, branch);
      } else {
        fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
      }

      if (handoffStashRef) {
        await restoreWorktreeHandoffStash(repoRoot, handoffStashRef);
      }

      if (err.message?.includes("invalid reference")) {
        throw gitError("missing_base_branch", `Base branch '${baseBranch}' does not exist.`);
      }
      if (err.message?.includes("already exists")) {
        throw gitError("branch_exists", `Branch '${branch}' already exists.`);
      }
      if (err.message?.includes("already used by worktree") || err.message?.includes("already checked out at")) {
        throw gitError(
          "branch_in_other_worktree",
          `Branch '${branch}' is already open in another worktree.`
        );
      }
      throw gitError("create_worktree_failed", err.message || "Failed to create worktree.");
    }

    const worktreePath = scopedWorktreePath(worktreeRootPath, projectRelativePath);
    return {
      branch,
      worktreePath,
      alreadyExisted: false,
    };
  }

  // ── detached-head managed worktree (the "scratchpad" flow) ─────────────

  async function gitCreateManagedWorktree(cwd, params) {
    const branchResult = await gitBranches(cwd);
    const repoRoot = await resolveRepoRoot(cwd);
    const status = await gitStatus(cwd);
    const projectRelativePath = resolveProjectRelativePath(cwd, repoRoot);
    const changeScope = await scopedProjectChanges(repoRoot, projectRelativePath);
    const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.defaultBranch);
    const changeTransfer = resolveWorktreeChangeTransfer(params.changeTransfer);
    if (!baseBranch) {
      throw gitError("missing_base_branch", "Base branch is required.");
    }
    if (!(await localBranchExists(cwd, baseBranch))) {
      throw gitError(
        "missing_base_branch",
        `Base branch '${baseBranch}' is not available locally. Create or check out that branch first.`
      );
    }

    const currentBranch = typeof status.branch === "string" ? status.branch.trim() : "";
    const canCarryLocalChanges = changeScope.dirty && !!currentBranch && currentBranch === baseBranch;
    if (changeScope.dirty && changeTransfer !== "none" && !canCarryLocalChanges) {
      const currentBranchLabel = currentBranch || "the current branch";
      const transferVerb = changeTransfer === "copy" ? "copy" : "move";
      throw gitError(
        "dirty_worktree_base_mismatch",
        `Uncommitted changes can ${transferVerb} into a managed worktree only from ${currentBranchLabel}. Switch the base branch to match or clean up local changes first.`
      );
    }

    const worktreeRootPath = allocateManagedWorktreePath(repoRoot, gitError);
    let handoffStashRef = null;
    let copiedLocalChangesPatch = "";
    let didCreateWorktree = false;

    try {
      if (canCarryLocalChanges) {
        if (changeTransfer === "copy") {
          copiedLocalChangesPatch = await captureLocalChangesPatch(repoRoot, changeScope.pathspecArgs);
        } else if (changeTransfer === "move") {
          handoffStashRef = await stashChangesForWorktreeHandoff(repoRoot, changeScope.pathspecArgs);
        }
      }

      await git(repoRoot, "worktree", "add", "--detach", worktreeRootPath, baseBranch);
      didCreateWorktree = true;

      if (handoffStashRef) {
        await applyWorktreeHandoffStash(worktreeRootPath, handoffStashRef);
      }
      if (copiedLocalChangesPatch) {
        await applyCopiedLocalChangesToWorktree(worktreeRootPath, copiedLocalChangesPatch);
      }
    } catch (err) {
      if (didCreateWorktree) {
        await cleanupManagedWorktree(repoRoot, worktreeRootPath);
      } else {
        fs.rmSync(path.dirname(worktreeRootPath), { recursive: true, force: true });
      }

      if (handoffStashRef) {
        await restoreWorktreeHandoffStash(repoRoot, handoffStashRef);
      }

      if (err.message?.includes("invalid reference")) {
        throw gitError("missing_base_branch", `Base branch '${baseBranch}' does not exist.`);
      }
      throw gitError("create_worktree_failed", err.message || "Failed to create managed worktree.");
    }

    const worktreePath = scopedWorktreePath(worktreeRootPath, projectRelativePath);
    return {
      worktreePath,
      alreadyExisted: false,
      baseBranch,
      headMode: "detached",
      transferredChanges: Boolean(handoffStashRef || copiedLocalChangesPatch),
    };
  }

  // ── handoff between two existing worktrees ─────────────────────────────

  async function gitTransferManagedHandoff(cwd, params) {
    const targetPath = firstNonEmptyString([params.targetPath, params.targetProjectPath]);
    if (!targetPath) {
      throw gitError("missing_handoff_target", "A handoff target path is required.");
    }
    if (!isExistingDirectory(cwd)) {
      throw gitError(
        "missing_handoff_source",
        "The current handoff source is not available on this Mac."
      );
    }
    if (!isExistingDirectory(targetPath)) {
      throw gitError(
        "missing_handoff_target",
        "The destination for this handoff is not available on this Mac."
      );
    }

    const [sourceRepoRoot, sourceLocalCheckoutRoot, targetRepoRoot, targetLocalCheckoutRoot] = await Promise.all([
      resolveRepoRoot(cwd),
      resolveLocalCheckoutRoot(cwd),
      resolveRepoRoot(targetPath),
      resolveLocalCheckoutRoot(targetPath),
    ]);

    const sourceCheckoutRoot = sourceLocalCheckoutRoot || sourceRepoRoot;
    const targetCheckoutRoot = targetLocalCheckoutRoot || targetRepoRoot;
    if (!sameFilePath(sourceCheckoutRoot, targetCheckoutRoot)) {
      throw gitError(
        "handoff_target_mismatch",
        "The selected handoff destination belongs to a different checkout."
      );
    }

    if (sameFilePath(cwd, targetPath)) {
      return {
        success: true,
        targetPath: normalizeExistingPath(targetPath) ?? targetPath,
        transferredChanges: false,
      };
    }

    const sourceProjectRelativePath = resolveProjectRelativePath(cwd, sourceRepoRoot);
    const targetProjectRelativePath = resolveProjectRelativePath(targetPath, targetRepoRoot);
    const [sourceChangeScope, targetChangeScope] = await Promise.all([
      scopedProjectChanges(sourceRepoRoot, sourceProjectRelativePath),
      scopedProjectChanges(targetRepoRoot, targetProjectRelativePath),
    ]);

    if (!sourceChangeScope.dirty) {
      return {
        success: true,
        targetPath: normalizeExistingPath(targetPath) ?? targetPath,
        transferredChanges: false,
      };
    }

    if (targetChangeScope.dirty) {
      throw gitError(
        "handoff_target_dirty",
        "The handoff destination already has uncommitted changes. Clean it up before moving this thread there."
      );
    }

    const stashRef = await stashChangesForWorktreeHandoff(sourceRepoRoot, sourceChangeScope.pathspecArgs);
    if (!stashRef) {
      return {
        success: true,
        targetPath: normalizeExistingPath(targetPath) ?? targetPath,
        transferredChanges: false,
      };
    }

    try {
      await applyWorktreeHandoffStash(targetRepoRoot, stashRef, { dropAfterApply: true });
    } catch (err) {
      await rollbackFailedHandoffTransfer(targetRepoRoot, targetChangeScope.pathspecArgs);
      await restoreWorktreeHandoffStash(sourceRepoRoot, stashRef);
      throw gitError(
        "handoff_transfer_failed",
        err.userMessage || err.message || "Could not move local changes into the handoff destination."
      );
    }

    return {
      success: true,
      targetPath: normalizeExistingPath(targetPath) ?? targetPath,
      transferredChanges: true,
    };
  }

  // ── remove a managed worktree ──────────────────────────────────────────

  async function gitRemoveWorktree(cwd, params) {
    const worktreeRootPath = await resolveRepoRoot(cwd).catch(() => null);
    const localCheckoutRoot = await resolveLocalCheckoutRoot(cwd).catch(() => null);
    const branch = typeof params.branch === "string" ? params.branch.trim() : "";

    if (!worktreeRootPath || !localCheckoutRoot) {
      throw gitError("missing_working_directory", "Could not resolve the worktree roots for cleanup.");
    }
    if (sameFilePath(worktreeRootPath, localCheckoutRoot)) {
      throw gitError("cannot_remove_local_checkout", "Cannot remove the main local checkout.");
    }
    if (!isManagedWorktreePath(worktreeRootPath)) {
      throw gitError("unmanaged_worktree", "Only managed worktrees can be removed automatically.");
    }

    await cleanupManagedWorktree(localCheckoutRoot, worktreeRootPath, branch || null);
    if (branch && await localBranchExists(localCheckoutRoot, branch)) {
      throw gitError(
        "worktree_cleanup_failed",
        `The temporary worktree was removed, but branch '${branch}' could not be deleted automatically.`
      );
    }
    return { success: true };
  }

  return {
    gitCreateWorktree,
    gitCreateManagedWorktree,
    gitTransferManagedHandoff,
    gitRemoveWorktree,
  };
}

// ── private helpers ──────────────────────────────────────────────────────

// Allocates a fresh ~/.codex/worktrees/<hex>/<repo>/ path. Retries up to
// 16 times to handle the (extremely unlikely) hex collision; throws
// create_worktree_failed if every attempt collides.
function allocateManagedWorktreePath(repoRoot, gitError) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const worktreesRoot = path.join(codexHome, "worktrees");
  fs.mkdirSync(worktreesRoot, { recursive: true });

  const repoName = path.basename(repoRoot) || "repo";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const token = randomBytes(2).toString("hex");
    const tokenDirectory = path.join(worktreesRoot, token);
    const worktreePath = path.join(tokenDirectory, repoName);
    if (fs.existsSync(tokenDirectory) || fs.existsSync(worktreePath)) {
      continue;
    }
    fs.mkdirSync(tokenDirectory, { recursive: true });
    return worktreePath;
  }

  throw gitError("create_worktree_failed", "Could not allocate a managed worktree path.");
}

module.exports = {
  createWorktreeActions,
};
