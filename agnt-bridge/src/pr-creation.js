// FILE: pr-creation.js
// Purpose: The bridge's GitHub PR creation flow — feature-branch bootstrap,
//          stacked commit/push/pr orchestration, gh CLI invocation, and the
//          existing-PR detection that turns "create PR" into "open existing
//          PR" when one already exists.
// Layer: bridge utility — factory takes the few git + gh primitives it
//        needs so the module has no implicit coupling back to
//        git-handler.js's other internals.
// Exports: createPullRequestActions (factory)
//
// Why a module: this used to be ~280 lines of stacked-action plumbing
// (gitRunStackedAction, gitCreatePullRequest, gitCreateFeatureBranch,
// findOpenPullRequest, generatePullRequestDraftOrFallback, …) plus six
// small pure helpers, all interleaved with unrelated git ops inside
// git-handler.js. Lifting it makes the commit→push→PR state machine
// inspectable in one place and lets the factory be unit-tested with a
// fake git + gh.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 * @param {(cwd: string, args: string[]) => Promise<{ stdout: string, stderr: string }>}
 *   deps.gitHubCli — wraps the bridge's gh exec; tests inject a stub.
 * @param {(cwd: string) => Promise<object>} deps.gitStatus
 * @param {(cwd: string, params: object) => Promise<object>} deps.gitCommit
 * @param {(cwd: string) => Promise<object>} deps.gitPush
 * @param {(cwd: string) => Promise<object>} deps.gitBranches
 * @param {(cwd: string, params: object, options: object) => Promise<{ title: string, body: string }>}
 *   deps.gitGeneratePullRequestDraft — Codex-backed draft generation
 *   (lives in git-handler.js because it spans the draft cluster).
 * @param {(rawBaseBranch: string|undefined, fallback: string|undefined) => string|null}
 *   deps.resolveBaseBranchName
 * @param {(value: unknown) => string} deps.normalizeNonEmptyLine
 * @param {(cwd: string, branchName: string) => Promise<void>}
 *   deps.assertValidCreatedBranchName
 * @returns {{
 *   gitRunStackedAction: Function,
 *   gitCreatePullRequest: Function,
 *   gitCreateFeatureBranch: Function,
 * }}
 */
function createPullRequestActions({
  git,
  gitError,
  gitHubCli,
  gitStatus,
  gitCommit,
  gitPush,
  gitBranches,
  gitGeneratePullRequestDraft,
  resolveBaseBranchName,
  normalizeNonEmptyLine,
  assertValidCreatedBranchName,
}) {
  // ── stacked action: commit / push / create_pr ──────────────────────────

  async function gitRunStackedAction(cwd, params, options = {}) {
    const action = normalizeStackedGitAction(params.action, gitError);
    const initialStatus = await gitStatus(cwd);
    const wantsCommit = action === "commit" || action === "commit_push" || action === "commit_push_pr";
    const wantsPr = action === "create_pr" || action === "commit_push_pr";

    // Emits phase progress events on the same wire used by JSON-RPC
    // responses so the iOS toast can reflect the live step
    // (commit/push/PR) of a stacked action.
    const progressId = typeof params.progressId === "string" && params.progressId.trim()
      ? params.progressId.trim()
      : null;
    const emitPhase = (phase, status) => {
      if (!progressId || typeof options.sendNotification !== "function") return;
      options.sendNotification("git/stackedAction/progress", { progressId, phase, status });
    };

    if (params.featureBranch === true) {
      emitPhase("branch", "started");
      await gitCreateFeatureBranch(cwd, params);
      emitPhase("branch", "completed");
    }

    const branch = await currentBranchName(cwd);
    const result = {
      action,
      branch: {
        status: params.featureBranch === true ? "created" : "skipped_not_requested",
        name: params.featureBranch === true ? branch : undefined,
      },
      commit: { status: "skipped_not_requested" },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
      status: initialStatus,
    };

    if (action === "push" && initialStatus.dirty) {
      throw gitError("dirty_worktree", "Commit or stash local changes before pushing.");
    }
    if (action === "create_pr" && initialStatus.dirty) {
      throw gitError("dirty_worktree", "Commit local changes before creating a PR.");
    }

    if (wantsCommit) {
      const statusBeforeCommit = await gitStatus(cwd);
      if (statusBeforeCommit.dirty) {
        emitPhase("commit", "started");
        const commitResult = await gitCommit(cwd, {
          message: params.commitMessage || params.message,
        });
        result.commit = {
          status: "created",
          ...commitResult,
          commitSha: commitResult.hash,
          subject: firstCommitMessageLine(params.commitMessage || params.message),
        };
        emitPhase("commit", "completed");
      } else if (action === "commit") {
        throw gitError("nothing_to_commit", "Nothing to commit.");
      } else {
        result.commit = { status: "skipped_clean" };
        emitPhase("commit", "skipped");
      }
    }

    const statusBeforePush = await gitStatus(cwd);
    const shouldPush =
      action === "push" ||
      action === "commit_push" ||
      action === "commit_push_pr" ||
      (action === "create_pr" && (!statusBeforePush.tracking || statusBeforePush.ahead > 0));

    if (shouldPush) {
      if (action === "push" && !statusBeforePush.canPush) {
        throw gitError("nothing_to_push", "Nothing to push.");
      }
      if (action === "commit_push" && result.commit.status === "skipped_clean" && !statusBeforePush.canPush) {
        throw gitError("nothing_to_commit", "Nothing to commit or push.");
      }
      if (statusBeforePush.dirty) {
        throw gitError("dirty_worktree", "Commit or stash local changes before pushing.");
      }
      emitPhase("push", "started");
      result.push = {
        state: "pushed",
        ...(await gitPush(cwd)),
      };
      emitPhase("push", "completed");
    }

    if (wantsPr) {
      emitPhase("createPR", "started");
      result.pr = await gitCreatePullRequest(cwd, {
        ...params,
        pushBeforeCreate: false,
      }, options);
      emitPhase("createPR", "completed");
    }

    result.status = await gitStatus(cwd);
    return result;
  }

  // ── PR creation ────────────────────────────────────────────────────────

  async function gitCreatePullRequest(cwd, params, options = {}) {
    const status = await gitStatus(cwd);
    if (status.dirty) {
      throw gitError("dirty_worktree", "Commit local changes before creating a PR.");
    }

    const branch = status.branch || await currentBranchName(cwd);
    if (!branch || branch === "HEAD") {
      throw gitError("no_branch", "No current branch found.");
    }

    if (params.pushBeforeCreate !== false && (!status.tracking || status.ahead > 0)) {
      await gitPush(cwd);
    }

    const branchResult = await gitBranches(cwd);
    const baseBranch = resolveBaseBranchName(params.baseBranch, branchResult.default || branchResult.defaultBranch);
    if (!baseBranch) {
      throw gitError("no_default_branch", "Could not determine the repository default branch.");
    }
    if (baseBranch === branch) {
      throw gitError(
        "pull_request_same_branch",
        `Cannot create a pull request from '${branch}' into itself. Create or switch to a feature branch first.`
      );
    }

    await ensureGitHubCliReady(cwd);
    const existing = await findOpenPullRequest(cwd, branch);
    if (existing) {
      return pullRequestResult("opened_existing", existing, baseBranch, branch);
    }

    const draft = await generatePullRequestDraftOrFallback(cwd, params, options, baseBranch, branch);
    const bodyFile = path.join(
      os.tmpdir(),
      `agnt-pr-body-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.md`
    );
    fs.writeFileSync(bodyFile, draft.body, "utf8");

    let createOutput = null;
    try {
      createOutput = await gitHubCli(cwd, [
        "pr",
        "create",
        "--base", baseBranch,
        "--head", branch,
        "--title", draft.title,
        "--body-file", bodyFile,
      ]);
    } catch (error) {
      const existingFromError = await findOpenPullRequest(cwd, branch).catch(() => null);
      if (existingFromError || isPullRequestAlreadyExistsMessage(error.message)) {
        return pullRequestResult("opened_existing", existingFromError, baseBranch, branch, draft.title);
      }
      throw error;
    } finally {
      fs.rmSync(bodyFile, { force: true });
    }

    const created = await findOpenPullRequest(cwd, branch).catch(() => null);
    const createdUrl = parsePullRequestUrlFromText(`${createOutput?.stdout || ""}\n${createOutput?.stderr || ""}`);
    return pullRequestResult("created", created, baseBranch, branch, draft.title, createdUrl);
  }

  // ── feature branch bootstrap ───────────────────────────────────────────

  async function gitCreateFeatureBranch(cwd, params) {
    const requestedName = normalizeNonEmptyLine(params.featureBranchName || params.branchName);
    const branchName = requestedName || await defaultFeatureBranchName(cwd, params);
    await assertValidCreatedBranchName(cwd, branchName);
    if (await branchExists(cwd, branchName)) {
      throw gitError("branch_exists", `Branch '${branchName}' already exists.`);
    }
    await git(cwd, "checkout", "-b", branchName);
    return branchName;
  }

  async function defaultFeatureBranchName(cwd, params) {
    const prefix = normalizeNonEmptyLine(params.featureBranchPrefix) || "agnt/mobile-pr";
    const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const base = `${prefix}-${timestamp}`;
    let candidate = base;
    for (let index = 2; await branchExists(cwd, candidate); index += 1) {
      candidate = `${base}-${index}`;
    }
    return candidate;
  }

  async function branchExists(cwd, branchName) {
    try {
      await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  async function currentBranchName(cwd) {
    return (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  }

  // ── draft fallback ─────────────────────────────────────────────────────

  // When Codex draft generation fails (no Codex token, draft-gen error,
  // etc.) the bridge still creates the PR with a minimal handwritten
  // template so the user isn't blocked.
  async function generatePullRequestDraftOrFallback(cwd, params, options, baseBranch, branch) {
    try {
      return await gitGeneratePullRequestDraft(cwd, { ...params, baseBranch }, options);
    } catch (error) {
      if (error?.errorCode && error.errorCode !== "pull_request_draft_generation_failed") {
        throw error;
      }
      return {
        title: `Update ${branch}`,
        body: [
          "## Summary",
          `- Prepare changes from \`${branch}\` for review.`,
          "",
          "## Testing",
          "- Not run from agnt.",
          "",
          "## Notes",
          `- Base branch: \`${baseBranch}\`.`,
        ].join("\n"),
      };
    }
  }

  // ── gh CLI ─────────────────────────────────────────────────────────────

  async function ensureGitHubCliReady(cwd) {
    try {
      await gitHubCli(cwd, ["auth", "status"]);
    } catch (error) {
      if (error?.errorCode) throw error;
      throw gitError("github_cli_unavailable", error.message || "GitHub CLI is unavailable.");
    }
  }

  async function findOpenPullRequest(cwd, branch) {
    const output = await gitHubCli(cwd, [
      "pr", "list",
      "--head", branch,
      "--state", "open",
      "--limit", "1",
      "--json", "number,title,url,baseRefName,headRefName,state",
    ]);
    const pullRequests = JSON.parse(output.stdout.trim() || "[]");
    return Array.isArray(pullRequests) ? pullRequests[0] || null : null;
  }

  return {
    gitRunStackedAction,
    gitCreatePullRequest,
    gitCreateFeatureBranch,
  };
}

// ── pure helpers (no factory needed) ──────────────────────────────────────

function normalizeStackedGitAction(rawAction, gitError) {
  const action = typeof rawAction === "string" ? rawAction.trim() : "";
  if (["commit", "push", "create_pr", "commit_push", "commit_push_pr"].includes(action)) {
    return action;
  }
  throw gitError("invalid_git_action", "Unknown git action.");
}

function firstCommitMessageLine(message) {
  if (typeof message !== "string") return "Changes from agnt";
  const firstLine = message.split("\n")[0].trim();
  return firstLine || "Changes from agnt";
}

function pullRequestResult(status, pullRequest, baseBranch, branch, fallbackTitle = "", fallbackUrl = null) {
  return {
    status,
    url: pullRequest?.url || fallbackUrl || null,
    number: pullRequest?.number || null,
    baseBranch: pullRequest?.baseRefName || baseBranch,
    headBranch: pullRequest?.headRefName || branch,
    title: pullRequest?.title || fallbackTitle || "",
  };
}

function isPullRequestAlreadyExistsMessage(message) {
  return typeof message === "string" && /pull request .*already exists|already exists.*pull request/i.test(message);
}

function parsePullRequestUrlFromText(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/https:\/\/github\.com\/[^\s"'<>]+\/pull\/\d+/);
  return match ? match[0] : null;
}

module.exports = {
  createPullRequestActions,
  // Exported for direct contract tests; not used externally.
  firstCommitMessageLine,
  isPullRequestAlreadyExistsMessage,
  normalizeStackedGitAction,
  parsePullRequestUrlFromText,
  pullRequestResult,
};
