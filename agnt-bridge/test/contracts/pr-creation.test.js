// FILE: contracts/pr-creation.test.js
// Purpose: Pins the bridge's GitHub PR-creation flow — the pure helpers
//          that shape outgoing requests and incoming responses, plus the
//          gh CLI command sequences that drive `pr list` / `pr create`.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPullRequestActions,
  firstCommitMessageLine,
  isPullRequestAlreadyExistsMessage,
  normalizeStackedGitAction,
  parsePullRequestUrlFromText,
  pullRequestResult,
} = require("../../src/git/pr-creation");

// ── pure helpers ─────────────────────────────────────────────────────────

test("normalizeStackedGitAction accepts the five documented actions and rejects everything else", () => {
  const gitError = (code, msg) => Object.assign(new Error(msg), { errorCode: code });
  for (const action of ["commit", "push", "create_pr", "commit_push", "commit_push_pr"]) {
    assert.equal(normalizeStackedGitAction(action, gitError), action);
  }
  assert.equal(normalizeStackedGitAction("  push  ", gitError), "push");
  assert.throws(() => normalizeStackedGitAction("unknown", gitError),
    (err) => err.errorCode === "invalid_git_action");
  assert.throws(() => normalizeStackedGitAction("", gitError),
    (err) => err.errorCode === "invalid_git_action");
  assert.throws(() => normalizeStackedGitAction(null, gitError),
    (err) => err.errorCode === "invalid_git_action");
});

test("firstCommitMessageLine takes the first line of a multi-line commit message", () => {
  assert.equal(firstCommitMessageLine("subject line\n\nbody paragraph"), "subject line");
  assert.equal(firstCommitMessageLine("  trimmed  "), "trimmed");
  assert.equal(firstCommitMessageLine(""), "Changes from agnt");
  assert.equal(firstCommitMessageLine("\n\n"), "Changes from agnt");
  assert.equal(firstCommitMessageLine(null), "Changes from agnt");
});

test("pullRequestResult prefers fields from the gh response and falls back to the request inputs", () => {
  const ghResponse = {
    number: 42,
    url: "https://github.com/x/y/pull/42",
    title: "Real Title",
    baseRefName: "main",
    headRefName: "feat",
  };
  assert.deepEqual(
    pullRequestResult("created", ghResponse, "main-fallback", "feat-fallback", "title-fallback", "url-fallback"),
    {
      status: "created",
      number: 42,
      url: "https://github.com/x/y/pull/42",
      baseBranch: "main",
      headBranch: "feat",
      title: "Real Title",
    },
  );
});

test("pullRequestResult falls back to fallback inputs when the PR object is null", () => {
  assert.deepEqual(
    pullRequestResult("created", null, "main", "feat", "title-fallback", "url-fallback"),
    {
      status: "created",
      number: null,
      url: "url-fallback",
      baseBranch: "main",
      headBranch: "feat",
      title: "title-fallback",
    },
  );
});

test("isPullRequestAlreadyExistsMessage matches both ordering of the gh error wording", () => {
  assert.equal(isPullRequestAlreadyExistsMessage("a pull request for branch X already exists"), true);
  assert.equal(isPullRequestAlreadyExistsMessage("Already exists - pull request"), true);
  assert.equal(isPullRequestAlreadyExistsMessage("unrelated failure"), false);
  assert.equal(isPullRequestAlreadyExistsMessage(""), false);
  assert.equal(isPullRequestAlreadyExistsMessage(null), false);
});

test("parsePullRequestUrlFromText extracts the first github.com pull URL from arbitrary text", () => {
  assert.equal(
    parsePullRequestUrlFromText("Created PR at https://github.com/smeltery/agnt/pull/123\nsome trailing"),
    "https://github.com/smeltery/agnt/pull/123",
  );
  assert.equal(parsePullRequestUrlFromText("no url here"), null);
  assert.equal(parsePullRequestUrlFromText(""), null);
  assert.equal(parsePullRequestUrlFromText(null), null);
});

// ── factory harness ──────────────────────────────────────────────────────

function makeFakeGit(handlers = {}) {
  const calls = [];
  async function git(cwd, ...args) {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(" ");
    if (typeof handlers[key] === "function") {
      return handlers[key]({ cwd, args, calls }) ?? "";
    }
    if (typeof handlers.default === "function") {
      return handlers.default({ cwd, args, calls });
    }
    return "";
  }
  return { git, calls };
}

function makeFakeGhCli(handlers = {}) {
  const calls = [];
  async function gitHubCli(cwd, args) {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(" ");
    if (typeof handlers[key] === "function") {
      return handlers[key]({ cwd, args, calls }) ?? { stdout: "", stderr: "" };
    }
    if (typeof handlers.default === "function") {
      return handlers.default({ cwd, args, calls });
    }
    return { stdout: "", stderr: "" };
  }
  return { gitHubCli, calls };
}

function makeActions({
  gitHandlers = {},
  ghHandlers = {},
  gitStatusResult = { dirty: false, branch: "feature/x", tracking: "origin/feature/x", ahead: 0, canPush: false },
  gitBranchesResult = { current: "feature/x", default: "main" },
  draftResult = { title: "Drafted Title", body: "## Summary\n- a\n\n## Testing\n- b\n\n## Notes\n- c" },
} = {}) {
  const fakeGit = makeFakeGit(gitHandlers);
  const fakeGh = makeFakeGhCli(ghHandlers);
  const gitErrorCalls = [];
  const gitError = (code, msg) => {
    gitErrorCalls.push({ code, msg });
    return Object.assign(new Error(msg), { errorCode: code, userMessage: msg });
  };
  const actions = createPullRequestActions({
    git: fakeGit.git,
    gitError,
    gitHubCli: fakeGh.gitHubCli,
    gitStatus: async () => gitStatusResult,
    gitCommit: async () => ({ hash: "abc1234" }),
    gitPush: async () => ({ state: "pushed" }),
    gitBranches: async () => gitBranchesResult,
    gitGeneratePullRequestDraft: async () => draftResult,
    resolveBaseBranchName: (raw, fallback) => raw || fallback || null,
    normalizeNonEmptyLine: (raw) => (typeof raw === "string" ? raw.trim() : ""),
    assertValidCreatedBranchName: async () => {},
  });
  return { actions, gitCalls: fakeGit.calls, ghCalls: fakeGh.calls, gitErrorCalls };
}

// ── gitCreatePullRequest ─────────────────────────────────────────────────

test("gitCreatePullRequest blocks on dirty worktree before contacting gh", async () => {
  const env = makeActions({ gitStatusResult: { dirty: true, branch: "feature/x" } });
  await assert.rejects(
    () => env.actions.gitCreatePullRequest("/repo", {}),
    (err) => err.errorCode === "dirty_worktree",
  );
  assert.equal(env.ghCalls.length, 0, "gh must not be touched when the worktree is dirty");
});

test("gitCreatePullRequest blocks on missing branch", async () => {
  const env = makeActions({
    gitStatusResult: { dirty: false, branch: "HEAD", tracking: null, ahead: 0 },
    gitHandlers: {
      "rev-parse --abbrev-ref": () => "HEAD",
    },
  });
  await assert.rejects(
    () => env.actions.gitCreatePullRequest("/repo", {}),
    (err) => err.errorCode === "no_branch",
  );
});

test("gitCreatePullRequest rejects when base branch equals current branch", async () => {
  const env = makeActions({
    gitStatusResult: { dirty: false, branch: "main", tracking: "origin/main", ahead: 0 },
    gitBranchesResult: { current: "main", default: "main" },
  });
  await assert.rejects(
    () => env.actions.gitCreatePullRequest("/repo", {}),
    (err) => err.errorCode === "pull_request_same_branch",
  );
});

test("gitCreatePullRequest pre-checks gh auth before calling pr create", async () => {
  let authStatusChecked = false;
  let prCreated = false;
  const env = makeActions({
    ghHandlers: {
      "auth status": () => {
        authStatusChecked = true;
        return { stdout: "Logged in", stderr: "" };
      },
      "pr list": () => ({ stdout: "[]", stderr: "" }),
      "pr create": () => {
        prCreated = true;
        return { stdout: "https://github.com/o/r/pull/7", stderr: "" };
      },
    },
  });
  await env.actions.gitCreatePullRequest("/repo", {});
  assert.ok(authStatusChecked, "auth status must be checked before pr create");
  assert.ok(prCreated);
});

test("gitCreatePullRequest returns opened_existing when a PR is already open against the same head", async () => {
  const env = makeActions({
    ghHandlers: {
      "auth status": () => ({ stdout: "Logged in", stderr: "" }),
      "pr list": () => ({
        stdout: JSON.stringify([{
          number: 99,
          url: "https://github.com/o/r/pull/99",
          title: "Existing PR",
          baseRefName: "main",
          headRefName: "feature/x",
        }]),
        stderr: "",
      }),
    },
  });
  const result = await env.actions.gitCreatePullRequest("/repo", {});
  assert.equal(result.status, "opened_existing");
  assert.equal(result.number, 99);
  assert.equal(result.url, "https://github.com/o/r/pull/99");
});

test("gitCreatePullRequest treats 'already exists' errors as opened_existing", async () => {
  let listCalls = 0;
  const env = makeActions({
    ghHandlers: {
      "auth status": () => ({ stdout: "Logged in", stderr: "" }),
      "pr list": () => {
        listCalls += 1;
        // First call: no existing PR. Second call (post-error retry): also empty,
        // so we rely on the message-matching fallback to produce opened_existing.
        return { stdout: "[]", stderr: "" };
      },
      "pr create": () => {
        const err = new Error("a pull request for branch already exists");
        return Promise.reject(err);
      },
    },
  });
  const result = await env.actions.gitCreatePullRequest("/repo", {});
  assert.equal(result.status, "opened_existing");
  assert.ok(listCalls >= 2);
});

test("gitCreatePullRequest invokes `gh pr create` with the expected flag shape", async () => {
  let createArgs = null;
  const env = makeActions({
    ghHandlers: {
      "auth status": () => ({ stdout: "Logged in", stderr: "" }),
      "pr list": () => ({ stdout: "[]", stderr: "" }),
      "pr create": ({ args }) => {
        createArgs = args;
        return { stdout: "https://github.com/o/r/pull/1", stderr: "" };
      },
    },
  });
  await env.actions.gitCreatePullRequest("/repo", {});
  assert.equal(createArgs[0], "pr");
  assert.equal(createArgs[1], "create");
  assert.equal(createArgs[createArgs.indexOf("--base") + 1], "main");
  assert.equal(createArgs[createArgs.indexOf("--head") + 1], "feature/x");
  assert.equal(createArgs[createArgs.indexOf("--title") + 1], "Drafted Title");
  // Body is passed via --body-file pointing at a temp .md
  const bodyFile = createArgs[createArgs.indexOf("--body-file") + 1];
  assert.match(bodyFile, /agnt-pr-body-.*\.md$/);
});

test("gitCreatePullRequest still creates the PR when the draft generator fails (fallback body)", async () => {
  const env = makeActions({
    ghHandlers: {
      "auth status": () => ({ stdout: "ok", stderr: "" }),
      "pr list": () => ({ stdout: "[]", stderr: "" }),
      "pr create": () => ({ stdout: "url", stderr: "" }),
    },
    // simulate a draft-gen failure with the documented errorCode that
    // should be swallowed into the handwritten fallback
    draftResult: undefined,
  });
  // Override the dep that produces the draft to throw the expected error.
  const customActions = createPullRequestActions({
    git: env.actions._git || (async () => ""),
    gitError: (code, msg) => Object.assign(new Error(msg), { errorCode: code, userMessage: msg }),
    gitHubCli: env.actions._gh || (async () => ({ stdout: "", stderr: "" })),
    gitStatus: async () => ({ dirty: false, branch: "feature/x", tracking: "origin/feature/x", ahead: 0 }),
    gitCommit: async () => ({ hash: "abc" }),
    gitPush: async () => ({ state: "pushed" }),
    gitBranches: async () => ({ current: "feature/x", default: "main" }),
    gitGeneratePullRequestDraft: async () => {
      const err = new Error("Codex unavailable");
      err.errorCode = "pull_request_draft_generation_failed";
      throw err;
    },
    resolveBaseBranchName: (raw, fallback) => raw || fallback || null,
    normalizeNonEmptyLine: (raw) => (typeof raw === "string" ? raw.trim() : ""),
    assertValidCreatedBranchName: async () => {},
  });

  // Wire fake gh into the same shape
  let createCalled = false;
  let bodyFileContent = "";
  const fs = require("node:fs");
  const ghStub = makeFakeGhCli({
    "auth status": () => ({ stdout: "ok", stderr: "" }),
    "pr list": () => ({ stdout: "[]", stderr: "" }),
    "pr create": ({ args }) => {
      createCalled = true;
      const bodyFile = args[args.indexOf("--body-file") + 1];
      bodyFileContent = fs.readFileSync(bodyFile, "utf8");
      return { stdout: "https://github.com/o/r/pull/1", stderr: "" };
    },
  });
  // Re-create with the gh stub bound
  const finalActions = createPullRequestActions({
    git: async () => "",
    gitError: (code, msg) => Object.assign(new Error(msg), { errorCode: code, userMessage: msg }),
    gitHubCli: ghStub.gitHubCli,
    gitStatus: async () => ({ dirty: false, branch: "feature/x", tracking: "origin/feature/x", ahead: 0 }),
    gitCommit: async () => ({ hash: "abc" }),
    gitPush: async () => ({ state: "pushed" }),
    gitBranches: async () => ({ current: "feature/x", default: "main" }),
    gitGeneratePullRequestDraft: async () => {
      const err = new Error("Codex unavailable");
      err.errorCode = "pull_request_draft_generation_failed";
      throw err;
    },
    resolveBaseBranchName: (raw, fallback) => raw || fallback || null,
    normalizeNonEmptyLine: (raw) => (typeof raw === "string" ? raw.trim() : ""),
    assertValidCreatedBranchName: async () => {},
  });

  await finalActions.gitCreatePullRequest("/repo", {});
  assert.ok(createCalled);
  assert.match(bodyFileContent, /## Summary/);
  assert.match(bodyFileContent, /## Testing/);
  assert.match(bodyFileContent, /## Notes/);
  assert.match(bodyFileContent, /Not run from agnt/);
});

// ── gitRunStackedAction ──────────────────────────────────────────────────

test("gitRunStackedAction commit + push + pr emits progress events for each phase", async () => {
  const progressEvents = [];
  const env = makeActions({
    gitStatusResult: { dirty: true, branch: "feature/x", tracking: "origin/feature/x", ahead: 0, canPush: true },
    ghHandlers: {
      "auth status": () => ({ stdout: "ok", stderr: "" }),
      "pr list": () => ({ stdout: "[]", stderr: "" }),
      "pr create": () => ({ stdout: "https://github.com/o/r/pull/1", stderr: "" }),
    },
  });
  // Override gitStatus so the dirty/canPush flips after the commit + push phases.
  let statusCallCount = 0;
  const stubActions = createPullRequestActions({
    git: env.actions._git || (async () => ""),
    gitError: (code, msg) => Object.assign(new Error(msg), { errorCode: code, userMessage: msg }),
    gitHubCli: async (cwd, args) => {
      if (args.slice(0, 2).join(" ") === "pr list") return { stdout: "[]", stderr: "" };
      if (args.slice(0, 2).join(" ") === "auth status") return { stdout: "ok", stderr: "" };
      if (args.slice(0, 2).join(" ") === "pr create") return { stdout: "https://github.com/o/r/pull/1", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    gitStatus: async () => {
      statusCallCount += 1;
      // After the commit (call ≥ 3), the worktree is clean and pushable.
      if (statusCallCount <= 2) return { dirty: true, tracking: "origin/feature/x", ahead: 0, canPush: true, branch: "feature/x" };
      return { dirty: false, tracking: "origin/feature/x", ahead: 1, canPush: true, branch: "feature/x" };
    },
    gitCommit: async () => ({ hash: "abc1234" }),
    gitPush: async () => ({ state: "pushed" }),
    gitBranches: async () => ({ current: "feature/x", default: "main" }),
    gitGeneratePullRequestDraft: async () => ({
      title: "T",
      body: "## Summary\n- a\n\n## Testing\n- b\n\n## Notes\n- c",
    }),
    resolveBaseBranchName: (raw, fallback) => raw || fallback || null,
    normalizeNonEmptyLine: (raw) => (typeof raw === "string" ? raw.trim() : ""),
    assertValidCreatedBranchName: async () => {},
  });

  const sendNotification = (method, params) => {
    progressEvents.push({ method, params });
  };
  await stubActions.gitRunStackedAction("/repo", {
    action: "commit_push_pr",
    commitMessage: "test commit",
    progressId: "p-1",
  }, { sendNotification });

  const phases = progressEvents
    .filter((e) => e.method === "git/stackedAction/progress")
    .map((e) => `${e.params.phase}:${e.params.status}`);
  // Each of commit / push / createPR must announce both started and completed.
  assert.deepEqual(phases, [
    "commit:started", "commit:completed",
    "push:started", "push:completed",
    "createPR:started", "createPR:completed",
  ]);
});

test("gitRunStackedAction throws nothing_to_commit when action=commit and the worktree is clean", async () => {
  const env = makeActions({
    gitStatusResult: { dirty: false, branch: "feature/x", tracking: "origin/feature/x", ahead: 0, canPush: false },
  });
  await assert.rejects(
    () => env.actions.gitRunStackedAction("/repo", { action: "commit" }),
    (err) => err.errorCode === "nothing_to_commit",
  );
});

test("gitRunStackedAction validates the action string up front", async () => {
  const env = makeActions();
  await assert.rejects(
    () => env.actions.gitRunStackedAction("/repo", { action: "bogus" }),
    (err) => err.errorCode === "invalid_git_action",
  );
});

// ── gitCreateFeatureBranch ───────────────────────────────────────────────

test("gitCreateFeatureBranch uses requested name when provided", async () => {
  const env = makeActions({
    gitHandlers: {
      "show-ref --verify": () => Promise.reject(new Error("ref not found")),
      "checkout -b": () => "",
    },
  });
  const branchName = await env.actions.gitCreateFeatureBranch("/repo", {
    featureBranchName: "feat/login",
  });
  assert.equal(branchName, "feat/login");
  const checkoutCall = env.gitCalls.find((c) => c.args[0] === "checkout");
  assert.deepEqual(checkoutCall.args.slice(0, 3), ["checkout", "-b", "feat/login"]);
});

test("gitCreateFeatureBranch synthesizes a name with the documented prefix when none requested", async () => {
  const env = makeActions({
    gitHandlers: {
      "show-ref --verify": () => Promise.reject(new Error("ref not found")),
      "checkout -b": () => "",
    },
  });
  const branchName = await env.actions.gitCreateFeatureBranch("/repo", {});
  assert.match(branchName, /^agnt\/mobile-pr-\d{14}$/);
});

test("gitCreateFeatureBranch honours featureBranchPrefix override", async () => {
  const env = makeActions({
    gitHandlers: {
      "show-ref --verify": () => Promise.reject(new Error("ref not found")),
      "checkout -b": () => "",
    },
  });
  const branchName = await env.actions.gitCreateFeatureBranch("/repo", {
    featureBranchPrefix: "test/bridge",
  });
  assert.match(branchName, /^test\/bridge-\d{14}$/);
});

test("gitCreateFeatureBranch rejects when the branch already exists", async () => {
  const env = makeActions({
    gitHandlers: {
      "show-ref --verify": () => "", // success = branch exists
    },
  });
  await assert.rejects(
    () => env.actions.gitCreateFeatureBranch("/repo", { featureBranchName: "feat/existing" }),
    (err) => err.errorCode === "branch_exists",
  );
});
