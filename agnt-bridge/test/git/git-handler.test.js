// FILE: git-handler.test.js
// Purpose: Covers branch parsing, checkout, stash, and create-branch regressions.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, fs, path, git-handler, git-handler-test-helpers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test, gitStatus } = require("../../src/git/git-handler");
const { git, makeTempRepo, canonicalPath } = require("./git-handler-test-helpers");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
});

test("normalizeBranchListEntry strips linked-worktree markers from branch labels", () => {
  assert.deepEqual(__test.normalizeBranchListEntry("+ main"), {
    isCurrent: false,
    isCheckedOutElsewhere: true,
    name: "main",
  });
  assert.deepEqual(__test.normalizeBranchListEntry("* feature/mobile"), {
    isCurrent: true,
    isCheckedOutElsewhere: false,
    name: "feature/mobile",
  });
});

test("gitStatus reports non-repository directories without failing", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-nonrepo-"));

  try {
    fs.writeFileSync(path.join(projectDir, "README.md"), "# New project\n");

    const result = await gitStatus(projectDir);

    assert.equal(result.isRepo, false);
    assert.equal(result.state, "not_initialized");
    assert.equal(result.branch, null);
    assert.deepEqual(result.files, []);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("gitInit creates a main unborn branch without committing files", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-init-"));

  try {
    fs.writeFileSync(path.join(projectDir, "README.md"), "# New project\n");

    const result = await __test.gitInit(projectDir);
    const head = git(projectDir, "symbolic-ref", "--short", "HEAD");
    const commitCount = git(projectDir, "rev-list", "--count", "--all");

    assert.equal(head, "main");
    assert.equal(commitCount, "0");
    assert.equal(result.status.isRepo, true);
    assert.equal(result.status.branch, "main");
    assert.equal(result.status.hasHeadCommit, false);
    assert.equal(result.status.hasPushRemote, false);
    assert.equal(result.status.canPush, false);
    assert.equal(result.status.dirty, true);
    assert.ok(result.status.files.some((file) => file.path === "README.md" && file.status === "??"));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("gitBranchesWithStatus returns explicit non-repository state", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-branches-nonrepo-"));

  try {
    const result = await __test.gitBranchesWithStatus(projectDir);

    assert.deepEqual(result.branches, []);
    assert.equal(result.status.isRepo, false);
    assert.equal(result.status.state, "not_initialized");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("gitBranches marks branches that are checked out in another worktree", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(repoDir);

    assert.deepEqual(result.branchesCheckedOutElsewhere, ["feature/clean-switch"]);
    assert.ok(result.branches.includes("feature/clean-switch"));
    assert.equal(result.worktreePathByBranch["feature/clean-switch"], canonicalPath(siblingWorktree));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitBranches scopes worktree paths to the current project subdirectory", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(projectDir);

    assert.equal(
      result.worktreePathByBranch["feature/clean-switch"],
      canonicalPath(path.join(siblingWorktree, "agnt-bridge"))
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitBranches exposes the true local checkout path even when called from a worktree", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(siblingWorktree);

    assert.equal(result.localCheckoutPath, canonicalPath(repoDir));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitBranches scopes local checkout path for subdirectory worktrees", async () => {
  const repoDir = makeTempRepo();
  const localProjectDir = path.join(repoDir, "agnt-bridge");
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);
  const siblingProjectDir = path.join(siblingWorktree, "agnt-bridge");

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    const result = await __test.gitBranches(siblingProjectDir);

    assert.equal(result.localCheckoutPath, canonicalPath(localProjectDir));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitBranches leaves local checkout path empty when the matching local subdirectory is missing", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);
  const siblingProjectDir = path.join(siblingWorktree, "packages", "newpkg");

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");
    fs.mkdirSync(siblingProjectDir, { recursive: true });

    const result = await __test.gitBranches(siblingProjectDir);

    assert.equal(result.localCheckoutPath, null);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitCheckout switches to the requested branch instead of treating it like a path", async () => {
  const repoDir = makeTempRepo();

  try {
    const result = await __test.gitCheckout(repoDir, { branch: "feature/clean-switch" });

    assert.equal(result.current, "feature/clean-switch");
    assert.equal(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/clean-switch");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCheckout surfaces a specific error when the branch is open in another worktree", async () => {
  const repoDir = makeTempRepo();
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-feature`);

  try {
    git(repoDir, "worktree", "add", siblingWorktree, "feature/clean-switch");

    await assert.rejects(
      __test.gitCheckout(repoDir, { branch: "feature/clean-switch" }),
      (error) =>
        error?.errorCode === "checkout_branch_in_other_worktree"
          && error?.userMessage === "Cannot switch branches: this branch is already open in another worktree."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
  }
});

test("gitCheckout surfaces a specific error when untracked files would be overwritten", async () => {
  const repoDir = makeTempRepo();

  try {
    fs.writeFileSync(path.join(repoDir, "main-only.txt"), "tracked on main\n");
    git(repoDir, "add", "main-only.txt");
    git(repoDir, "commit", "-m", "Track main-only on main");
    git(repoDir, "switch", "feature/clean-switch");
    fs.writeFileSync(path.join(repoDir, "main-only.txt"), "scratch\n");

    await assert.rejects(
      __test.gitCheckout(repoDir, { branch: "main" }),
      (error) =>
        error?.errorCode === "checkout_conflict_untracked_collision"
          && error?.userMessage === "Cannot switch branches: untracked files would be overwritten."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCheckout surfaces a specific error when the requested branch does not exist locally", async () => {
  const repoDir = makeTempRepo();

  try {
    await assert.rejects(
      __test.gitCheckout(repoDir, { branch: "agnt/missing" }),
      (error) =>
        error?.errorCode === "branch_not_found"
          && error?.userMessage === "Branch 'agnt/missing' does not exist locally."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitStash includes untracked files so a blocked branch switch can succeed after stashing", async () => {
  const repoDir = makeTempRepo();

  try {
    git(repoDir, "switch", "feature/clean-switch");
    fs.writeFileSync(path.join(repoDir, "main-only.txt"), "scratch\n");

    const stashResult = await __test.gitStash(repoDir);
    const checkoutResult = await __test.gitCheckout(repoDir, { branch: "main" });

    assert.equal(stashResult.success, true);
    assert.equal(checkoutResult.current, "main");
    assert.equal(git(repoDir, "status", "--short"), "");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCreateBranch normalizes bare names into agnt/** and checks out the new branch", async () => {
  const repoDir = makeTempRepo();

  try {
    const result = await __test.gitCreateBranch(repoDir, { name: "new-branch" });

    assert.equal(result.branch, "agnt/new-branch");
    assert.equal(result.status?.branch, "agnt/new-branch");
    assert.equal(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "agnt/new-branch");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("normalizeCreatedBranchName avoids double-prefixing agnt branches", () => {
  assert.equal(__test.normalizeCreatedBranchName("feature/foo"), "agnt/feature/foo");
  assert.equal(__test.normalizeCreatedBranchName("agnt/feature/foo"), "agnt/feature/foo");
  assert.equal(__test.normalizeCreatedBranchName("my new branch"), "agnt/my-new-branch");
  assert.equal(__test.normalizeCreatedBranchName("feature / login page"), "agnt/feature/login-page");
  assert.equal(__test.normalizeCreatedBranchName("   "), "");
});

test("gitCreateBranch rejects invalid Git branch names before checkout", async () => {
  const repoDir = makeTempRepo();

  try {
    await assert.rejects(
      __test.gitCreateBranch(repoDir, { name: "feature..oops" }),
      (error) =>
        error?.errorCode === "invalid_branch_name"
          && error?.userMessage === "Branch 'agnt/feature..oops' is not a valid Git branch name."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
