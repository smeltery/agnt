// FILE: contracts/git-ops.test.js
// Purpose: Pins the pure parsing/state helpers extracted alongside the
//          basic git ops. The factory-bound ops (`gitStatus`, `gitPush`,
//          etc.) are already covered end-to-end by the existing
//          test/git-handler.test.js integration suite against a real
//          git repo; this file covers the regex + state-machine helpers
//          that are pure and easy to regress in isolation.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeState,
  gitInitBranchFlagUnsupported,
  nonRepositoryStatus,
  normalizeBranchListEntry,
  parseBranchFromStatus,
  parseOwnerRepo,
  parseTrackingFromStatus,
  trackingRemoteName,
} = require("../../src/git/git-ops");

// ── parseBranchFromStatus ───────────────────────────────────────────────

test("parseBranchFromStatus parses the branch from `## <branch>` / `## <branch>...<remote>`", () => {
  assert.equal(parseBranchFromStatus("## main"), "main");
  assert.equal(parseBranchFromStatus("## feature/x"), "feature/x");
  assert.equal(parseBranchFromStatus("## main...origin/main"), "main");
  assert.equal(parseBranchFromStatus("## main...origin/main [ahead 1]"), "main");
});

test("parseBranchFromStatus extracts the branch from `No commits yet on <name>`", () => {
  assert.equal(
    parseBranchFromStatus("## No commits yet on main"),
    "main",
  );
});

test("parseBranchFromStatus returns null for detached HEAD / no-branch lines", () => {
  assert.equal(parseBranchFromStatus("## HEAD (no branch)"), null);
  assert.equal(parseBranchFromStatus("## HEAD detached at abc1234"), null);
});

test("parseBranchFromStatus returns null on non-status lines", () => {
  assert.equal(parseBranchFromStatus(""), null);
  assert.equal(parseBranchFromStatus("M  some/file.js"), null);
});

// ── parseTrackingFromStatus ─────────────────────────────────────────────

test("parseTrackingFromStatus extracts the upstream from `## branch...remote/branch`", () => {
  assert.equal(parseTrackingFromStatus("## main...origin/main"), "origin/main");
  assert.equal(parseTrackingFromStatus("## feat...remote/feat [ahead 1]"), "remote/feat");
});

test("parseTrackingFromStatus returns null when there's no upstream marker", () => {
  assert.equal(parseTrackingFromStatus("## main"), null);
  assert.equal(parseTrackingFromStatus("## HEAD (no branch)"), null);
  assert.equal(parseTrackingFromStatus(""), null);
});

// ── computeState ─────────────────────────────────────────────────────────

test("computeState picks detached_head when detached, regardless of dirty/ahead/behind", () => {
  assert.equal(computeState(false, 0, 0, true, false), "detached_head");
  assert.equal(computeState(true, 5, 5, true, true), "detached_head");
});

test("computeState picks no_upstream over ahead/behind state when noUpstream", () => {
  assert.equal(computeState(false, 0, 0, false, true), "no_upstream");
  assert.equal(computeState(false, 1, 0, false, true), "no_upstream");
});

test("computeState distinguishes dirty + behind vs dirty alone", () => {
  assert.equal(computeState(true, 0, 1, false, false), "dirty_and_behind");
  assert.equal(computeState(true, 0, 0, false, false), "dirty");
  assert.equal(computeState(true, 1, 0, false, false), "dirty");
});

test("computeState picks diverged when both ahead and behind", () => {
  assert.equal(computeState(false, 1, 1, false, false), "diverged");
});

test("computeState picks behind_only / ahead_only / up_to_date for the clean branches", () => {
  assert.equal(computeState(false, 0, 1, false, false), "behind_only");
  assert.equal(computeState(false, 1, 0, false, false), "ahead_only");
  assert.equal(computeState(false, 0, 0, false, false), "up_to_date");
});

// ── nonRepositoryStatus ─────────────────────────────────────────────────

test("nonRepositoryStatus returns a stable shape with isRepo=false and zeroed metrics", () => {
  const result = nonRepositoryStatus("/some/dir");
  assert.equal(result.isRepo, false);
  assert.equal(result.repoRoot, null);
  assert.equal(result.branch, null);
  assert.equal(result.tracking, null);
  assert.equal(result.dirty, false);
  assert.equal(result.state, "not_initialized");
  assert.equal(result.canPush, false);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.diff, { additions: 0, deletions: 0, binaryFiles: 0 });
});

// ── gitInitBranchFlagUnsupported ────────────────────────────────────────

test("gitInitBranchFlagUnsupported detects older git versions that reject `-b`", () => {
  assert.equal(
    gitInitBranchFlagUnsupported({ message: "unknown switch `b'" }),
    true,
  );
  assert.equal(
    gitInitBranchFlagUnsupported({ message: "unknown option `b'" }),
    true,
  );
  assert.equal(
    gitInitBranchFlagUnsupported({ message: "usage: git init [-q] ..." }),
    true,
  );
});

test("gitInitBranchFlagUnsupported returns false for unrelated git errors", () => {
  assert.equal(
    gitInitBranchFlagUnsupported({ message: "fatal: not a git repository" }),
    false,
  );
  assert.equal(gitInitBranchFlagUnsupported(null), false);
  assert.equal(gitInitBranchFlagUnsupported({}), false);
});

// ── trackingRemoteName ──────────────────────────────────────────────────

test("trackingRemoteName extracts the remote name from `<remote>/<branch>`", () => {
  assert.equal(trackingRemoteName("origin/main"), "origin");
  assert.equal(trackingRemoteName("upstream/feature/x"), "upstream");
});

test("trackingRemoteName returns null for malformed or non-remote inputs", () => {
  assert.equal(trackingRemoteName("main"), null);
  assert.equal(trackingRemoteName("/no-leading-slash"), null);
  assert.equal(trackingRemoteName(""), null);
  assert.equal(trackingRemoteName(null), null);
  assert.equal(trackingRemoteName(undefined), null);
});

// ── parseOwnerRepo ──────────────────────────────────────────────────────

test("parseOwnerRepo extracts owner/repo from https + ssh + .git suffix", () => {
  assert.equal(parseOwnerRepo("https://github.com/smeltery/agnt.git"), "smeltery/agnt");
  assert.equal(parseOwnerRepo("https://github.com/smeltery/agnt"), "smeltery/agnt");
  assert.equal(parseOwnerRepo("git@github.com:smeltery/agnt.git"), "smeltery/agnt");
  assert.equal(parseOwnerRepo("ssh://git@github.com/smeltery/agnt"), "smeltery/agnt");
});

test("parseOwnerRepo returns null for non-URL strings", () => {
  assert.equal(parseOwnerRepo(""), null);
  assert.equal(parseOwnerRepo("not-a-url"), null);
});

// ── normalizeBranchListEntry ────────────────────────────────────────────

test("normalizeBranchListEntry parses `git branch` output with current and worktree markers", () => {
  assert.deepEqual(
    normalizeBranchListEntry("* main"),
    { isCurrent: true, isCheckedOutElsewhere: false, name: "main" },
  );
  assert.deepEqual(
    normalizeBranchListEntry("  feature/x"),
    { isCurrent: false, isCheckedOutElsewhere: false, name: "feature/x" },
  );
  assert.deepEqual(
    normalizeBranchListEntry("+ feature/y"),
    { isCurrent: false, isCheckedOutElsewhere: true, name: "feature/y" },
  );
});

test("normalizeBranchListEntry returns null for empty / non-string input", () => {
  assert.equal(normalizeBranchListEntry(""), null);
  assert.equal(normalizeBranchListEntry("   "), null);
  assert.equal(normalizeBranchListEntry(null), null);
  assert.equal(normalizeBranchListEntry(undefined), null);
});
