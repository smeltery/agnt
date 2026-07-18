// FILE: git-path-helpers.js
// Purpose: Shared path normalization helpers for local git RPC handlers.
// Layer: Bridge handler support

const fs = require("fs");
const os = require("os");
const path = require("path");

function normalizeNonEmptyLine(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  return rawValue.split("\n")[0].trim();
}

function normalizeNonEmptyMultilineString(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  return trimmed || "";
}

function sameFilePath(leftPath, rightPath) {
  const normalizedLeft = normalizeExistingPath(leftPath);
  const normalizedRight = normalizeExistingPath(rightPath);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeExistingPath(candidatePath) {
  if (typeof candidatePath !== "string") {
    return null;
  }

  const trimmedPath = candidatePath.trim();
  if (!trimmedPath) {
    return null;
  }

  try {
    return fs.realpathSync.native(trimmedPath);
  } catch {
    return path.resolve(trimmedPath);
  }
}

function managedWorktreesRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return normalizeExistingPath(path.join(codexHome, "worktrees"));
}

function isManagedWorktreePath(candidatePath) {
  const normalizedCandidate = normalizeExistingPath(candidatePath);
  const normalizedRoot = managedWorktreesRoot();
  if (!normalizedCandidate || !normalizedRoot) {
    return false;
  }

  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  return !!relativePath && relativePath !== "." && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function resolveProjectRelativePath(cwd, repoRoot) {
  const normalizedCwd = normalizeExistingPath(cwd);
  const normalizedRepoRoot = normalizeExistingPath(repoRoot);
  if (!normalizedCwd || !normalizedRepoRoot) {
    return "";
  }

  const relativePath = path.relative(normalizedRepoRoot, normalizedCwd);
  if (!relativePath || relativePath === ".") {
    return "";
  }

  return relativePath;
}

function scopedWorktreePath(worktreeRootPath, projectRelativePath) {
  const normalizedWorktreeRootPath = normalizeExistingPath(worktreeRootPath);
  if (!normalizedWorktreeRootPath) {
    return worktreeRootPath;
  }
  if (!projectRelativePath) {
    return normalizedWorktreeRootPath;
  }

  const candidatePath = path.join(normalizedWorktreeRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : normalizedWorktreeRootPath;
}

function scopedLocalCheckoutPath(checkoutRootPath, projectRelativePath) {
  const normalizedCheckoutRootPath = normalizeExistingPath(checkoutRootPath);
  if (!normalizedCheckoutRootPath) {
    return null;
  }
  if (!projectRelativePath) {
    return normalizedCheckoutRootPath;
  }

  const candidatePath = path.join(normalizedCheckoutRootPath, projectRelativePath);
  return isExistingDirectory(candidatePath) ? normalizeExistingPath(candidatePath) ?? candidatePath : null;
}

async function resolveGitCwd(params, gitError) {
  const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);

  if (!requestedCwd) {
    throw gitError(
      "missing_working_directory",
      "Git actions require a bound local working directory."
    );
  }

  if (!isExistingDirectory(requestedCwd)) {
    throw gitError(
      "missing_working_directory",
      "The requested local working directory does not exist on this Mac."
    );
  }

  return requestedCwd;
}

function firstNonEmptyString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function isExistingDirectory(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

async function resolveRepoRoot(cwd, git) {
  const output = await git(cwd, "rev-parse", "--show-toplevel");
  const repoRoot = output.trim();
  return repoRoot || null;
}

async function resolveLocalCheckoutRoot(cwd, git) {
  const output = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const commonDir = output.trim();
  if (!commonDir) {
    return null;
  }

  const normalizedCommonDir = normalizeExistingPath(commonDir);
  if (!normalizedCommonDir) {
    return null;
  }

  if (path.basename(normalizedCommonDir) !== ".git") {
    return await resolveRepoRoot(cwd, git);
  }

  const checkoutRoot = normalizeExistingPath(path.dirname(normalizedCommonDir));
  return checkoutRoot || null;
}

module.exports = {
  firstNonEmptyString,
  isExistingDirectory,
  isManagedWorktreePath,
  normalizeExistingPath,
  normalizeNonEmptyLine,
  normalizeNonEmptyMultilineString,
  resolveGitCwd,
  resolveLocalCheckoutRoot,
  resolveProjectRelativePath,
  resolveRepoRoot,
  sameFilePath,
  scopedLocalCheckoutPath,
  scopedWorktreePath,
};
