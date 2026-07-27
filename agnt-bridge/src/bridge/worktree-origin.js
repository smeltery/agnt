// FILE: bridge/worktree-origin.js
// Purpose: Resolves the checkout that owns a Codex-managed worktree for thread grouping.
// Layer: Bridge support
// Exports: createWorktreeOriginEnricher

const fs = require("fs");
const os = require("os");
const path = require("path");
const { forEachThreadRowInResponse } = require("./thread-row-enrichment");

const DEFAULT_MAX_ENTRIES = 1024;
const THREAD_ROW_CWD_KEYS = ["cwd", "workingDirectory", "working_directory", "current_working_directory"];

function createWorktreeOriginEnricher({
  fsModule = fs,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const worktreesRoots = managedWorktreesRoots(codexHome, fsModule);
  const cache = new Map();

  function originPathForCwd(cwd) {
    if (cache.has(cwd)) {
      const cached = cache.get(cwd);
      cache.delete(cwd);
      cache.set(cwd, cached);
      return cached;
    }

    const originPath = resolveOriginPath(cwd);
    cache.set(cwd, originPath);
    while (cache.size > Math.max(1, maxEntries)) {
      cache.delete(cache.keys().next().value);
    }
    return originPath;
  }

  function resolveOriginPath(cwd) {
    const scope = resolveManagedWorktreeScope(cwd, worktreesRoots);
    if (!scope) {
      return "";
    }

    const checkoutRoot = readOwningCheckoutRoot(scope.worktreeRoot, fsModule);
    if (!checkoutRoot) {
      return "";
    }
    if (!scope.relativePath) {
      return checkoutRoot;
    }

    const scopedPath = path.join(checkoutRoot, scope.relativePath);
    return isExistingDirectory(scopedPath, fsModule) ? scopedPath : checkoutRoot;
  }

  function attachToThread(thread) {
    if (!thread || typeof thread !== "object" || normalizeString(thread.worktreeOriginPath)) {
      return thread;
    }

    const cwd = threadRowCwd(thread);
    if (!cwd) {
      return thread;
    }

    const originPath = originPathForCwd(cwd);
    if (originPath) {
      thread.worktreeOriginPath = originPath;
    }
    return thread;
  }

  function enrichResponse(method, envelope) {
    return forEachThreadRowInResponse(method, envelope, attachToThread);
  }

  return {
    attachToThread,
    enrichResponse,
    cacheSize: () => cache.size,
  };
}

function managedWorktreesRoots(codexHome, fsModule) {
  const joinedRoot = path.join(normalizeString(codexHome) || path.join(os.homedir(), ".codex"), "worktrees");
  const roots = [joinedRoot];
  const realRoot = realPathOrNull(joinedRoot, fsModule);
  if (realRoot && realRoot !== joinedRoot) {
    roots.push(realRoot);
  }
  return roots;
}

function resolveManagedWorktreeScope(cwd, worktreesRoots) {
  for (const root of worktreesRoots) {
    const relativePath = path.relative(root, cwd);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }

    const segments = relativePath.split(path.sep).filter(Boolean);
    if (segments.length < 2) {
      continue;
    }

    return {
      worktreeRoot: path.join(root, segments[0], segments[1]),
      relativePath: segments.slice(2).join(path.sep),
    };
  }

  return null;
}

function readOwningCheckoutRoot(worktreeRoot, fsModule) {
  let gitFileContents = "";
  try {
    gitFileContents = fsModule.readFileSync(path.join(worktreeRoot, ".git"), "utf8");
  } catch {
    return "";
  }

  const gitDirMatch = /^\s*gitdir:\s*(.+?)\s*$/m.exec(gitFileContents);
  if (!gitDirMatch) {
    return "";
  }

  const gitDir = path.resolve(worktreeRoot, gitDirMatch[1]);
  const gitDirSegments = gitDir.split(path.sep);
  if (
    gitDirSegments.length < 4
    || gitDirSegments[gitDirSegments.length - 2] !== "worktrees"
    || gitDirSegments[gitDirSegments.length - 3] !== ".git"
  ) {
    return "";
  }

  return path.dirname(path.dirname(path.dirname(gitDir)));
}

function threadRowCwd(thread) {
  for (const key of THREAD_ROW_CWD_KEYS) {
    const candidate = normalizeString(thread[key]);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function isExistingDirectory(candidatePath, fsModule) {
  try {
    return fsModule.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function realPathOrNull(candidatePath, fsModule) {
  try {
    return fsModule.realpathSync(candidatePath);
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createWorktreeOriginEnricher,
};
