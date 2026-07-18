const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_DIRECTORY_LIMIT = 200;
const DEFAULT_DIRECTORY_SEARCH_LIMIT = 80;
const DEFAULT_DIRECTORY_SEARCH_MAX_DEPTH = 8;
const DEFAULT_DIRECTORY_SEARCH_MAX_VISITED = 5000;
const DEFAULT_HIDDEN_DIRECTORY_NAMES = new Set(["Library"]);
const ROOTLESS_CHAT_SLUG_MAX_TOKENS = 6;
const ROOTLESS_CHAT_SLUG_MAX_LENGTH = 60;
const ROOTLESS_CHAT_SLUG_FALLBACK = "new-chat";
const ROOTLESS_CHAT_DEDUP_LIMIT = 50;

function rootlessChatSlugFromPromptHint(rawPromptHint) {
  const hint = typeof rawPromptHint === "string" ? rawPromptHint.normalize("NFKD") : "";
  const sanitized = hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  if (!sanitized) {
    return ROOTLESS_CHAT_SLUG_FALLBACK;
  }

  const tokens = sanitized
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, ROOTLESS_CHAT_SLUG_MAX_TOKENS);
  if (!tokens.length) {
    return ROOTLESS_CHAT_SLUG_FALLBACK;
  }

  let slug = tokens.join("-");
  if (slug.length > ROOTLESS_CHAT_SLUG_MAX_LENGTH) {
    slug = slug.slice(0, ROOTLESS_CHAT_SLUG_MAX_LENGTH).replace(/-+$/g, "");
  }
  return slug || ROOTLESS_CHAT_SLUG_FALLBACK;
}

async function reserveUniqueRootlessChatPath(parentDirectory, slugBase) {
  for (let attempt = 0; attempt < ROOTLESS_CHAT_DEDUP_LIMIT; attempt += 1) {
    const candidateSlug = attempt === 0 ? slugBase : `${slugBase}-${attempt + 1}`;
    const candidatePath = path.join(parentDirectory, candidateSlug);
    try {
      await fs.promises.access(candidatePath, fs.constants.F_OK);
    } catch {
      return candidatePath;
    }
  }

  return path.join(parentDirectory, `${slugBase}-${Date.now()}`);
}

function formatRootlessChatDate(date) {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isISODateFolderName(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

async function safeRealpath(candidatePath) {
  try {
    return await fs.promises.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

// ─── Filesystem Helpers ──────────────────────────────────────

async function readDirectoryEntries(directoryPath, options = {}) {
  let dirents;
  try {
    dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    throw projectError("read_failed", error?.message || "Unable to read that folder.");
  }

  const entries = [];
  for (const dirent of dirents) {
    if (!options.includeHidden && isHiddenDirectoryName(dirent.name)) {
      continue;
    }

    const childPath = path.join(directoryPath, dirent.name);
    const directory = await directoryEntryForPath(childPath, dirent, options);
    if (directory) {
      entries.push(directory);
    }
  }

  return entries
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .slice(0, options.limit || DEFAULT_DIRECTORY_LIMIT);
}

async function searchDirectoryEntries(rootPath, query, options = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) {
    return [];
  }

  const limit = options.limit || DEFAULT_DIRECTORY_SEARCH_LIMIT;
  const maxDepth = options.maxDepth ?? DEFAULT_DIRECTORY_SEARCH_MAX_DEPTH;
  const maxVisited = options.maxVisited || DEFAULT_DIRECTORY_SEARCH_MAX_VISITED;
  const queue = [{ directoryPath: rootPath, depth: 0 }];
  const visitedDirectories = new Set([realpathSyncIfAvailable(rootPath) || rootPath]);
  const matches = [];
  let visitedCount = 0;

  while (queue.length && matches.length < limit && visitedCount < maxVisited) {
    const { directoryPath, depth } = queue.shift();
    visitedCount += 1;

    let dirents;
    try {
      dirents = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of sortedDirents(dirents)) {
      if (!options.includeHidden && isHiddenDirectoryName(dirent.name)) {
        continue;
      }

      const childPath = path.join(directoryPath, dirent.name);
      const directory = await directoryEntryForPath(childPath, dirent, options);
      if (!directory) {
        continue;
      }

      if (directoryMatchesSearch(directory, tokens)) {
        matches.push(directory);
        if (matches.length >= limit) {
          break;
        }
      }

      if (!dirent.isSymbolicLink() && depth < maxDepth) {
        const realPath = directory.path;
        if (!visitedDirectories.has(realPath)) {
          visitedDirectories.add(realPath);
          queue.push({ directoryPath: realPath, depth: depth + 1 });
        }
      }
    }
  }

  return matches;
}

async function directoryEntryForPath(candidatePath, dirent, options = {}) {
  if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
    return null;
  }

  const validation = await validateDirectory(candidatePath, options).catch(() => null);
  if (!validation?.exists || !validation.isDirectory || !validation.isAllowed) {
    return null;
  }

  return {
    name: dirent.name,
    path: validation.path,
    isSymlink: dirent.isSymbolicLink(),
  };
}

async function requireUsableDirectory(candidatePath, options = {}) {
  const validation = await validateDirectory(candidatePath, options);
  if (!validation.isAllowed) {
    throw projectError("path_not_allowed", "That folder is outside the allowed local project locations.");
  }
  if (!validation.exists) {
    throw projectError("missing_directory", "That folder does not exist on this Mac.");
  }
  if (!validation.isDirectory) {
    throw projectError("not_directory", "That path is not a folder.");
  }

  return validation;
}

async function validateDirectory(candidatePath, options = {}) {
  const normalizedPath = normalizeCandidatePath(candidatePath, options);
  const isAllowed = isPathAllowed(normalizedPath, options);
  if (!isAllowed) {
    return {
      path: normalizedPath,
      exists: false,
      isDirectory: false,
      isAllowed: false,
    };
  }

  try {
    const realPath = await fs.promises.realpath(normalizedPath);
    const stats = await fs.promises.stat(realPath);
    return {
      path: realPath,
      exists: true,
      isDirectory: stats.isDirectory(),
      isAllowed: isPathAllowed(realPath, options),
    };
  } catch {
    return {
      path: normalizedPath,
      exists: false,
      isDirectory: false,
      isAllowed,
    };
  }
}

function parentPathWithinAllowedRoots(candidatePath, options = {}) {
  const parentPath = path.dirname(candidatePath);
  if (!parentPath || parentPath === candidatePath) {
    return null;
  }

  return isPathAllowed(parentPath, options) ? parentPath : null;
}

function assertPathAllowed(candidatePath, options = {}) {
  if (!isPathAllowed(candidatePath, options)) {
    throw projectError("path_not_allowed", "That folder is outside the allowed local project locations.");
  }
}

function isPathAllowed(candidatePath, options = {}) {
  const normalizedPath = path.resolve(candidatePath);
  return allowedProjectRoots(options).some((rootPath) => samePathOrDescendant(normalizedPath, rootPath));
}

function allowedProjectRoots(options = {}) {
  const roots = Array.isArray(options.allowedRoots) && options.allowedRoots.length
    ? options.allowedRoots
    : [resolveHomeDir(options)];

  return [...new Set(roots.flatMap((rootPath) => {
    const resolvedRoot = path.resolve(rootPath);
    return [resolvedRoot, realpathSyncIfAvailable(resolvedRoot)].filter(Boolean);
  }))];
}

function samePathOrDescendant(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeCandidatePath(candidatePath, options = {}) {
  const rawPath = readString(candidatePath);
  if (!rawPath) {
    throw projectError("missing_path", "A folder path is required.");
  }

  if (rawPath === "~" || rawPath.startsWith("~/")) {
    return path.resolve(resolveHomeDir(options), rawPath.slice(2));
  }

  if (!path.isAbsolute(rawPath)) {
    throw projectError("invalid_path", "Use an absolute folder path.");
  }

  return path.resolve(rawPath);
}

function isHiddenDirectoryName(name) {
  return name.startsWith(".") || DEFAULT_HIDDEN_DIRECTORY_NAMES.has(name);
}

function normalizeNewDirectoryName(rawName) {
  const name = rawName.trim();
  if (!name || name === "." || name === "..") {
    throw projectError("invalid_directory_name", "Use a valid folder name.");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw projectError("invalid_directory_name", "Folder names cannot contain path separators.");
  }
  if (name.length > 120) {
    throw projectError("invalid_directory_name", "Use a shorter folder name.");
  }

  return name;
}

function normalizeLimit(rawLimit) {
  const numericLimit = Number(rawLimit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return DEFAULT_DIRECTORY_LIMIT;
  }

  return Math.min(Math.floor(numericLimit), DEFAULT_DIRECTORY_LIMIT);
}

function normalizeSearchLimit(rawLimit) {
  const numericLimit = Number(rawLimit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return DEFAULT_DIRECTORY_SEARCH_LIMIT;
  }

  return Math.min(Math.floor(numericLimit), DEFAULT_DIRECTORY_SEARCH_LIMIT);
}

function normalizeSearchDepth(rawDepth) {
  const numericDepth = Number(rawDepth);
  if (!Number.isFinite(numericDepth) || numericDepth < 0) {
    return DEFAULT_DIRECTORY_SEARCH_MAX_DEPTH;
  }

  return Math.min(Math.floor(numericDepth), DEFAULT_DIRECTORY_SEARCH_MAX_DEPTH);
}

function normalizeSearchVisitedLimit(rawLimit) {
  const numericLimit = Number(rawLimit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return DEFAULT_DIRECTORY_SEARCH_MAX_VISITED;
  }

  return Math.min(Math.floor(numericLimit), DEFAULT_DIRECTORY_SEARCH_MAX_VISITED);
}

function sortedDirents(dirents) {
  return [...dirents].sort((left, right) => (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  ));
}

function searchTokens(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function directoryMatchesSearch(directory, tokens) {
  const haystack = directory.name.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function resolveHomeDir(options = {}) {
  return options.homeDir || os.homedir();
}

function uniqueExistingOrCandidatePaths(paths) {
  const seen = new Set();
  const result = [];

  for (const candidatePath of paths) {
    const normalizedPath = path.resolve(candidatePath);
    const realPath = realpathSyncIfAvailable(normalizedPath) || normalizedPath;
    if (seen.has(realPath)) {
      continue;
    }
    seen.add(realPath);
    result.push(realPath);
  }

  return result;
}

function realpathSyncIfAvailable(candidatePath) {
  try {
    return fs.realpathSync(candidatePath);
  } catch {
    return null;
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function projectError(errorCode, userMessage) {
  const err = new Error(userMessage);
  err.errorCode = errorCode;
  err.userMessage = userMessage;
  return err;
}

module.exports = {
  assertPathAllowed,
  formatRootlessChatDate,
  isISODateFolderName,
  normalizeLimit,
  normalizeNewDirectoryName,
  normalizeSearchDepth,
  normalizeSearchLimit,
  normalizeSearchVisitedLimit,
  parentPathWithinAllowedRoots,
  projectError,
  readDirectoryEntries,
  readString,
  requireUsableDirectory,
  reserveUniqueRootlessChatPath,
  resolveHomeDir,
  rootlessChatSlugFromPromptHint,
  safeRealpath,
  searchDirectoryEntries,
  uniqueExistingOrCandidatePaths,
  validateDirectory,
};
