// FILE: git-handler.js
// Purpose: Intercepts git/* JSON-RPC methods and executes git commands locally on the Mac.
// Layer: Bridge handler
// Exports: handleGitRequest
// Depends on: child_process, fs, os, path, crypto

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { runStructuredCodexJson } = require("./codex-exec-runner");
const {
  buildCommitDraftPrompt,
  buildPullRequestDraftPrompt,
  buildThreadTitlePrompt,
  normalizeCommitDraft,
  normalizePullRequestDraft,
  normalizeThreadTitleDraft,
  truncateDraftPatch,
  wrapDraftGenerationError,
} = require("./git-draft-helpers");
const {
  createWorktreeHandoff,
  ensureTrailingNewline,
  gitPathspecArgs,
  normalizeGitPathspec,
  resolveWorktreeChangeTransfer,
} = require("./worktree-handoff");
const { createPullRequestActions } = require("./pr-creation");
const { createGitOps, normalizeBranchListEntry } = require("./git-ops");

const worktreeHandoff = createWorktreeHandoff({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  diffPatchForUntrackedFiles: (cwd, filePaths) => diffPatchForUntrackedFiles(cwd, filePaths),
});
const {
  applyCopiedLocalChangesToWorktree,
  applyWorktreeHandoffStash,
  captureLocalChangesPatch,
  cleanupManagedWorktree,
  findStashRefByLabel,
  restoreWorktreeHandoffStash,
  rollbackFailedHandoffTransfer,
  scopedProjectChanges,
  stashChangesForWorktreeHandoff,
} = worktreeHandoff;

const pullRequestActions = createPullRequestActions({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  gitHubCli: (cwd, args) => runGitHubCliImpl(cwd, args),
  gitStatus: (cwd) => gitStatus(cwd),
  gitCommit: (cwd, params) => gitCommit(cwd, params),
  gitPush: (cwd) => gitPush(cwd),
  gitBranches: (cwd) => gitBranches(cwd),
  gitGeneratePullRequestDraft: (cwd, params, options) => gitGeneratePullRequestDraft(cwd, params, options),
  resolveBaseBranchName: (raw, fallback) => resolveBaseBranchName(raw, fallback),
  normalizeNonEmptyLine: (raw) => normalizeNonEmptyLine(raw),
  assertValidCreatedBranchName: (cwd, name) => assertValidCreatedBranchName(cwd, name),
});
const {
  gitRunStackedAction,
  gitCreatePullRequest,
  gitCreateFeatureBranch,
} = pullRequestActions;

const gitOps = createGitOps({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  localBranchExists: (cwd, name) => localBranchExists(cwd, name),
  normalizeCreatedBranchName: (raw) => normalizeCreatedBranchName(raw),
  assertValidCreatedBranchName: (cwd, name) => assertValidCreatedBranchName(cwd, name),
  resolveRepoRoot: (cwd) => resolveRepoRoot(cwd),
  resolveLocalCheckoutRoot: (cwd) => resolveLocalCheckoutRoot(cwd),
  refExists: (cwd, ref) => refExists(cwd, ref),
  resolveProjectRelativePath: (cwd, repoRoot) => resolveProjectRelativePath(cwd, repoRoot),
  scopedLocalCheckoutPath: (checkoutRoot, projectRelativePath) => scopedLocalCheckoutPath(checkoutRoot, projectRelativePath),
  gitWorktreePathByBranch: (cwd, options) => gitWorktreePathByBranch(cwd, options),
  repoDiffTotals: (cwd, context) => repoDiffTotals(cwd, context),
  countLocalOnlyCommits: (cwd, context) => countLocalOnlyCommits(cwd, context),
  resolveRepoDiffBase: (cwd, tracking) => resolveRepoDiffBase(cwd, tracking),
  gitDiffAgainstBase: (cwd, baseRef) => gitDiffAgainstBase(cwd, baseRef),
  diffPatchForUntrackedFiles: (cwd, filePaths) => diffPatchForUntrackedFiles(cwd, filePaths),
});
const {
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
} = gitOps;

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
// Node defaults maxBuffer to 1 MiB; large repo diffs trip "stdout maxBuffer length exceeded".
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const GITHUB_CLI_TIMEOUT_MS = 120_000;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_GIT_WRITER_MODEL = "gpt-5.4-mini";

let runStructuredCodexJsonImpl = runStructuredCodexJson;
let runGitHubCliImpl = runGitHubCli;

function resolveGitWriterModel(rawModel) {
  const trimmed = typeof rawModel === "string" ? rawModel.trim() : "";
  return trimmed || DEFAULT_GIT_WRITER_MODEL;
}

/**
 * Intercepts git/* JSON-RPC methods and executes git commands locally.
 * @param {string} rawMessage - Raw WebSocket message
 * @param {(response: string) => void} sendResponse - Callback to send response back
 * @returns {boolean} true if message was handled, false if it should pass through
 */
function handleGitRequest(rawMessage, sendResponse, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return false;
  }

  const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
  if (!method.startsWith("git/") && !["thread/generateTitle", "thread/name/set"].includes(method)) {
    return false;
  }
  // thread/generateTitle drafts the title via the Codex CLI's structured-JSON
  // output mode. For other providers we skip the interception so the request
  // routes to the active provider's translator (which has its own heuristic).
  if (method === "thread/generateTitle" && options.codexTitleGeneration === false) {
    return false;
  }

  const id = parsed.id;
  const params = parsed.params || {};

  // Lets long-running git flows push interim progress events to the phone.
  const sendNotification = (notificationMethod, notificationParams) => {
    if (typeof notificationMethod !== "string" || !notificationMethod) {
      return;
    }
    sendResponse(JSON.stringify({
      method: notificationMethod,
      params: notificationParams ?? {},
    }));
  };

  const methodOptions = { ...options, sendNotification };

  handleGitMethod(method, params, methodOptions)
    .then((result) => {
      sendResponse(JSON.stringify({ id, result }));
      if (method === "thread/name/set") {
        options.onThreadNameSet?.(result);
      }
    })
    .catch((err) => {
      const errorCode = err.errorCode || "git_error";
      const message = err.userMessage || err.message || "Unknown git error";
      sendResponse(
        JSON.stringify({
          id,
          error: {
            code: -32000,
            message,
            data: { errorCode },
          },
        })
      );
    });

  return true;
}

async function handleGitMethod(method, params, options = {}) {
  if (method === "thread/generateTitle") {
    return threadGenerateTitle(params, options);
  }
  if (method === "thread/name/set") {
    return threadNameSet(params);
  }

  const cwd = await resolveGitCwd(params);

  switch (method) {
    case "git/status":
      return gitStatus(cwd);
    case "git/init":
      return gitInit(cwd);
    case "git/diff":
      return gitDiff(cwd);
    case "git/commit":
      return gitCommit(cwd, params);
    case "git/generateCommitMessage":
      return gitGenerateCommitMessage(cwd, params, options);
    case "git/push":
      return gitPush(cwd);
    case "git/pull":
      return gitPull(cwd);
    case "git/branches":
      return gitBranches(cwd);
    case "git/checkout":
      return gitCheckout(cwd, params);
    case "git/log":
      return gitLog(cwd);
    case "git/createBranch":
      return gitCreateBranch(cwd, params);
    case "git/createWorktree":
      return gitCreateWorktree(cwd, params);
    case "git/createManagedWorktree":
      return gitCreateManagedWorktree(cwd, params);
    case "git/transferManagedHandoff":
      return gitTransferManagedHandoff(cwd, params);
    case "git/removeWorktree":
      return gitRemoveWorktree(cwd, params);
    case "git/stash":
      return gitStash(cwd);
    case "git/stashPop":
      return gitStashPop(cwd);
    case "git/resetToRemote":
      return gitResetToRemote(cwd, params);
    case "git/remoteUrl":
      return gitRemoteUrl(cwd);
    case "git/generatePullRequestDraft":
      return gitGeneratePullRequestDraft(cwd, params, options);
    case "git/createPullRequest":
      return gitCreatePullRequest(cwd, params, options);
    case "git/runStackedAction":
      return gitRunStackedAction(cwd, params, options);
    case "git/branchesWithStatus":
      return gitBranchesWithStatus(cwd);
    default:
      throw gitError("unknown_method", `Unknown git method: ${method}`);
  }
}

// Owns mobile thread renames locally so they do not fall through to unsupported Codex RPC.
function threadNameSet(params) {
  const threadId = normalizeNonEmptyLine(params.threadId || params.thread_id || params.conversationId || params.conversation_id);
  const name = normalizeNonEmptyLine(params.name || params.threadName || params.thread_name || params.title);
  if (!threadId) {
    throw gitError("missing_thread_id", "A thread ID is required to rename a thread.");
  }
  if (!name) {
    throw gitError("missing_thread_name", "A thread name is required.");
  }

  return { threadId, thread_id: threadId, name, title: name };
}

// ─── Git Status ───────────────────────────────────────────────

async function gitGenerateCommitMessage(cwd, params, options = {}) {
  const model = resolveGitWriterModel(params.model);

  try {
    const context = await buildCommitDraftContext(cwd);
    const prompt = buildCommitDraftPrompt(context);
    const schema = {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string" },
        fullMessage: { type: "string" },
      },
      required: ["subject", "body", "fullMessage"],
      additionalProperties: false,
    };
    const draft = await runStructuredCodexJsonImpl({
      cwd,
      model,
      prompt,
      schema,
      codexAppPath: options.codexAppPath,
    });

    return normalizeCommitDraft(draft);
  } catch (error) {
    if (error?.errorCode) {
      throw error;
    }
    throw wrapDraftGenerationError(error, "commit");
  }
}

async function gitGeneratePullRequestDraft(cwd, params, options = {}) {
  const model = resolveGitWriterModel(params.model);

  try {
    const context = await buildPullRequestDraftContext(cwd, params);
    const prompt = buildPullRequestDraftPrompt(context);
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    };
    const draft = await runStructuredCodexJsonImpl({
      cwd,
      model,
      prompt,
      schema,
      codexAppPath: options.codexAppPath,
    });

    return normalizePullRequestDraft(draft);
  } catch (error) {
    if (error?.errorCode) {
      throw error;
    }
    throw wrapDraftGenerationError(error, "pull_request");
  }
}

async function threadGenerateTitle(params, options = {}) {
  const model = resolveGitWriterModel(params.model);
  const message = normalizeNonEmptyMultilineString(params.message || params.prompt);
  if (!message) {
    throw gitError("missing_thread_title_message", "A first message is required to generate a thread title.");
  }

  try {
    const cwd = resolveThreadTitleCwd(params.cwd || params.workingDirectory);
    const prompt = buildThreadTitlePrompt({
      message,
      attachmentCount: normalizeNonNegativeInteger(params.attachmentCount),
    });
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    };
    const draft = await runStructuredCodexJsonImpl({
      cwd,
      model,
      prompt,
      schema,
      codexAppPath: options.codexAppPath,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
    });

    return normalizeThreadTitleDraft(draft, message);
  } catch (error) {
    if (error?.errorCode) {
      throw error;
    }
    throw wrapDraftGenerationError(error, "thread_title");
  }
}

// ─── Git Push ─────────────────────────────────────────────────

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

  const worktreeRootPath = allocateManagedWorktreePath(repoRoot);
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

  const worktreeRootPath = allocateManagedWorktreePath(repoRoot);
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

// ─── Git Stash ────────────────────────────────────────────────

async function buildCommitDraftContext(cwd) {
  const [statusResult, repoRoot] = await Promise.all([
    gitStatus(cwd),
    resolveRepoRoot(cwd).catch(() => cwd),
  ]);

  if (!statusResult.dirty) {
    throw gitError("nothing_to_commit", "Nothing to commit.");
  }

  const trackedBase = await refExists(cwd, "HEAD") ? "HEAD" : EMPTY_TREE_HASH;
  const trackedPatch = await git(cwd, "diff", "--binary", "--find-renames", trackedBase);
  const untrackedPaths = statusResult.files
    .filter((file) => file.status === "??")
    .map((file) => file.path)
    .filter(Boolean);
  const untrackedPatch = await diffPatchForUntrackedFiles(cwd, untrackedPaths);
  const patch = truncateDraftPatch(
    [trackedPatch.trim(), untrackedPatch.trim()].filter(Boolean).join("\n\n").trim()
  );

  if (!patch) {
    throw gitError("nothing_to_commit", "Nothing to commit.");
  }

  return {
    repoRoot,
    branch: statusResult.branch || "HEAD",
    files: statusResult.files,
    diff: statusResult.diff || { additions: 0, deletions: 0, binaryFiles: 0 },
    patch,
  };
}

async function buildPullRequestDraftContext(cwd, params) {
  const branchResult = await gitBranches(cwd);
  const currentBranch = (branchResult.current || "").trim();
  const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.default || branchResult.defaultBranch);

  if (!currentBranch) {
    throw gitError("no_branch", "No current branch found.");
  }

  if (!baseBranch) {
    throw gitError("no_default_branch", "Could not determine the repository default branch.");
  }

  const baseRef = await resolvePullRequestBaseRef(cwd, baseBranch);
  const mergeBase = (await git(cwd, "merge-base", "HEAD", baseRef)).trim();
  const patch = truncateDraftPatch(
    (await git(cwd, "diff", "--binary", "--find-renames", `${mergeBase}..HEAD`)).trim()
  );
  const numstatOutput = await git(cwd, "diff", "--numstat", `${mergeBase}..HEAD`);
  const diff = parseNumstatTotals(numstatOutput);
  const commitList = (
    await git(cwd, "log", "--format=%h %s", `${mergeBase}..HEAD`)
  )
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);

  if (!patch && commitList.length === 0) {
    throw gitError("nothing_to_compare", "No branch changes are available for a pull request.");
  }

  return {
    repoRoot: await resolveRepoRoot(cwd).catch(() => cwd),
    currentBranch,
    baseBranch,
    mergeBase,
    diff,
    commitList,
    patch,
  };
}

// PRs compare against the remote base when possible, matching GitHub's base branch.
async function resolvePullRequestBaseRef(cwd, branchName) {
  const localRef = `refs/heads/${branchName}`;
  const remoteRef = `refs/remotes/origin/${branchName}`;

  if (await refExists(cwd, remoteRef)) {
    return remoteRef;
  }
  if (await refExists(cwd, localRef)) {
    return localRef;
  }

  return branchName;
}

async function refExists(cwd, refName) {
  try {
    await git(cwd, "show-ref", "--verify", "--quiet", refName);
    return true;
  } catch {
    return false;
  }
}


function normalizeNonEmptyLine(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  return rawValue.split("\n")[0].trim();
}

function normalizeNonEmptyMultilineString(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  return trimmed || "";
}

function normalizeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function resolveThreadTitleCwd(rawCwd) {
  const normalized = normalizeExistingPath(typeof rawCwd === "string" ? rawCwd : "");
  if (normalized && isExistingDirectory(normalized)) {
    return normalized;
  }
  return process.cwd();
}


async function gitWorktreePathByBranch(cwd, options = {}) {
  const output = await git(cwd, "worktree", "list", "--porcelain");
  return parseWorktreePathByBranch(output, options);
}


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

    if (!lines.length) {
      continue;
    }

    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const worktreePath = worktreeLine?.slice("worktree ".length).trim();
    const branchName = normalizeWorktreeBranchRef(branchLine?.slice("branch ".length).trim());

    if (!worktreePath || !branchName) {
      continue;
    }

    worktreePathByBranch[branchName] = scopedWorktreePath(worktreePath, projectRelativePath);
  }

  return worktreePathByBranch;
}

// Normalizes `git branch` output so the UI never sees worktree markers like `+ main`.
function normalizeWorktreeBranchRef(rawRef) {
  const trimmed = typeof rawRef === "string" ? rawRef.trim() : "";
  if (!trimmed.startsWith("refs/heads/")) {
    return null;
  }

  const branchName = trimmed.slice("refs/heads/".length).trim();
  return branchName || null;
}

function normalizeCreatedBranchName(rawName) {
  const trimmed = typeof rawName === "string" ? rawName.trim() : "";
  if (!trimmed) {
    return "";
  }

  // Keep slash-separated branch groups, but normalize user-entered whitespace into Git-friendly dashes.
  const normalized = trimmed
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, "-"))
    .join("/");

  if (normalized.startsWith("agnt/")) {
    return normalized;
  }
  return `agnt/${normalized}`;
}

function resolveBaseBranchName(rawBaseBranch, fallbackBranch) {
  const trimmedBaseBranch = typeof rawBaseBranch === "string" ? rawBaseBranch.trim() : "";
  if (trimmedBaseBranch) {
    return trimmedBaseBranch;
  }

  return typeof fallbackBranch === "string" && fallbackBranch.trim() ? fallbackBranch.trim() : "";
}

// Mirrors Codex-managed worktree paths under CODEX_HOME/worktrees/<token>/<repo>.
function allocateManagedWorktreePath(repoRoot) {
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

async function localBranchExists(cwd, branchName) {
  try {
    await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

async function assertValidCreatedBranchName(cwd, branchName) {
  try {
    await git(cwd, "check-ref-format", "--branch", branchName);
  } catch {
    throw gitError("invalid_branch_name", `Branch '${branchName}' is not a valid Git branch name.`);
  }
}

// Keeps branch creation local-only even when a same-named ref exists on origin.
function sameFilePath(leftPath, rightPath) {
  const normalizedLeft = normalizeExistingPath(leftPath);
  const normalizedRight = normalizeExistingPath(rightPath);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeExistingPath(candidatePath) {
  if (typeof candidatePath !== "string") {
    return null;
  }

  const trimmedPath = candidatePath.trim();
  if (!trimmedPath) {
    return null;
  }

  try {
    return fs.realpathSync.native(trimmedPath);
  } catch {
    return path.resolve(trimmedPath);
  }
}

function managedWorktreesRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return normalizeExistingPath(path.join(codexHome, "worktrees"));
}

function isManagedWorktreePath(candidatePath) {
  const normalizedCandidate = normalizeExistingPath(candidatePath);
  const normalizedRoot = managedWorktreesRoot();
  if (!normalizedCandidate || !normalizedRoot) {
    return false;
  }

  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  return !!relativePath && relativePath !== "." && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function resolveProjectRelativePath(cwd, repoRoot) {
  const normalizedCwd = normalizeExistingPath(cwd);
  const normalizedRepoRoot = normalizeExistingPath(repoRoot);
  if (!normalizedCwd || !normalizedRepoRoot) {
    return "";
  }

  const relativePath = path.relative(normalizedRepoRoot, normalizedCwd);
  if (!relativePath || relativePath === ".") {
    return "";
  }

  return relativePath;
}

// Preserves package-scoped threads by reopening the matching subpath inside sibling worktrees.
function scopedWorktreePath(worktreeRootPath, projectRelativePath) {
  const normalizedWorktreeRootPath = normalizeExistingPath(worktreeRootPath);
  if (!normalizedWorktreeRootPath) {
    return worktreeRootPath;
  }
  if (!projectRelativePath) {
    return normalizedWorktreeRootPath;
  }

  const candidatePath = path.join(normalizedWorktreeRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : normalizedWorktreeRootPath;
}

// Resolves a Local checkout path only when the matching subpath actually exists there.
function scopedLocalCheckoutPath(checkoutRootPath, projectRelativePath) {
  const normalizedCheckoutRootPath = normalizeExistingPath(checkoutRootPath);
  if (!normalizedCheckoutRootPath) {
    return null;
  }
  if (!projectRelativePath) {
    return normalizedCheckoutRootPath;
  }

  const candidatePath = path.join(normalizedCheckoutRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : null;
}

// Computes the local repo delta that still exists on this machine and is not on the remote.
async function repoDiffTotals(cwd, context) {
  const baseRef = await resolveRepoDiffBase(cwd, context.tracking);
  const trackedTotals = await diffTotalsAgainstBase(cwd, baseRef);
  const untrackedPaths = context.fileLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.substring(3).trim())
    .filter(Boolean);
  const untrackedTotals = await diffTotalsForUntrackedFiles(cwd, untrackedPaths);

  return {
    additions: trackedTotals.additions + untrackedTotals.additions,
    deletions: trackedTotals.deletions + untrackedTotals.deletions,
    binaryFiles: trackedTotals.binaryFiles + untrackedTotals.binaryFiles,
  };
}

// Uses upstream when available; otherwise falls back to commits not yet present on any remote.
async function resolveRepoDiffBase(cwd, tracking) {
  if (!(await refExists(cwd, "HEAD"))) {
    return EMPTY_TREE_HASH;
  }

  if (tracking) {
    try {
      return (await git(cwd, "merge-base", "HEAD", "@{u}")).trim();
    } catch {
      // Fall through to the local-only commit scan if upstream metadata is stale.
    }
  }

  const firstLocalOnlyCommit = (
    await git(cwd, "rev-list", "--reverse", "--topo-order", "HEAD", "--not", "--remotes")
  )
    .trim()
    .split("\n")
    .find(Boolean);

  if (!firstLocalOnlyCommit) {
    return "HEAD";
  }

  try {
    return (await git(cwd, "rev-parse", `${firstLocalOnlyCommit}^`)).trim();
  } catch {
    return EMPTY_TREE_HASH;
  }
}

async function diffTotalsAgainstBase(cwd, baseRef) {
  const output = await git(cwd, "diff", "--numstat", baseRef);
  return parseNumstatTotals(output);
}

async function gitDiffAgainstBase(cwd, baseRef) {
  return git(cwd, "diff", "--binary", "--find-renames", baseRef);
}

async function diffTotalsForUntrackedFiles(cwd, filePaths) {
  if (!filePaths.length) {
    return { additions: 0, deletions: 0, binaryFiles: 0 };
  }

  const totals = await Promise.all(
    filePaths.map(async (filePath) => {
      const output = await gitDiffNoIndexNumstat(cwd, filePath);
      return parseNumstatTotals(output);
    })
  );

  return totals.reduce(
    (aggregate, current) => ({
      additions: aggregate.additions + current.additions,
      deletions: aggregate.deletions + current.deletions,
      binaryFiles: aggregate.binaryFiles + current.binaryFiles,
    }),
    { additions: 0, deletions: 0, binaryFiles: 0 }
  );
}

// Counts commits reachable from HEAD that are not present on any remote ref.
async function countLocalOnlyCommits(cwd, context) {
  if (context.detached) {
    return 0;
  }

  const remoteRefs = await git(cwd, "for-each-ref", "--format=%(refname)", "refs/remotes");
  const hasAnyRemoteRefs = remoteRefs
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .length > 0;

  if (!hasAnyRemoteRefs) {
    return 0;
  }

  const output = await git(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes");
  return Number.parseInt(output.trim(), 10) || 0;
}

function parseNumstatTotals(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce(
      (aggregate, line) => {
        const [rawAdditions, rawDeletions] = line.split("\t");
        const additions = Number.parseInt(rawAdditions, 10);
        const deletions = Number.parseInt(rawDeletions, 10);
        const isBinary = !Number.isFinite(additions) || !Number.isFinite(deletions);

        return {
          additions: aggregate.additions + (Number.isFinite(additions) ? additions : 0),
          deletions: aggregate.deletions + (Number.isFinite(deletions) ? deletions : 0),
          binaryFiles: aggregate.binaryFiles + (isBinary ? 1 : 0),
        };
      },
      { additions: 0, deletions: 0, binaryFiles: 0 }
    );
}


async function gitDiffNoIndexNumstat(cwd, filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--numstat", "--", "/dev/null", filePath],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES }
    );
    return stdout;
  } catch (err) {
    if (typeof err?.code === "number" && err.code === 1) {
      return err.stdout || "";
    }
    const msg = (err.stderr || err.message || "").trim();
    throw new Error(msg || "git diff --no-index failed");
  }
}

async function diffPatchForUntrackedFiles(cwd, filePaths) {
  if (!filePaths.length) {
    return "";
  }

  const patches = await Promise.all(filePaths.map((filePath) => gitDiffNoIndexPatch(cwd, filePath)));
  return patches.filter(Boolean).join("\n\n");
}

async function gitDiffNoIndexPatch(cwd, filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--binary", "--", "/dev/null", filePath],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES }
    );
    return stdout;
  } catch (err) {
    if (typeof err?.code === "number" && err.code === 1) {
      return err.stdout || "";
    }
    const msg = (err.stderr || err.message || "").trim();
    throw new Error(msg || "git diff --no-index failed");
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES,
  })
    .then(({ stdout }) => stdout)
    .catch((err) => {
      const msg = (err.stderr || err.message || "").trim();
      const wrapped = new Error(msg || "git command failed");
      throw wrapped;
    });
}

// Runs GitHub CLI in the same working tree so PR creation respects local auth and remotes.
function runGitHubCli(cwd, args) {
  return execFileAsync("gh", args, { cwd, timeout: GITHUB_CLI_TIMEOUT_MS })
    .then(({ stdout, stderr }) => ({ stdout, stderr }))
    .catch((err) => {
      const detail = (err.stderr || err.message || "").trim();
      if (err.code === "ENOENT") {
        throw gitError("github_cli_unavailable", "GitHub CLI (`gh`) is required but is not available on PATH.");
      }
      if (/not logged into|not authenticated|gh auth login/i.test(detail)) {
        throw gitError("github_cli_unauthenticated", "GitHub CLI is not authenticated. Run `gh auth login` on this Mac and retry.");
      }
      throw gitError("github_cli_failed", detail || "GitHub CLI command failed.");
    });
}

function gitError(errorCode, userMessage) {
  const err = new Error(userMessage);
  err.errorCode = errorCode;
  err.userMessage = userMessage;
  return err;
}

async function resolveGitCwd(params) {
  const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);

  if (!requestedCwd) {
    throw gitError(
      "missing_working_directory",
      "Git actions require a bound local working directory."
    );
  }

  if (!isExistingDirectory(requestedCwd)) {
    throw gitError(
      "missing_working_directory",
      "The requested local working directory does not exist on this Mac."
    );
  }

  return requestedCwd;
}

function firstNonEmptyString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function isExistingDirectory(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

async function resolveRepoRoot(cwd) {
  const output = await git(cwd, "rev-parse", "--show-toplevel");
  const repoRoot = output.trim();
  return repoRoot || null;
}

async function resolveLocalCheckoutRoot(cwd) {
  const output = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const commonDir = output.trim();
  if (!commonDir) {
    return null;
  }

  const normalizedCommonDir = normalizeExistingPath(commonDir);
  if (!normalizedCommonDir) {
    return null;
  }

  if (path.basename(normalizedCommonDir) !== ".git") {
    return await resolveRepoRoot(cwd);
  }

  const checkoutRoot = normalizeExistingPath(path.dirname(normalizedCommonDir));
  return checkoutRoot || null;
}

module.exports = {
  handleGitRequest,
  gitStatus,
  __test: {
    gitGenerateCommitMessage,
    gitGeneratePullRequestDraft,
    gitCreatePullRequest,
    gitRunStackedAction,
    threadGenerateTitle,
    threadNameSet,
    gitBranches,
    gitBranchesWithStatus,
    gitInit,
    gitCreateBranch,
    gitCreateWorktree,
    gitCreateManagedWorktree,
    gitTransferManagedHandoff,
    gitCheckout,
    gitStash,
    gitRemoveWorktree,
    isManagedWorktreePath,
    normalizeBranchListEntry,
    normalizeCreatedBranchName,
    parseWorktreePathByBranch,
    ensureTrailingNewline,
    resolveWorktreeChangeTransfer,
    resolveLocalCheckoutRoot,
    scopedLocalCheckoutPath,
    scopedWorktreePath,
    resolveBaseBranchName,
    setRunStructuredCodexJsonImplementation(fn) {
      runStructuredCodexJsonImpl = typeof fn === "function" ? fn : runStructuredCodexJson;
    },
    resetRunStructuredCodexJsonImplementation() {
      runStructuredCodexJsonImpl = runStructuredCodexJson;
    },
    setRunGitHubCliImplementation(fn) {
      runGitHubCliImpl = typeof fn === "function" ? fn : runGitHubCli;
    },
    resetRunGitHubCliImplementation() {
      runGitHubCliImpl = runGitHubCli;
    },
  },
};
