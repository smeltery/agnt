// FILE: project-handler.js
// Purpose: Serves safe Mac-local project folder discovery and creation requests from the iOS app.
// Layer: Bridge handler
// Exports: handleProjectRequest plus testable project filesystem helpers
// Depends on: fs, os, path, ../providers/codex/home

const fs = require("fs");
const path = require("path");
const { createJsonRpcRequestHandler } = require("./handler-utils");
const {
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
} = require("./project-handler-utils");
const { resolveCodexHome } = require("../providers/codex/home");

// ─── ENTRY POINT ─────────────────────────────────────────────

const handleProjectRequest = createJsonRpcRequestHandler({
  match: (method) => method.startsWith("project/"),
  dispatch: handleProjectMethod,
  defaultErrorCode: "project_error",
  defaultErrorMessage: "Unknown project folder error",
});

async function handleProjectMethod(method, params, options = {}) {
  switch (method) {
    case "project/quickLocations":
      return projectQuickLocations(options);
    case "project/projectlessRoots":
      return projectProjectlessRoots(options);
    case "project/listDirectory":
      return projectListDirectory(params, options);
    case "project/searchDirectories":
      return projectSearchDirectories(params, options);
    case "project/validatePath":
      return projectValidatePath(params, options);
    case "project/createDirectory":
      return projectCreateDirectory(params, options);
    case "project/createRootlessChatRoot":
      return projectCreateRootlessChatRoot(params, options);
    default:
      throw projectError("unknown_method", `Unknown project method: ${method}`);
  }
}

// ─── Project Methods ─────────────────────────────────────────

async function projectQuickLocations(options = {}) {
  const homeDir = resolveHomeDir(options);
  const candidates = [
    { id: "home", label: "Home", path: homeDir },
    { id: "developer", label: "Developer", path: path.join(homeDir, "Developer") },
    { id: "documents", label: "Documents", path: path.join(homeDir, "Documents") },
    { id: "desktop", label: "Desktop", path: path.join(homeDir, "Desktop") },
  ];

  const locations = [];
  for (const candidate of candidates) {
    const validated = await validateDirectory(candidate.path, options).catch(() => null);
    if (!validated?.exists || !validated.isDirectory || !validated.isAllowed) {
      continue;
    }

    locations.push({
      id: candidate.id,
      label: candidate.label,
      path: validated.path,
    });
  }

  return { locations };
}

async function projectProjectlessRoots(options = {}) {
  const homeDir = resolveHomeDir(options);
  const codexHome = path.resolve(readString(options.codexHome) || resolveCodexHome());
  const documentedThreadsRoot = path.join(codexHome, "threads");
  const desktopDocumentsRoot = path.join(homeDir, "Documents", "Codex");
  const roots = uniqueExistingOrCandidatePaths([
    documentedThreadsRoot,
    desktopDocumentsRoot,
  ]);

  return {
    codexHome,
    roots,
    documentedThreadsRoot,
    desktopDocumentsRoot,
  };
}

async function projectListDirectory(params, options = {}) {
  const requestedPath = readString(params.path) || resolveHomeDir(options);
  const directory = await requireUsableDirectory(requestedPath, options);
  const includeHidden = params.includeHidden === true;
  const limit = normalizeLimit(params.limit);
  const entries = await readDirectoryEntries(directory.path, {
    ...options,
    includeHidden,
    limit,
  });

  return {
    path: directory.path,
    parentPath: parentPathWithinAllowedRoots(directory.path, options),
    entries,
  };
}

async function projectSearchDirectories(params, options = {}) {
  const requestedPath = readString(params.path) || resolveHomeDir(options);
  const query = readString(params.query);
  const directory = await requireUsableDirectory(requestedPath, options);
  if (!query) {
    return {
      path: directory.path,
      entries: [],
    };
  }

  const includeHidden = params.includeHidden === true;
  const entries = await searchDirectoryEntries(directory.path, query, {
    ...options,
    includeHidden,
    limit: normalizeSearchLimit(params.limit),
    maxDepth: normalizeSearchDepth(params.maxDepth),
    maxVisited: normalizeSearchVisitedLimit(params.maxVisited),
  });

  return {
    path: directory.path,
    entries,
  };
}

async function projectValidatePath(params, options = {}) {
  const requestedPath = readString(params.path);
  if (!requestedPath) {
    throw projectError("missing_path", "A folder path is required.");
  }

  return validateDirectory(requestedPath, options);
}

async function projectCreateDirectory(params, options = {}) {
  const parentPath = readString(params.parentPath || params.parent || params.path);
  const rawName = readString(params.name || params.folderName || params.directoryName);
  if (!parentPath) {
    throw projectError("missing_parent_path", "A parent folder path is required.");
  }
  if (!rawName) {
    throw projectError("missing_directory_name", "A new folder name is required.");
  }

  const parent = await requireUsableDirectory(parentPath, options);
  const name = normalizeNewDirectoryName(rawName);
  const targetPath = path.join(parent.path, name);
  assertPathAllowed(targetPath, options);

  try {
    await fs.promises.mkdir(targetPath, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw projectError("directory_exists", "A folder with that name already exists.");
    }
    throw projectError("create_failed", error?.message || "Unable to create that folder.");
  }

  const created = await requireUsableDirectory(targetPath, options);
  return {
    path: created.path,
    parentPath: parent.path,
    name: path.basename(created.path),
  };
}

async function projectCreateRootlessChatRoot(params = {}, options = {}) {
  const homeDir = resolveHomeDir(options);
  const desktopDocumentsRoot = path.join(homeDir, "Documents", "Codex");
  const dateFolder = readString(params.dateFolder) || formatRootlessChatDate(new Date());
  if (!isISODateFolderName(dateFolder)) {
    throw projectError("invalid_date_folder", "The chat date folder must be in YYYY-MM-DD format.");
  }

  const slugBase = rootlessChatSlugFromPromptHint(params.promptHint);
  const dateRootPath = path.join(desktopDocumentsRoot, dateFolder);

  try {
    await fs.promises.mkdir(dateRootPath, { recursive: true });
  } catch (error) {
    throw projectError("create_failed", error?.message || "Unable to prepare the Codex chats folder.");
  }

  const targetPath = await reserveUniqueRootlessChatPath(dateRootPath, slugBase);
  try {
    await fs.promises.mkdir(targetPath, { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw projectError("create_failed", error?.message || "Unable to create the rootless chat folder.");
    }
  }

  const resolvedPath = await safeRealpath(targetPath);
  return {
    path: resolvedPath,
    parentPath: dateRootPath,
    name: path.basename(resolvedPath),
    slug: slugBase,
    dateFolder,
    root: desktopDocumentsRoot,
  };
}

module.exports = {
  handleProjectRequest,
  handleProjectMethod,
  projectQuickLocations,
  projectProjectlessRoots,
  projectListDirectory,
  projectSearchDirectories,
  projectValidatePath,
  projectCreateDirectory,
  projectCreateRootlessChatRoot,
  rootlessChatSlugFromPromptHint,
  validateDirectory,
};
