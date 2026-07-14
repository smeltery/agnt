const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");
const {
  firstNonEmptyString,
  git,
  isPathInside,
  realpathOrNull,
  resolveReadableWorkspaceRoot,
  resolveWorkspaceCwd,
  workspaceError,
} = require("./workspace-paths");

const MAX_TEXT_FILE_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_BASENAME_FALLBACK_MATCHES = 2;

async function workspaceReadFile(params) {
  const requestedPath = firstNonEmptyString([params.path, params.filePath, params.localPath]);
  if (!requestedPath) {
    throw workspaceError("missing_file_path", "The request must include a file path.");
  }

  const cwd = await resolveWorkspaceCwd(params);
  const realWorkspaceRoot = await resolveReadableWorkspaceRoot(cwd);
  const realFilePath = await resolveWorkspaceTextFilePath(cwd, requestedPath, realWorkspaceRoot);
  if (!realFilePath) {
    throw workspaceError("file_not_found", "The file no longer exists on this computer.");
  }
  if (!realWorkspaceRoot || !isPathInside(realFilePath, realWorkspaceRoot)) {
    throw workspaceError("file_path_not_allowed", "Only files in the current workspace can be viewed.");
  }

  const stat = await fs.promises.stat(realFilePath);
  if (!stat.isFile()) {
    throw workspaceError("file_not_found", "The path is not a file.");
  }
  if (stat.size > MAX_TEXT_FILE_READ_BYTES) {
    throw workspaceError(
      "file_too_large",
      "This file is too large to send to the phone. Open it on the computer or ask for a smaller section."
    );
  }

  const result = {
    path: realFilePath,
    fileName: path.basename(realFilePath),
    byteLength: stat.size,
    mtimeMs: stat.mtimeMs,
    encoding: "utf-8",
  };
  if (params.includeContent === false || params.metadataOnly === true) {
    return result;
  }
  if (isUnchangedTextFileRead(params, stat)) {
    return {
      ...result,
      notModified: true,
    };
  }

  const data = await fs.promises.readFile(realFilePath);
  const content = decodeUtf8TextFile(data);
  return {
    ...result,
    content,
    lineCount: countLines(content),
  };
}

async function resolveWorkspaceTextFilePath(cwd, requestedPath, realWorkspaceRoot) {
  const filePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(cwd, requestedPath);
  const realFilePath = await realpathOrNull(filePath);
  if (realFilePath || path.isAbsolute(requestedPath) || !realWorkspaceRoot) {
    return realFilePath;
  }

  if (!isBareFileName(requestedPath)) {
    return null;
  }

  return resolveUniqueWorkspaceBasenameMatch(realWorkspaceRoot, requestedPath);
}

async function resolveUniqueWorkspaceBasenameMatch(realWorkspaceRoot, requestedFileName) {
  const matches = await findWorkspaceBasenameMatches(realWorkspaceRoot, requestedFileName);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw workspaceError(
      "file_path_ambiguous",
      `Multiple files named "${requestedFileName}" exist in this workspace. Use a path with folders.`
    );
  }
  return matches[0];
}

async function findWorkspaceBasenameMatches(realWorkspaceRoot, requestedFileName) {
  const matches = [];
  const output = await git(realWorkspaceRoot, "ls-files", "-co", "--exclude-standard").catch(() => "");
  const relativePaths = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const relativePath of relativePaths) {
    if (path.basename(relativePath) !== requestedFileName) {
      continue;
    }
    const realCandidate = await realpathOrNull(path.resolve(realWorkspaceRoot, relativePath));
    if (realCandidate && isPathInside(realCandidate, realWorkspaceRoot)) {
      matches.push(realCandidate);
      if (matches.length >= MAX_BASENAME_FALLBACK_MATCHES) {
        break;
      }
    }
  }
  return matches;
}

function isBareFileName(candidatePath) {
  return candidatePath === path.basename(candidatePath)
    && candidatePath !== "."
    && candidatePath !== "..";
}

function decodeUtf8TextFile(data) {
  const sample = data.subarray(0, Math.min(data.length, BINARY_SNIFF_BYTES));
  if (sample.includes(0)) {
    throw workspaceError("binary_file", "This file looks binary, so it cannot be shown as text.");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw workspaceError("unsupported_text_encoding", "Only UTF-8 text files can be viewed.");
  }
}

function countLines(content) {
  if (!content) {
    return 0;
  }
  const newlineCount = (content.match(/\n/g) || []).length;
  return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function isUnchangedTextFileRead(params, stat) {
  const cachedByteLength = Number(params.ifByteLength);
  const cachedMtimeMs = Number(params.ifMtimeMs);
  return Number.isFinite(cachedByteLength)
    && Number.isFinite(cachedMtimeMs)
    && cachedByteLength === stat.size
    && cachedMtimeMs === stat.mtimeMs;
}

module.exports = { workspaceReadFile };
