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
const { createWorktreeActions } = require("./worktree-actions");
const { createDraftActions } = require("./draft-actions");
const { createDiffHelpers, parseNumstatTotals } = require("./diff-helpers");
const {
  createBranchHelpers,
  normalizeCreatedBranchName,
  normalizeWorktreeBranchRef,
  resolveBaseBranchName,
} = require("./branch-helpers");

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

const worktreeActions = createWorktreeActions({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  gitStatus: (cwd) => gitStatus(cwd),
  gitBranches: (cwd) => gitBranches(cwd),
  normalizeCreatedBranchName: (raw) => normalizeCreatedBranchName(raw),
  assertValidCreatedBranchName: (cwd, name) => assertValidCreatedBranchName(cwd, name),
  localBranchExists: (cwd, name) => localBranchExists(cwd, name),
  resolveBaseBranchName: (raw, fallback) => resolveBaseBranchName(raw, fallback),
  resolveRepoRoot: (cwd) => resolveRepoRoot(cwd),
  resolveLocalCheckoutRoot: (cwd) => resolveLocalCheckoutRoot(cwd),
  resolveProjectRelativePath: (cwd, repoRoot) => resolveProjectRelativePath(cwd, repoRoot),
  scopedWorktreePath: (worktreeRootPath, projectRelativePath) => scopedWorktreePath(worktreeRootPath, projectRelativePath),
  sameFilePath: (left, right) => sameFilePath(left, right),
  normalizeExistingPath: (candidate) => normalizeExistingPath(candidate),
  isExistingDirectory: (candidate) => isExistingDirectory(candidate),
  firstNonEmptyString: (candidates) => firstNonEmptyString(candidates),
  isManagedWorktreePath: (candidate) => isManagedWorktreePath(candidate),
  worktreeHandoff,
  resolveWorktreeChangeTransfer: (raw) => resolveWorktreeChangeTransfer(raw),
});
const {
  gitCreateWorktree,
  gitCreateManagedWorktree,
  gitTransferManagedHandoff,
  gitRemoveWorktree,
} = worktreeActions;

const draftActions = createDraftActions({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  // Wrap the swap-able impl so tests can keep injecting via the __test
  // setRunStructuredCodexJsonImplementation hook.
  runStructuredCodexJson: (opts) => runStructuredCodexJsonImpl(opts),
  gitStatus: (cwd) => gitStatus(cwd),
  gitBranches: (cwd) => gitBranches(cwd),
  resolveRepoRoot: (cwd) => resolveRepoRoot(cwd),
  refExists: (cwd, ref) => refExists(cwd, ref),
  diffPatchForUntrackedFiles: (cwd, filePaths) => diffPatchForUntrackedFiles(cwd, filePaths),
  parseNumstatTotals: (output) => parseNumstatTotals(output),
  resolveBaseBranchName: (raw, fallback) => resolveBaseBranchName(raw, fallback),
  normalizeNonEmptyMultilineString: (raw) => normalizeNonEmptyMultilineString(raw),
  normalizeExistingPath: (raw) => normalizeExistingPath(raw),
  isExistingDirectory: (raw) => isExistingDirectory(raw),
});
const {
  gitGenerateCommitMessage,
  gitGeneratePullRequestDraft,
  threadGenerateTitle,
} = draftActions;

const branchHelpers = createBranchHelpers({
  git: (cwd, ...args) => git(cwd, ...args),
  gitError: (errorCode, userMessage) => gitError(errorCode, userMessage),
  scopedWorktreePath: (worktreeRootPath, projectRelativePath) => scopedWorktreePath(worktreeRootPath, projectRelativePath),
});
const {
  refExists,
  localBranchExists,
  assertValidCreatedBranchName,
  gitWorktreePathByBranch,
  parseWorktreePathByBranch,
} = branchHelpers;

const diffHelpers = createDiffHelpers({
  git: (cwd, ...args) => git(cwd, ...args),
  refExists: (cwd, ref) => refExists(cwd, ref),
});
const {
  countLocalOnlyCommits,
  diffPatchForUntrackedFiles,
  diffTotalsAgainstBase,
  diffTotalsForUntrackedFiles,
  gitDiffAgainstBase,
  repoDiffTotals,
  resolveRepoDiffBase,
} = diffHelpers;

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
// Node defaults maxBuffer to 1 MiB; large repo diffs trip "stdout maxBuffer length exceeded".
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const GITHUB_CLI_TIMEOUT_MS = 120_000;

let runStructuredCodexJsonImpl = runStructuredCodexJson;
let runGitHubCliImpl = runGitHubCli;

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
