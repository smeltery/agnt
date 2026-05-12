// FILE: contracts/diff-helpers.test.js
// Purpose: Pins the parser + the totals/base-ref selectors in the diff
//          helpers module. The git CLI -touching paths are exercised
//          against a fake `git` so we lock the command sequences without
//          standing up a real repo.
// Layer: Contract test

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EMPTY_TREE_HASH,
  createDiffHelpers,
  parseNumstatTotals,
} = require("../../src/diff-helpers");

// ── parseNumstatTotals ─────────────────────────────────────────────────

test("parseNumstatTotals returns zeros for empty / whitespace input", () => {
  assert.deepEqual(parseNumstatTotals(""), { additions: 0, deletions: 0, binaryFiles: 0 });
  assert.deepEqual(parseNumstatTotals("   \n\n"), { additions: 0, deletions: 0, binaryFiles: 0 });
});

test("parseNumstatTotals sums tab-separated additions and deletions", () => {
  const output = "5\t1\tfile.js\n2\t3\tother.js";
  assert.deepEqual(
    parseNumstatTotals(output),
    { additions: 7, deletions: 4, binaryFiles: 0 },
  );
});

test('parseNumstatTotals counts "-\\t-" rows as binary files (no additions/deletions)', () => {
  const output = "5\t1\ttext.js\n-\t-\tbinary.png";
  assert.deepEqual(
    parseNumstatTotals(output),
    { additions: 5, deletions: 1, binaryFiles: 1 },
  );
});

test("parseNumstatTotals skips blank lines", () => {
  const output = "\n5\t1\tfile.js\n\n";
  assert.deepEqual(
    parseNumstatTotals(output),
    { additions: 5, deletions: 1, binaryFiles: 0 },
  );
});

test("EMPTY_TREE_HASH is git's well-known empty-tree SHA-1", () => {
  assert.equal(EMPTY_TREE_HASH, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
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
    if (typeof handlers.default === "function") return handlers.default({ cwd, args, calls });
    return "";
  }
  return { git, calls };
}

function makeHelpers({ gitHandlers = {}, refExistsResult = true } = {}) {
  const fakeGit = makeFakeGit(gitHandlers);
  const helpers = createDiffHelpers({
    git: fakeGit.git,
    refExists: async (_cwd, _ref) => refExistsResult,
  });
  return { helpers, gitCalls: fakeGit.calls };
}

// ── resolveRepoDiffBase ──────────────────────────────────────────────────

test("resolveRepoDiffBase returns EMPTY_TREE_HASH when HEAD does not exist (fresh repo)", async () => {
  const env = makeHelpers({ refExistsResult: false });
  const base = await env.helpers.resolveRepoDiffBase("/repo", "origin/main");
  assert.equal(base, EMPTY_TREE_HASH);
});

test("resolveRepoDiffBase returns the merge-base with @{u} when tracking is set", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "merge-base HEAD": () => "abc123\n",
    },
  });
  const base = await env.helpers.resolveRepoDiffBase("/repo", "origin/main");
  assert.equal(base, "abc123");
});

test("resolveRepoDiffBase falls back to local-only commit scan when merge-base fails", async () => {
  // First the merge-base call throws; then rev-list returns a local-only
  // commit; then rev-parse <commit>^ resolves the parent.
  let mergeBaseCalls = 0;
  const env = makeHelpers({
    gitHandlers: {
      "merge-base HEAD": () => {
        mergeBaseCalls += 1;
        return Promise.reject(new Error("no upstream"));
      },
      "rev-list --reverse": () => "local-only-sha\n",
      "rev-parse local-only-sha^": () => "parent-sha\n",
    },
  });
  const base = await env.helpers.resolveRepoDiffBase("/repo", "origin/main");
  assert.equal(base, "parent-sha");
  assert.equal(mergeBaseCalls, 1);
});

test("resolveRepoDiffBase returns 'HEAD' when there are no local-only commits", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "merge-base HEAD": () => Promise.reject(new Error("no upstream")),
      "rev-list --reverse": () => "",
    },
  });
  const base = await env.helpers.resolveRepoDiffBase("/repo", "origin/main");
  assert.equal(base, "HEAD");
});

test("resolveRepoDiffBase returns EMPTY_TREE_HASH when rev-parse <commit>^ fails (orphan first commit)", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "merge-base HEAD": () => Promise.reject(new Error("no upstream")),
      "rev-list --reverse": () => "orphan-sha\n",
      "rev-parse orphan-sha^": () => Promise.reject(new Error("unknown revision")),
    },
  });
  const base = await env.helpers.resolveRepoDiffBase("/repo", "origin/main");
  assert.equal(base, EMPTY_TREE_HASH);
});

// ── diffTotalsAgainstBase / gitDiffAgainstBase ──────────────────────────

test("diffTotalsAgainstBase shells out to `git diff --numstat <baseRef>`", async () => {
  const env = makeHelpers({
    gitHandlers: { "diff --numstat": () => "3\t1\tfile.js" },
  });
  const totals = await env.helpers.diffTotalsAgainstBase("/repo", "main");
  assert.deepEqual(totals, { additions: 3, deletions: 1, binaryFiles: 0 });
  assert.deepEqual(env.gitCalls[0].args.slice(0, 3), ["diff", "--numstat", "main"]);
});

test("gitDiffAgainstBase shells out to `git diff --binary --find-renames <baseRef>`", async () => {
  const env = makeHelpers({
    gitHandlers: { "diff --binary": () => "@@ patch @@" },
  });
  const patch = await env.helpers.gitDiffAgainstBase("/repo", "main");
  assert.equal(patch, "@@ patch @@");
  assert.deepEqual(env.gitCalls[0].args, ["diff", "--binary", "--find-renames", "main"]);
});

// ── countLocalOnlyCommits ────────────────────────────────────────────────

test("countLocalOnlyCommits returns 0 immediately when detached", async () => {
  const env = makeHelpers();
  const count = await env.helpers.countLocalOnlyCommits("/repo", { detached: true });
  assert.equal(count, 0);
  assert.equal(env.gitCalls.length, 0, "must not run any git command in detached mode");
});

test("countLocalOnlyCommits returns 0 when no remote refs exist (local-only repo)", async () => {
  const env = makeHelpers({
    gitHandlers: { "for-each-ref --format=%(refname)": () => "" },
  });
  const count = await env.helpers.countLocalOnlyCommits("/repo", { detached: false });
  assert.equal(count, 0);
  // for-each-ref runs, but rev-list --count must NOT, since there's no
  // remote to compare against.
  assert.equal(env.gitCalls.length, 1);
});

test("countLocalOnlyCommits parses the rev-list --count output", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "for-each-ref --format=%(refname)": () => "refs/remotes/origin/main\nrefs/remotes/origin/dev",
      "rev-list --count": () => "7\n",
    },
  });
  const count = await env.helpers.countLocalOnlyCommits("/repo", { detached: false });
  assert.equal(count, 7);
});

test("countLocalOnlyCommits returns 0 when rev-list output is unparseable", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "for-each-ref --format=%(refname)": () => "refs/remotes/origin/main",
      "rev-list --count": () => "not-a-number",
    },
  });
  const count = await env.helpers.countLocalOnlyCommits("/repo", { detached: false });
  assert.equal(count, 0);
});

// ── diffTotalsForUntrackedFiles / diffPatchForUntrackedFiles ────────────

test("diffTotalsForUntrackedFiles returns zeros without invoking git when filePaths is empty", async () => {
  const env = makeHelpers();
  const totals = await env.helpers.diffTotalsForUntrackedFiles("/repo", []);
  assert.deepEqual(totals, { additions: 0, deletions: 0, binaryFiles: 0 });
  assert.equal(env.gitCalls.length, 0);
});

test("diffPatchForUntrackedFiles returns empty string when filePaths is empty", async () => {
  const env = makeHelpers();
  const patch = await env.helpers.diffPatchForUntrackedFiles("/repo", []);
  assert.equal(patch, "");
});

// ── repoDiffTotals (combines all of the above) ──────────────────────────

test("repoDiffTotals sums tracked + untracked totals into one shape", async () => {
  const env = makeHelpers({
    gitHandlers: {
      "merge-base HEAD": () => "abc123",
      "diff --numstat": () => "5\t2\tfile.js",
    },
  });
  const totals = await env.helpers.repoDiffTotals("/repo", {
    tracking: "origin/main",
    fileLines: [], // no untracked files, so the untracked path returns zeros
  });
  assert.deepEqual(totals, { additions: 5, deletions: 2, binaryFiles: 0 });
});
