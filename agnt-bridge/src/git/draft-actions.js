// FILE: draft-actions.js
// Purpose: The bridge's three AI-driven draft RPCs — commit message,
//          pull-request draft, and chat thread title — orchestrated via
//          `codex exec --output-schema`. Each one builds a prompt from
//          live git context, sends it to Codex, and normalizes the
//          JSON it returns before handing the result to iOS.
// Layer: bridge utility — factory takes the git primitives + Codex
//        invoker as deps so this module has no implicit coupling back
//        into git-handler.js's internals.
// Exports: createDraftActions (factory).
//
// Why a module: these three RPC entry points used to sit at module scope
// in git-handler.js, interleaved with git ops + worktree orchestration.
// Together they're ~210 lines of "build a prompt → call codex exec →
// normalize the response → wrap errors" pattern. Lifting them gives the
// dispatcher a smaller surface and groups every Codex-touching action in
// one place, alongside #46's codex-exec-runner and #47's draft helpers.

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

const DEFAULT_GIT_WRITER_MODEL = "gpt-5.4-mini";
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * @param {object} deps
 * @param {(cwd: string, ...args: string[]) => Promise<string>} deps.git
 * @param {(errorCode: string, userMessage: string) => Error} deps.gitError
 * @param {(opts: object) => Promise<any>} deps.runStructuredCodexJson
 *   — wraps git-handler's swappable runStructuredCodexJsonImpl so tests
 *     can keep stubbing via the existing __test hook.
 *
 * @param {(cwd: string) => Promise<object>} deps.gitStatus
 * @param {(cwd: string) => Promise<object>} deps.gitBranches
 *
 * @param {(cwd: string) => Promise<string|null>} deps.resolveRepoRoot
 * @param {(cwd: string, refName: string) => Promise<boolean>} deps.refExists
 * @param {(cwd: string, filePaths: string[]) => Promise<string>} deps.diffPatchForUntrackedFiles
 * @param {(output: string) => { additions: number, deletions: number, binaryFiles: number }} deps.parseNumstatTotals
 * @param {(rawBaseBranch: string|undefined, fallback: string|undefined) => string|null} deps.resolveBaseBranchName
 *
 * @param {(rawValue: unknown) => string} deps.normalizeNonEmptyMultilineString
 * @param {(candidatePath: string) => string|null} deps.normalizeExistingPath
 * @param {(candidatePath: string) => boolean} deps.isExistingDirectory
 *
 * @returns {{
 *   gitGenerateCommitMessage: Function,
 *   gitGeneratePullRequestDraft: Function,
 *   threadGenerateTitle: Function,
 * }}
 */
function createDraftActions({
  git,
  gitError,
  runStructuredCodexJson,
  gitStatus,
  gitBranches,
  resolveRepoRoot,
  refExists,
  diffPatchForUntrackedFiles,
  parseNumstatTotals,
  resolveBaseBranchName,
  normalizeNonEmptyMultilineString,
  normalizeExistingPath,
  isExistingDirectory,
}) {
  // ── entry points ───────────────────────────────────────────────────────

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
      const draft = await runStructuredCodexJson({
        cwd,
        model,
        prompt,
        schema,
        codexAppPath: options.codexAppPath,
      });

      return normalizeCommitDraft(draft);
    } catch (error) {
      if (error?.errorCode) throw error;
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
      const draft = await runStructuredCodexJson({
        cwd,
        model,
        prompt,
        schema,
        codexAppPath: options.codexAppPath,
      });

      return normalizePullRequestDraft(draft);
    } catch (error) {
      if (error?.errorCode) throw error;
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
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      };
      const draft = await runStructuredCodexJson({
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
      if (error?.errorCode) throw error;
      throw wrapDraftGenerationError(error, "thread_title");
    }
  }

  // ── context builders ───────────────────────────────────────────────────

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
    const baseBranch = resolveBaseBranchName(
      params.baseBranch,
      branchResult.default || branchResult.defaultBranch,
    );

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

  // PRs compare against the remote base when possible, matching GitHub's
  // base branch. Falls back to the local ref, then the raw branch name.
  async function resolvePullRequestBaseRef(cwd, branchName) {
    const localRef = `refs/heads/${branchName}`;
    const remoteRef = `refs/remotes/origin/${branchName}`;
    if (await refExists(cwd, remoteRef)) return remoteRef;
    if (await refExists(cwd, localRef)) return localRef;
    return branchName;
  }

  // Falls back to process.cwd() when the caller didn't supply a usable
  // working directory. Lives inside the factory closure so it can use
  // the injected fs helpers without holding module-level state.
  function resolveThreadTitleCwd(rawCwd) {
    const normalized = normalizeExistingPath(typeof rawCwd === "string" ? rawCwd : "");
    if (normalized && isExistingDirectory(normalized)) return normalized;
    return process.cwd();
  }

  return {
    gitGenerateCommitMessage,
    gitGeneratePullRequestDraft,
    threadGenerateTitle,
  };
}

// ── pure helpers (no factory needed) ──────────────────────────────────────

function resolveGitWriterModel(rawModel) {
  const trimmed = typeof rawModel === "string" ? rawModel.trim() : "";
  return trimmed || DEFAULT_GIT_WRITER_MODEL;
}

function normalizeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

module.exports = {
  createDraftActions,
  // Pure helpers exposed for direct contract tests.
  DEFAULT_GIT_WRITER_MODEL,
  EMPTY_TREE_HASH,
  normalizeNonNegativeInteger,
  resolveGitWriterModel,
};
