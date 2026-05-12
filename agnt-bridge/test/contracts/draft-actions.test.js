// FILE: contracts/draft-actions.test.js
// Purpose: Pins the AI-draft entry points + their pure helpers. The
//          factory-bound entry points are tested against a fake `runStructuredCodexJson`
//          so we lock the prompt + schema shape and the JSON-RPC error
//          mapping without actually shelling out to `codex exec`.
// Layer: Contract test

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_GIT_WRITER_MODEL,
  EMPTY_TREE_HASH,
  createDraftActions,
  normalizeNonNegativeInteger,
  resolveGitWriterModel,
} = require("../../src/draft-actions");

// ── pure helpers ─────────────────────────────────────────────────────────

test("DEFAULT_GIT_WRITER_MODEL is the documented model id", () => {
  assert.equal(DEFAULT_GIT_WRITER_MODEL, "gpt-5.4-mini");
});

test("EMPTY_TREE_HASH is git's well-known empty-tree SHA-1", () => {
  assert.equal(EMPTY_TREE_HASH, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("resolveGitWriterModel returns the trimmed override when one is set", () => {
  assert.equal(resolveGitWriterModel("custom-model"), "custom-model");
  assert.equal(resolveGitWriterModel("  spaced  "), "spaced");
});

test("resolveGitWriterModel falls back to DEFAULT_GIT_WRITER_MODEL on empty / non-string input", () => {
  assert.equal(resolveGitWriterModel(""), DEFAULT_GIT_WRITER_MODEL);
  assert.equal(resolveGitWriterModel("   "), DEFAULT_GIT_WRITER_MODEL);
  assert.equal(resolveGitWriterModel(null), DEFAULT_GIT_WRITER_MODEL);
  assert.equal(resolveGitWriterModel(undefined), DEFAULT_GIT_WRITER_MODEL);
  assert.equal(resolveGitWriterModel(42), DEFAULT_GIT_WRITER_MODEL);
});

test("normalizeNonNegativeInteger accepts positive safe integers and rejects everything else", () => {
  assert.equal(normalizeNonNegativeInteger(0), 0); // not > 0
  assert.equal(normalizeNonNegativeInteger(5), 5);
  assert.equal(normalizeNonNegativeInteger(-1), 0);
  assert.equal(normalizeNonNegativeInteger(1.5), 0);
  assert.equal(normalizeNonNegativeInteger(NaN), 0);
  assert.equal(normalizeNonNegativeInteger("3"), 0);
  assert.equal(normalizeNonNegativeInteger(null), 0);
  assert.equal(normalizeNonNegativeInteger(undefined), 0);
});

// ── factory harness ──────────────────────────────────────────────────────

function makeActions({
  runStructuredCodexJson = async () => ({}),
  gitStatusResult = { dirty: true, files: [], branch: "main", diff: { additions: 0, deletions: 0, binaryFiles: 0 } },
  gitBranchesResult = { current: "feature/x", default: "main", defaultBranch: "main" },
  git = async () => "",
  refExistsResult = true,
  diffPatchForUntrackedFilesResult = "",
  parseNumstatTotalsResult = { additions: 0, deletions: 0, binaryFiles: 0 },
  resolveBaseBranchNameResult,
  resolveRepoRootResult = "/repo",
  normalizeExistingPathResult = "/cwd",
  isExistingDirectoryResult = true,
} = {}) {
  const gitErrorCalls = [];
  const gitError = (code, msg) => {
    gitErrorCalls.push({ code, msg });
    const err = new Error(msg);
    err.errorCode = code;
    err.userMessage = msg;
    return err;
  };
  const codexCalls = [];
  const codexInvoker = async (opts) => {
    codexCalls.push(opts);
    return runStructuredCodexJson(opts);
  };
  const actions = createDraftActions({
    git,
    gitError,
    runStructuredCodexJson: codexInvoker,
    gitStatus: async () => gitStatusResult,
    gitBranches: async () => gitBranchesResult,
    resolveRepoRoot: async () => resolveRepoRootResult,
    refExists: async () => refExistsResult,
    diffPatchForUntrackedFiles: async () => diffPatchForUntrackedFilesResult,
    parseNumstatTotals: () => parseNumstatTotalsResult,
    resolveBaseBranchName: (raw, fallback) =>
      resolveBaseBranchNameResult !== undefined ? resolveBaseBranchNameResult : (raw || fallback || null),
    normalizeNonEmptyMultilineString: (v) => (typeof v === "string" ? v.trim() : ""),
    normalizeExistingPath: () => normalizeExistingPathResult,
    isExistingDirectory: () => isExistingDirectoryResult,
  });
  return { actions, codexCalls, gitErrorCalls };
}

// ── gitGenerateCommitMessage ─────────────────────────────────────────────

test("gitGenerateCommitMessage rejects with nothing_to_commit when the worktree is clean", async () => {
  const env = makeActions({
    gitStatusResult: { dirty: false, files: [], branch: "main", diff: {} },
  });
  await assert.rejects(
    () => env.actions.gitGenerateCommitMessage("/repo", {}),
    (err) => err.errorCode === "nothing_to_commit",
  );
});

test("gitGenerateCommitMessage sends a JSON schema with subject/body/fullMessage to codex exec", async () => {
  const env = makeActions({
    gitStatusResult: {
      dirty: true,
      files: [{ status: "M", path: "a.js" }],
      branch: "feature/x",
      diff: { additions: 5, deletions: 1, binaryFiles: 0 },
    },
    git: async () => "@@ patch @@",
    runStructuredCodexJson: async () => ({
      subject: "Add feature",
      body: "- did things\n- and more",
      fullMessage: "Add feature\n\n- did things\n- and more",
    }),
  });
  const result = await env.actions.gitGenerateCommitMessage("/repo", { model: "test-model" });
  const codexCall = env.codexCalls[0];
  assert.equal(codexCall.model, "test-model");
  assert.deepEqual(codexCall.schema.required, ["subject", "body", "fullMessage"]);
  assert.equal(codexCall.schema.additionalProperties, false);
  assert.match(codexCall.prompt, /Write a detailed Git commit message/);
  assert.equal(result.subject, "Add feature");
});

test("gitGenerateCommitMessage wraps non-tagged errors with commit_message_generation_failed", async () => {
  const env = makeActions({
    gitStatusResult: {
      dirty: true,
      files: [{ status: "M", path: "a.js" }],
      branch: "feature/x",
      diff: {},
    },
    git: async () => "@@ patch @@",
    runStructuredCodexJson: async () => {
      throw new Error("codex broke");
    },
  });
  await assert.rejects(
    () => env.actions.gitGenerateCommitMessage("/repo", {}),
    (err) => err.errorCode === "commit_message_generation_failed"
      && /codex broke/.test(err.userMessage),
  );
});

test("gitGenerateCommitMessage rethrows tagged errors unchanged", async () => {
  // Tagged errors (e.g. nothing_to_commit raised by the context builder)
  // must propagate without being re-wrapped.
  const env = makeActions({
    gitStatusResult: { dirty: false, files: [], branch: "main", diff: {} },
  });
  await assert.rejects(
    () => env.actions.gitGenerateCommitMessage("/repo", {}),
    (err) => err.errorCode === "nothing_to_commit",
  );
});

// ── gitGeneratePullRequestDraft ──────────────────────────────────────────

test("gitGeneratePullRequestDraft rejects when no current branch", async () => {
  const env = makeActions({
    gitBranchesResult: { current: "", default: "main" },
  });
  await assert.rejects(
    () => env.actions.gitGeneratePullRequestDraft("/repo", {}),
    (err) => err.errorCode === "no_branch",
  );
});

test("gitGeneratePullRequestDraft rejects when no default branch can be resolved", async () => {
  const env = makeActions({
    gitBranchesResult: { current: "feature/x", default: "" },
    resolveBaseBranchNameResult: null,
  });
  await assert.rejects(
    () => env.actions.gitGeneratePullRequestDraft("/repo", {}),
    (err) => err.errorCode === "no_default_branch",
  );
});

test("gitGeneratePullRequestDraft rejects nothing_to_compare when both patch and commits are empty", async () => {
  // git() returns "" for both diff and log -> no patch, no commits.
  const env = makeActions({
    git: async () => "",
  });
  await assert.rejects(
    () => env.actions.gitGeneratePullRequestDraft("/repo", {}),
    (err) => err.errorCode === "nothing_to_compare",
  );
});

test("gitGeneratePullRequestDraft sends a JSON schema with title/body to codex exec", async () => {
  const env = makeActions({
    git: async (cwd, ...args) => {
      const op = args[0];
      if (op === "merge-base") return "abc123";
      if (op === "diff" && args[1] === "--binary") return "@@ patch @@";
      if (op === "diff" && args[1] === "--numstat") return "5 1 file.js";
      if (op === "log") return "abc1234 Add feature\n";
      return "";
    },
    runStructuredCodexJson: async () => ({
      title: "Add feature",
      body: "## Summary\n- x\n\n## Testing\n- y\n\n## Notes\n- z",
    }),
  });
  const result = await env.actions.gitGeneratePullRequestDraft("/repo", {});
  const codexCall = env.codexCalls[0];
  assert.deepEqual(codexCall.schema.required, ["title", "body"]);
  assert.match(codexCall.prompt, /Write a pull request title and body/);
  assert.equal(result.title, "Add feature");
});

// ── threadGenerateTitle ──────────────────────────────────────────────────

test("threadGenerateTitle rejects missing_thread_title_message when no message is supplied", async () => {
  const env = makeActions();
  await assert.rejects(
    () => env.actions.threadGenerateTitle({}, {}),
    (err) => err.errorCode === "missing_thread_title_message",
  );
});

test("threadGenerateTitle invokes codex exec with skipGitRepoCheck + read-only sandbox", async () => {
  const env = makeActions({
    runStructuredCodexJson: async () => ({ title: "Login Bug" }),
  });
  const result = await env.actions.threadGenerateTitle({
    message: "How do I fix the login redirect?",
    attachmentCount: 1,
  });
  const codexCall = env.codexCalls[0];
  assert.equal(codexCall.skipGitRepoCheck, true);
  assert.equal(codexCall.sandboxMode, "read-only");
  assert.match(codexCall.prompt, /Write a short chat thread title/);
  assert.match(codexCall.prompt, /Attachments: 1 image\n/);
  assert.equal(result.title, "Login Bug");
});

test("threadGenerateTitle wraps non-tagged codex failures with thread_title_generation_failed", async () => {
  const env = makeActions({
    runStructuredCodexJson: async () => {
      throw new Error("codex timeout");
    },
  });
  await assert.rejects(
    () => env.actions.threadGenerateTitle({ message: "x" }),
    (err) => err.errorCode === "thread_title_generation_failed",
  );
});

test("threadGenerateTitle prefers params.prompt when params.message is missing", async () => {
  const env = makeActions({
    runStructuredCodexJson: async () => ({ title: "T" }),
  });
  await env.actions.threadGenerateTitle({ prompt: "fallback prompt" });
  assert.match(env.codexCalls[0].prompt, /fallback prompt/);
});
