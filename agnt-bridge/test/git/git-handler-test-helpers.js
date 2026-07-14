// FILE: git-handler-test-helpers.js
// Purpose: Shared fixtures for local git bridge tests.
// Layer: Unit Test
// Exports: node:test cases
// Depends on: child_process, fs, os, path

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Keep fixture commands and production git-handler child processes isolated from developer git signing config.
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

// Publishes a branch to origin, then deletes the local ref so the bridge sees it as remote-only.
function pushRemoteOnlyBranch(repoDir, remoteDir, branchName) {
  git(remoteDir, "init", "--bare");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "push", "-u", "origin", "main");
  git(repoDir, "branch", branchName);
  git(repoDir, "push", "-u", "origin", branchName);
  git(repoDir, "branch", "-D", branchName);
}


module.exports = {
  git,
  makeTempRepo,
  canonicalPath,
  makeBareRemote,
  pushRemoteOnlyBranch,
};
