// FILE: git-handler-status-push.test.js
// Purpose: Covers status, push, and remote branch regressions for the local git bridge.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, fs, path, git-handler, git-handler-test-helpers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { __test, gitStatus, handleGitRequest } = require("../../src/git/git-handler");
const { git, makeTempRepo, makeBareRemote, pushRemoteOnlyBranch } = require("./git-handler-test-helpers");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
});

test("gitStatus reports local-only commits when remotes exist but upstream is missing", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nlocal\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Local commit");
    git(repoDir, "config", "--unset", "branch.main.remote");
    git(repoDir, "config", "--unset", "branch.main.merge");

    const result = await gitStatus(repoDir);

    assert.equal(result.tracking, null);
    assert.equal(result.state, "no_upstream");
    assert.equal(result.hasPushRemote, true);
    assert.equal(result.canPush, true);
    assert.equal(result.localOnlyCommitCount, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitStatus fetches current upstream before computing update availability", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-clone-"));

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(remoteDir, "symbolic-ref", "HEAD", "refs/heads/main");
    git(path.dirname(cloneDir), "clone", remoteDir, cloneDir);
    git(cloneDir, "config", "user.name", "agnt Tests");
    git(cloneDir, "config", "user.email", "tests@example.com");

    fs.writeFileSync(path.join(cloneDir, "README.md"), "# Test\n\nremote\n");
    git(cloneDir, "add", "README.md");
    git(cloneDir, "commit", "-m", "Remote commit");
    git(cloneDir, "push", "origin", "main");

    const result = await gitStatus(repoDir);

    assert.equal(result.tracking, "origin/main");
    assert.equal(result.behind, 1);
    assert.equal(result.state, "behind_only");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
});

test("gitStatus does not mark commits pushable when origin is missing", async () => {
  const repoDir = makeTempRepo();

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nlocal\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Local commit");

    const result = await gitStatus(repoDir);

    assert.equal(result.hasHeadCommit, true);
    assert.equal(result.hasPushRemote, false);
    assert.equal(result.canPush, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitStatus keeps branches pushable when their upstream remote is not origin", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "upstream", remoteDir);
    git(repoDir, "push", "-u", "upstream", "main");

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\nnon-origin remote\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Local commit");

    const result = await gitStatus(repoDir);

    assert.equal(result.tracking, "upstream/main");
    assert.equal(result.hasPushRemote, true);
    assert.equal(result.canPush, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitPush allows an existing upstream remote that is not origin", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "upstream", remoteDir);
    git(repoDir, "push", "-u", "upstream", "main");

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n\npush upstream\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "Push upstream");

    const response = await new Promise((resolve) => {
      handleGitRequest(
        JSON.stringify({
          id: 1,
          method: "git/push",
          params: { cwd: repoDir },
        }),
        (rawResponse) => resolve(JSON.parse(rawResponse))
      );
    });

    assert.equal(response.error, undefined);
    assert.equal(response.result.remote, "upstream");
    assert.equal(response.result.status.canPush, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitPush rejects before running push when origin is missing", async () => {
  const repoDir = makeTempRepo();

  try {
    const response = await new Promise((resolve) => {
      handleGitRequest(
        JSON.stringify({
          id: 1,
          method: "git/push",
          params: { cwd: repoDir },
        }),
        (rawResponse) => resolve(JSON.parse(rawResponse))
      );
    });

    assert.equal(response.error.data.errorCode, "no_remote");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCreateBranch rejects duplicate branch names with a specific error", async () => {
  const repoDir = makeTempRepo();

  try {
    git(repoDir, "branch", "agnt/already-there");

    await assert.rejects(
      __test.gitCreateBranch(repoDir, { name: "already-there" }),
      (error) =>
        error?.errorCode === "branch_exists"
          && error?.userMessage === "Branch 'agnt/already-there' already exists."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitBranches hides remote-only branches from the local selector list", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    pushRemoteOnlyBranch(repoDir, remoteDir, "agnt/remote-only");

    const result = await __test.gitBranches(repoDir);

    assert.ok(!result.branches.includes("agnt/remote-only"));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitBranches preserves the repo default branch even when it is not checked out locally", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/topic");
    git(repoDir, "branch", "-D", "main");

    const result = await __test.gitBranches(repoDir);

    assert.equal(result.default, "main");
    assert.ok(!result.branches.includes("main"));
    assert.ok(result.branches.includes("agnt/topic"));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitCreateBranch rejects names that already exist only on origin", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    pushRemoteOnlyBranch(repoDir, remoteDir, "agnt/remote-only");

    await assert.rejects(
      __test.gitCreateBranch(repoDir, { name: "remote-only" }),
      (error) =>
        error?.errorCode === "branch_exists"
          && error?.userMessage === "Branch 'agnt/remote-only' already exists on origin. Check it out locally instead of creating a new branch."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitStatus marks a branch as published when origin has it even without local upstream", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    git(remoteDir, "init", "--bare");
    git(repoDir, "remote", "add", "origin", remoteDir);
    git(repoDir, "push", "-u", "origin", "main");
    git(repoDir, "checkout", "-b", "agnt/published-no-upstream");
    git(repoDir, "push", "origin", "HEAD");

    const result = await gitStatus(repoDir);

    assert.equal(result.tracking, null);
    assert.equal(result.publishedToRemote, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});
