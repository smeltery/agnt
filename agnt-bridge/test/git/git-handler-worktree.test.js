// FILE: git-handler-worktree.test.js
// Purpose: Covers managed worktree regressions for the local git bridge.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, child_process, fs, os, git-handler

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { __test } = require("../../src/git/git-handler");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
});

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function makeTempRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "agnt Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n");
  fs.mkdirSync(path.join(repoDir, "agnt-bridge", "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "agnt-bridge", "src", "index.js"), "export const ready = true;\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "add", "agnt-bridge/src/index.js");
  git(repoDir, "commit", "-m", "Initial commit");
  git(repoDir, "branch", "feature/clean-switch");
  return repoDir;
}

function canonicalPath(candidatePath) {
  return fs.realpathSync.native(candidatePath);
}

function makeBareRemote() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agnt-git-handler-remote-"));
}

function pushRemoteOnlyBranch(repoDir, remoteDir, branchName) {
  git(remoteDir, "init", "--bare");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "push", "-u", "origin", "main");
  git(repoDir, "branch", branchName);
  git(repoDir, "push", "-u", "origin", branchName);
  git(repoDir, "branch", "-D", branchName);
}

test("gitCreateWorktree creates a managed worktree under CODEX_HOME/worktrees", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const result = await __test.gitCreateWorktree(projectDir, {
      name: "new-worktree",
      baseBranch: "main",
    });
    const managedWorktreesRoot = canonicalPath(path.join(codexHome, "worktrees"));

    assert.equal(result.branch, "agnt/new-worktree");
    assert.equal(result.alreadyExisted, false);
    assert.ok(result.worktreePath.startsWith(managedWorktreesRoot));
    assert.equal(path.basename(result.worktreePath), "agnt-bridge");
    assert.equal(git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "agnt/new-worktree");

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateManagedWorktree creates a detached managed worktree under CODEX_HOME/worktrees", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const result = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
    });
    const managedWorktreesRoot = canonicalPath(path.join(codexHome, "worktrees"));

    assert.equal(result.alreadyExisted, false);
    assert.equal(result.baseBranch, "main");
    assert.equal(result.headMode, "detached");
    assert.ok(result.worktreePath.startsWith(managedWorktreesRoot));
    assert.equal(path.basename(result.worktreePath), "agnt-bridge");
    assert.equal(git(result.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree reuses an existing worktree for the same agnt branch", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  const siblingWorktree = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt-agnt-existing`);

  process.env.CODEX_HOME = codexHome;

  try {
    git(repoDir, "branch", "agnt/existing");
    git(repoDir, "worktree", "add", siblingWorktree, "agnt/existing");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "existing",
      baseBranch: "main",
    });

    assert.equal(result.branch, "agnt/existing");
    assert.equal(result.alreadyExisted, true);
    assert.equal(result.worktreePath, canonicalPath(path.join(siblingWorktree, "agnt-bridge")));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(siblingWorktree, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree rejects a reused local branch name before ignoring the chosen base branch", async () => {
  const repoDir = makeTempRepo();

  try {
    git(repoDir, "branch", "agnt/already-there");

    await assert.rejects(
      __test.gitCreateWorktree(repoDir, {
        name: "already-there",
        baseBranch: "main",
      }),
      (error) =>
        error?.errorCode === "branch_exists"
          && error?.userMessage === "Branch 'agnt/already-there' already exists locally. Choose another name or open that branch instead."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCreateWorktree rejects invalid Git branch names before creating a worktree", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");

  try {
    await assert.rejects(
      __test.gitCreateWorktree(projectDir, {
        name: "feature..oops",
        baseBranch: "main",
        changeTransfer: "copy",
      }),
      (error) =>
        error?.errorCode === "invalid_branch_name"
          && error?.userMessage === "Branch 'agnt/feature..oops' is not a valid Git branch name."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitCreateWorktree rejects remote-only base branches because worktrees start from local refs", async () => {
  const repoDir = makeTempRepo();
  const remoteDir = makeBareRemote();

  try {
    pushRemoteOnlyBranch(repoDir, remoteDir, "feature/remote-base");

    await assert.rejects(
      __test.gitCreateWorktree(repoDir, {
        name: "new-worktree",
        baseBranch: "feature/remote-base",
      }),
      (error) =>
        error?.errorCode === "missing_base_branch"
          && error?.userMessage === "Base branch 'feature/remote-base' is not available locally. Create or check out that branch first."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("gitCreateWorktree carries tracked and untracked changes into the new worktree and cleans local", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const ready = false;\n");
    fs.writeFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "carry me\n");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "dirty-worktree",
      baseBranch: "main",
    });

    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "src", "index.js"), "utf8"),
      "export const ready = false;\n"
    );
    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "scratch.txt"), "utf8"),
      "carry me\n"
    );
    assert.equal(git(repoDir, "status", "--short"), "");
    assert.equal(fs.existsSync(path.join(repoDir, "agnt-bridge", "scratch.txt")), false);

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree can copy tracked and untracked changes into the new worktree without cleaning local", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const ready = 'copied';\n");
    fs.writeFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "keep me too\n");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "copied-worktree",
      baseBranch: "main",
      changeTransfer: "copy",
    });

    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "src", "index.js"), "utf8"),
      "export const ready = 'copied';\n"
    );
    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "scratch.txt"), "utf8"),
      "keep me too\n"
    );
    assert.match(git(repoDir, "status", "--short"), /agnt-bridge\/src\/index\.js/);
    assert.equal(
      fs.readFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "utf8"),
      "keep me too\n"
    );

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree ignores dirty changes outside the current project scope", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\nroot only\n");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "scoped-worktree",
      baseBranch: "feature/clean-switch",
    });

    assert.equal(
      fs.readFileSync(path.join(path.dirname(result.worktreePath), "README.md"), "utf8"),
      "# Test\n"
    );
    assert.equal(
      fs.readFileSync(path.join(repoDir, "README.md"), "utf8"),
      "# Test\nroot only\n"
    );
    assert.match(git(repoDir, "status", "--short"), /README\.md/);

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree leaves ignored files in the local checkout during handoff", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.log\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "Add ignore rule");
    fs.writeFileSync(path.join(repoDir, "ignored.log"), "stay local\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\nmoved\n");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "ignored-files",
      baseBranch: "main",
    });

    assert.equal(fs.existsSync(path.join(repoDir, "ignored.log")), true);
    assert.equal(fs.existsSync(path.join(path.dirname(result.worktreePath), "ignored.log")), false);

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree leaves ignored files only in Local when copying changes for a fork", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.log\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "Add ignore rule");
    fs.writeFileSync(path.join(repoDir, "ignored.log"), "stay local\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\ncopied\n");

    const result = await __test.gitCreateWorktree(projectDir, {
      name: "ignored-copy",
      baseBranch: "main",
      changeTransfer: "copy",
    });

    assert.equal(fs.existsSync(path.join(repoDir, "ignored.log")), true);
    assert.equal(fs.existsSync(path.join(path.dirname(result.worktreePath), "ignored.log")), false);
    assert.match(git(repoDir, "status", "--short"), /README\.md/);

    git(repoDir, "worktree", "remove", "--force", path.dirname(result.worktreePath));
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateManagedWorktree moves tracked changes into the detached worktree and cleans Local", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const ready = false;\n");
    fs.writeFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "carry me\n");

    const result = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
      changeTransfer: "move",
    });

    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "src", "index.js"), "utf8"),
      "export const ready = false;\n"
    );
    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "scratch.txt"), "utf8"),
      "carry me\n"
    );
    assert.equal(git(repoDir, "status", "--short"), "");
    assert.equal(fs.existsSync(path.join(repoDir, "agnt-bridge", "scratch.txt")), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateManagedWorktree copies tracked changes into the detached worktree and keeps Local dirty", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const ready = 'copied';\n");
    fs.writeFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "keep me too\n");

    const result = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
      changeTransfer: "copy",
    });

    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "src", "index.js"), "utf8"),
      "export const ready = 'copied';\n"
    );
    assert.equal(
      fs.readFileSync(path.join(result.worktreePath, "scratch.txt"), "utf8"),
      "keep me too\n"
    );
    assert.match(git(repoDir, "status", "--short"), /agnt-bridge\/src\/index\.js/);
    assert.equal(
      fs.readFileSync(path.join(repoDir, "agnt-bridge", "scratch.txt"), "utf8"),
      "keep me too\n"
    );
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateManagedWorktree leaves ignored files only in Local", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.log\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "Add ignore rule");
    fs.writeFileSync(path.join(repoDir, "ignored.log"), "stay local\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\ncopied\n");

    const result = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
      changeTransfer: "copy",
    });

    assert.equal(fs.existsSync(path.join(repoDir, "ignored.log")), true);
    assert.equal(fs.existsSync(path.join(path.dirname(result.worktreePath), "ignored.log")), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitTransferManagedHandoff moves tracked changes from Local into an existing managed worktree", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const managed = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
    });

    fs.writeFileSync(path.join(projectDir, "src", "index.js"), "export const ready = 'handoff';\n");
    fs.writeFileSync(path.join(projectDir, "scratch.txt"), "from local\n");

    const result = await __test.gitTransferManagedHandoff(projectDir, {
      targetPath: managed.worktreePath,
    });

    assert.equal(result.success, true);
    assert.equal(git(repoDir, "status", "--short"), "");
    assert.equal(
      fs.readFileSync(path.join(managed.worktreePath, "src", "index.js"), "utf8"),
      "export const ready = 'handoff';\n"
    );
    assert.equal(
      fs.readFileSync(path.join(managed.worktreePath, "scratch.txt"), "utf8"),
      "from local\n"
    );
    assert.equal(fs.existsSync(path.join(projectDir, "scratch.txt")), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitTransferManagedHandoff moves only the current project scope into the managed worktree", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const managed = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
    });

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\nroot stays local\n");
    fs.writeFileSync(path.join(projectDir, "scratch.txt"), "from local\n");

    const result = await __test.gitTransferManagedHandoff(projectDir, {
      targetPath: managed.worktreePath,
    });

    assert.equal(result.success, true);
    assert.match(git(repoDir, "status", "--short"), /README\.md/);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(managed.worktreePath), "README.md"), "utf8"),
      "# Test\n"
    );
    assert.equal(
      fs.readFileSync(path.join(managed.worktreePath, "scratch.txt"), "utf8"),
      "from local\n"
    );
    assert.equal(fs.existsSync(path.join(projectDir, "scratch.txt")), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitTransferManagedHandoff moves tracked changes from a managed worktree back to Local", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const managed = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
    });

    fs.writeFileSync(path.join(managed.worktreePath, "src", "index.js"), "export const ready = 'back';\n");
    fs.writeFileSync(path.join(managed.worktreePath, "scratch.txt"), "from worktree\n");

    const result = await __test.gitTransferManagedHandoff(managed.worktreePath, {
      targetPath: projectDir,
    });

    assert.equal(result.success, true);
    assert.equal(git(path.join(managed.worktreePath, ".."), "status", "--short"), "");
    assert.equal(
      fs.readFileSync(path.join(projectDir, "src", "index.js"), "utf8"),
      "export const ready = 'back';\n"
    );
    assert.equal(
      fs.readFileSync(path.join(projectDir, "scratch.txt"), "utf8"),
      "from worktree\n"
    );
    assert.equal(fs.existsSync(path.join(managed.worktreePath, "scratch.txt")), false);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitRemoveWorktree removes a managed worktree and its freshly created branch", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    const result = await __test.gitCreateWorktree(projectDir, {
      name: "cleanup-me",
      baseBranch: "main",
      changeTransfer: "copy",
    });

    await __test.gitRemoveWorktree(result.worktreePath, { branch: result.branch });

    assert.equal(fs.existsSync(path.dirname(result.worktreePath)), false);
    assert.equal(git(repoDir, "branch", "--list", result.branch), "");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("gitCreateWorktree rejects dirty handoff when the chosen base branch is not the current branch", async () => {
  const repoDir = makeTempRepo();

  try {
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\nmismatch\n");

    await assert.rejects(
      __test.gitCreateWorktree(repoDir, {
        name: "mismatch",
        baseBranch: "feature/clean-switch",
      }),
      (error) =>
        error?.errorCode === "dirty_worktree_base_mismatch"
          && error?.userMessage === "Uncommitted changes can move into a new worktree only from main. Switch the base branch to match or clean up local changes first."
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
