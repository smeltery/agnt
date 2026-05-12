// FILE: contracts/branch-helpers.test.js
// Purpose: Pins the pure branch/ref helpers and the porcelain worktree-list
//          parser. The git-touching helpers (refExists, localBranchExists,
//          assertValidCreatedBranchName, gitWorktreePathByBranch) are
//          exercised against a fake `git` to lock command shapes.
// Layer: Contract test

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBranchHelpers,
  normalizeCreatedBranchName,
  normalizeWorktreeBranchRef,
  resolveBaseBranchName,
} = require("../../src/git/branch-helpers");

// ── pure helpers ─────────────────────────────────────────────────────────

test("normalizeWorktreeBranchRef strips the refs/heads/ prefix and returns null for everything else", () => {
  assert.equal(normalizeWorktreeBranchRef("refs/heads/main"), "main");
  assert.equal(normalizeWorktreeBranchRef("refs/heads/feature/x"), "feature/x");
  assert.equal(normalizeWorktreeBranchRef("refs/heads/  trim-me  "), "trim-me");
  assert.equal(normalizeWorktreeBranchRef("refs/heads/"), null);
  assert.equal(normalizeWorktreeBranchRef("main"), null);
  assert.equal(normalizeWorktreeBranchRef(""), null);
  assert.equal(normalizeWorktreeBranchRef(null), null);
});

test("normalizeCreatedBranchName trims, converts whitespace to dashes, and prefixes agnt/", () => {
  assert.equal(normalizeCreatedBranchName("login bug"), "agnt/login-bug");
  assert.equal(normalizeCreatedBranchName("  spaced  "), "agnt/spaced");
  assert.equal(normalizeCreatedBranchName("feature/x"), "agnt/feature/x");
  assert.equal(normalizeCreatedBranchName("feature / multi word"), "agnt/feature/multi-word");
});

test("normalizeCreatedBranchName preserves an existing agnt/ prefix instead of nesting", () => {
  assert.equal(normalizeCreatedBranchName("agnt/feature"), "agnt/feature");
  assert.equal(normalizeCreatedBranchName("  agnt/login bug  "), "agnt/login-bug");
});

test("normalizeCreatedBranchName returns empty for non-string / blank input", () => {
  assert.equal(normalizeCreatedBranchName(""), "");
  assert.equal(normalizeCreatedBranchName("   "), "");
  assert.equal(normalizeCreatedBranchName(null), "");
  assert.equal(normalizeCreatedBranchName(undefined), "");
});

test("resolveBaseBranchName prefers an explicit user-supplied base, otherwise falls back", () => {
  assert.equal(resolveBaseBranchName("feature/base", "main"), "feature/base");
  assert.equal(resolveBaseBranchName("  feature/base  ", "main"), "feature/base");
  assert.equal(resolveBaseBranchName("", "main"), "main");
  assert.equal(resolveBaseBranchName(null, "main"), "main");
  assert.equal(resolveBaseBranchName("", ""), "");
  assert.equal(resolveBaseBranchName(null, null), "");
});

// ── factory harness ──────────────────────────────────────────────────────

function makeFakeGit(handlers = {}) {
  const calls = [];
  async function git(cwd, ...args) {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(" ");
    if (typeof handlers[key] === "function") {
      const result = handlers[key]({ cwd, args, calls });
      return typeof result === "string" ? result : (await result) ?? "";
    }
    if (typeof handlers.default === "function") return handlers.default({ cwd, args, calls });
    return "";
  }
  return { git, calls };
}

function makeHelpers({ gitHandlers = {}, scopedWorktreePath } = {}) {
  const fakeGit = makeFakeGit(gitHandlers);
  const gitErrorCalls = [];
  const gitError = (code, msg) => {
    gitErrorCalls.push({ code, msg });
    const err = new Error(msg);
    err.errorCode = code;
    err.userMessage = msg;
    return err;
  };
  const helpers = createBranchHelpers({
    git: fakeGit.git,
    gitError,
    scopedWorktreePath: scopedWorktreePath || ((root, _proj) => root),
  });
  return { helpers, gitCalls: fakeGit.calls };
}

// ── refExists / localBranchExists ───────────────────────────────────────

test("refExists shells out to `show-ref --verify --quiet <ref>` and maps success to true", async () => {
  const env = makeHelpers({
    gitHandlers: { "show-ref --verify": () => "" },
  });
  assert.equal(await env.helpers.refExists("/repo", "refs/heads/main"), true);
  assert.deepEqual(env.gitCalls[0].args, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
});

test("refExists maps git failures to false (no error escape)", async () => {
  const env = makeHelpers({
    gitHandlers: { "show-ref --verify": () => Promise.reject(new Error("not found")) },
  });
  assert.equal(await env.helpers.refExists("/repo", "refs/heads/main"), false);
});

test("localBranchExists shells out to `show-ref --verify refs/heads/<name>`", async () => {
  const env = makeHelpers({
    gitHandlers: { "show-ref --verify": () => "" },
  });
  assert.equal(await env.helpers.localBranchExists("/repo", "feature/x"), true);
  assert.deepEqual(
    env.gitCalls[0].args,
    ["show-ref", "--verify", "--quiet", "refs/heads/feature/x"],
  );
});

// ── assertValidCreatedBranchName ────────────────────────────────────────

test("assertValidCreatedBranchName resolves silently when check-ref-format succeeds", async () => {
  const env = makeHelpers({
    gitHandlers: { "check-ref-format --branch": () => "" },
  });
  await env.helpers.assertValidCreatedBranchName("/repo", "feature/x");
  assert.deepEqual(env.gitCalls[0].args, ["check-ref-format", "--branch", "feature/x"]);
});

test("assertValidCreatedBranchName throws invalid_branch_name when check-ref-format fails", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "check-ref-format --branch": () => Promise.reject(new Error("invalid")),
    },
  });
  await assert.rejects(
    () => env.helpers.assertValidCreatedBranchName("/repo", "bad..name"),
    (err) => err.errorCode === "invalid_branch_name"
      && err.userMessage === "Branch 'bad..name' is not a valid Git branch name.",
  );
});

// ── gitWorktreePathByBranch / parseWorktreePathByBranch ─────────────────

test("gitWorktreePathByBranch shells out to `worktree list --porcelain` and parses the result", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "worktree list": () => [
        "worktree /repo/main",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/wt/feature",
        "HEAD def",
        "branch refs/heads/feature/x",
      ].join("\n"),
    },
  });
  const out = await env.helpers.gitWorktreePathByBranch("/repo");
  assert.deepEqual(out, {
    main: "/repo/main",
    "feature/x": "/repo/wt/feature",
  });
});

test("parseWorktreePathByBranch skips detached worktrees (no branch line)", () => {
  const env = makeHelpers();
  const result = env.helpers.parseWorktreePathByBranch([
    "worktree /repo/main",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/detached",
    "HEAD def",
    "detached",
  ].join("\n"));
  assert.deepEqual(result, { main: "/repo/main" });
});

test("parseWorktreePathByBranch skips records where the worktree path is missing", () => {
  const env = makeHelpers();
  const result = env.helpers.parseWorktreePathByBranch([
    "branch refs/heads/orphan",
    "",
    "worktree /repo/main",
    "branch refs/heads/main",
  ].join("\n"));
  assert.deepEqual(result, { main: "/repo/main" });
});

test("parseWorktreePathByBranch applies the scopedWorktreePath transform to each entry", () => {
  // Verify the scopedWorktreePath dep is called with the worktree root +
  // the projectRelativePath option, so multi-project workspaces map their
  // worktree links into the right subdirectory.
  const scopedCalls = [];
  const env = makeHelpers({
    scopedWorktreePath: (root, proj) => {
      scopedCalls.push({ root, proj });
      return `${root}::${proj}`;
    },
  });
  const result = env.helpers.parseWorktreePathByBranch(
    [
      "worktree /repo/wt/feature",
      "branch refs/heads/feature/x",
    ].join("\n"),
    { projectRelativePath: "sub/project" },
  );
  assert.deepEqual(result, { "feature/x": "/repo/wt/feature::sub/project" });
  assert.deepEqual(scopedCalls, [{ root: "/repo/wt/feature", proj: "sub/project" }]);
});

test("parseWorktreePathByBranch tolerates malformed / empty input", () => {
  const env = makeHelpers();
  assert.deepEqual(env.helpers.parseWorktreePathByBranch(""), {});
  assert.deepEqual(env.helpers.parseWorktreePathByBranch(null), {});
  assert.deepEqual(env.helpers.parseWorktreePathByBranch(undefined), {});
});
