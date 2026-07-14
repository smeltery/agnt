const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

async function resolveWorkspaceCwd(params) {
  const requestedCwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory]);

  if (!requestedCwd) {
    throw workspaceError(
      "missing_working_directory",
      "Workspace actions require a bound local working directory."
    );
  }

  if (!isExistingDirectory(requestedCwd)) {
    throw workspaceError(
      "missing_working_directory",
      "The requested local working directory does not exist on this Mac."
    );
  }

  return requestedCwd;
}

async function resolveRepoRoot(cwd) {
  try {
    const output = await git(cwd, "rev-parse", "--show-toplevel");
    const repoRoot = output.trim();
    if (repoRoot) {
      return repoRoot;
    }
  } catch {
    // Fall through to the user-facing error below.
  }

  throw workspaceError(
    "missing_working_directory",
    "The selected local folder is not inside a Git repository."
  );
}

async function resolveReadableWorkspaceRoot(cwd) {
  const realRepoRoot = await resolveRepoRoot(cwd).then(realpathOrNull).catch(() => null);
  if (realRepoRoot) {
    return realRepoRoot;
  }

  const realCwd = await realpathOrNull(cwd);
  if (!realCwd || isBroadWorkspaceRoot(realCwd)) {
    return null;
  }
  return realCwd;
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

async function realpathOrNull(candidatePath) {
  try {
    return await fs.promises.realpath(candidatePath);
  } catch {
    return null;
  }
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBroadWorkspaceRoot(candidatePath) {
  const normalized = path.resolve(candidatePath);
  return normalized === path.parse(normalized).root
    || normalized === path.resolve(os.homedir());
}

function workspaceError(errorCode, userMessage) {
  const err = new Error(userMessage);
  err.errorCode = errorCode;
  err.userMessage = userMessage;
  return err;
}

function git(cwd, ...args) {
  return execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_EXEC_MAX_BUFFER_BYTES,
  })
    .then(({ stdout }) => stdout)
    .catch((err) => {
      const msg = (err.stderr || err.message || "").trim();
      throw new Error(msg || "git command failed");
    });
}

module.exports = {
  firstNonEmptyString,
  git,
  isPathInside,
  realpathOrNull,
  resolveReadableWorkspaceRoot,
  resolveRepoRoot,
  resolveWorkspaceCwd,
  workspaceError,
};
