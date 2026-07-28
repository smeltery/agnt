// FILE: git-handler-managed-worktree.test.js
// Purpose: Covers detached managed worktree handoff regressions for the local git bridge.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: node:test, assert, fs, os, path, git-handler, git-handler-test-helpers

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../../src/git/git-handler");
const { git, makeTempRepo } = require("./git-handler-test-helpers");

test.afterEach(() => {
  __test.resetRunStructuredCodexJsonImplementation();
  __test.resetRunGitHubCliImplementation();
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

test("gitCreateManagedWorktree copies .worktreeinclude-listed files into the new worktree", async () => {
  const repoDir = makeTempRepo();
  const projectDir = path.join(repoDir, "agnt-bridge");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = codexHome;

  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\nignored-not-listed.txt\nlink.env\n");
    fs.writeFileSync(path.join(repoDir, ".env"), "SECRET=root\n");
    fs.mkdirSync(path.join(repoDir, "packages", "api"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "packages", "api", ".env"), "SECRET=nested\n");
    fs.writeFileSync(path.join(repoDir, "notes.local"), "plain untracked\n");
    fs.writeFileSync(path.join(repoDir, "ignored-not-listed.txt"), "skip me\n");
    fs.symlinkSync(path.join(repoDir, ".env"), path.join(repoDir, "link.env"));
    fs.writeFileSync(
      path.join(repoDir, ".worktreeinclude"),
      "# required non-tracked files\n.env\nnotes.local\nlink.env\nmissing-entry.txt\n"
    );
    git(repoDir, "add", ".gitignore", ".worktreeinclude");
    git(repoDir, "commit", "-m", "Add worktree include manifest");

    const result = await __test.gitCreateManagedWorktree(projectDir, {
      baseBranch: "main",
    });
    const worktreeRoot = path.dirname(result.worktreePath);

    assert.equal(fs.readFileSync(path.join(worktreeRoot, ".env"), "utf8"), "SECRET=root\n");
    assert.equal(
      fs.readFileSync(path.join(worktreeRoot, "packages", "api", ".env"), "utf8"),
      "SECRET=nested\n"
    );
    assert.equal(fs.readFileSync(path.join(worktreeRoot, "notes.local"), "utf8"), "plain untracked\n");
    assert.equal(fs.existsSync(path.join(worktreeRoot, "ignored-not-listed.txt")), false);
    assert.equal(fs.existsSync(path.join(worktreeRoot, "link.env")), false);
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
