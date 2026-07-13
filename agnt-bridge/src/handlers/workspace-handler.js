// FILE: workspace-handler.js
// Purpose: Executes workspace-scoped previews, reads, and patch operations without touching unrelated repo changes.
// Layer: Bridge handler
// Exports: handleWorkspaceRequest
// Depends on: child_process, fs, os, path, ./providers, ./git-handler

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify, TextDecoder } = require("util");
const { resolveActiveProvider } = require("../providers/index");
const { createJsonRpcRequestHandler } = require("./handler-utils");
const {
  workspaceCheckpointCapture,
  workspaceCheckpointCopy,
  workspaceCheckpointDiff,
  workspaceCheckpointRestoreApply,
  workspaceCheckpointRestorePreview,
} = require("./workspace-checkpoints");
const {
  workspaceRevertPatchApply,
  workspaceRevertPatchBatchApply,
  workspaceRevertPatchBatchPreview,
  workspaceRevertPatchPreview,
} = require("./workspace-revert-patch");

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
// Match git-handler.js: Node default maxBuffer is 1 MiB.
const GIT_EXEC_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_READ_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_READ_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_FILE_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_BASENAME_FALLBACK_MATCHES = 2;
const MIN_IMAGE_PREVIEW_PIXEL_DIMENSION = 128;
const MAX_IMAGE_PREVIEW_PIXEL_DIMENSION = 3_200;
const IMAGE_PREVIEW_RETRY_SCALE = 0.75;
const IMAGE_PREVIEW_TOOL_TIMEOUT_MS = 5_000;
const IMAGE_PREVIEW_TOTAL_TIMEOUT_MS = 15_000;
const IMAGE_MIME_TYPES_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".svg", "image/svg+xml"],
]);
const repoMutationLocks = new Map();

const handleWorkspaceRequest = createJsonRpcRequestHandler({
  match: (method) => method.startsWith("workspace/"),
  dispatch: handleWorkspaceMethod,
  defaultErrorCode: "workspace_error",
  defaultErrorMessage: "Unknown workspace error",
});

async function handleWorkspaceMethod(method, params, options = {}) {
  if (method === "workspace/readImage") {
    return workspaceReadImage(params, options);
  }
  if (method === "workspace/readFile") {
    return workspaceReadFile(params);
  }

  const cwd = await resolveWorkspaceCwd(params);
  const repoRoot = await resolveRepoRoot(cwd);

  switch (method) {
    case "workspace/checkpointCapture":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointCapture(repoRoot, params));
    case "workspace/checkpointCopy":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointCopy(repoRoot, params));
    case "workspace/checkpointDiff":
      return workspaceCheckpointDiff(repoRoot, params);
    case "workspace/checkpointRestorePreview":
      return workspaceCheckpointRestorePreview(repoRoot, params);
    case "workspace/checkpointRestoreApply":
      return withRepoMutationLock(repoRoot, () => workspaceCheckpointRestoreApply(repoRoot, params));
    case "workspace/revertPatchPreview":
      return workspaceRevertPatchPreview(repoRoot, params);
    case "workspace/revertPatchApply":
      return withRepoMutationLock(repoRoot, () => workspaceRevertPatchApply(repoRoot, params));
    case "workspace/revertPatchBatchPreview":
      return workspaceRevertPatchBatchPreview(repoRoot, params);
    case "workspace/revertPatchBatchApply":
      return withRepoMutationLock(repoRoot, () => workspaceRevertPatchBatchApply(repoRoot, params));
    default:
      throw workspaceError("unknown_method", `Unknown workspace method: ${method}`);
  }
}

// Reads a UTF-8 text file from the active workspace for client-side read-only viewers.
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

// Reads recognized local image files from the bound repo, the active provider's
// generated-image cache (if any), or host temp screenshot folders.
async function workspaceReadImage(params, options = {}) {
  const requestedPath = firstNonEmptyString([params.path, params.filePath, params.localPath]);
  if (!requestedPath) {
    throw workspaceError("missing_image_path", "The request must include an image path.");
  }

  const cwd = firstNonEmptyString([params.cwd, params.currentWorkingDirectory])
    ? await resolveWorkspaceCwd(params)
    : null;
  const imagePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(cwd || process.cwd(), requestedPath);
  const extension = path.extname(imagePath).toLowerCase();
  let mimeType = IMAGE_MIME_TYPES_BY_EXTENSION.get(extension);

  const [realImagePath, realGeneratedImagesRoot] = await Promise.all([
    realpathOrNull(imagePath),
    realpathOrNull(resolveProviderGeneratedImagesDir(options)),
  ]);
  if (!realImagePath) {
    throw workspaceError("image_not_found", "The image file no longer exists on this computer.");
  }

  const [realWorkspaceRoot, realTempRoots] = await Promise.all([
    cwd ? resolveImageWorkspaceRoot(cwd) : null,
    realTemporaryImageRoots(),
  ]);
  const isAllowed =
    (realWorkspaceRoot && isPathInside(realImagePath, realWorkspaceRoot))
    || (realGeneratedImagesRoot && isPathInside(realImagePath, realGeneratedImagesRoot))
    || realTempRoots.some((tempRoot) => isPathInside(realImagePath, tempRoot));
  if (!isAllowed) {
    throw workspaceError("image_path_not_allowed", "Only images in this workspace, the active agent's generated images, or temporary screenshot files can be previewed.");
  }

  const stat = await fs.promises.stat(realImagePath);
  if (!stat.isFile()) {
    throw workspaceError("image_not_found", "The image path is not a file.");
  }
  if (!mimeType) {
    mimeType = await sniffImageMimeType(realImagePath);
  }
  if (!mimeType) {
    throw workspaceError("unsupported_image_type", "Only local image files can be previewed.");
  }
  const includeData = params.includeData !== false && params.metadataOnly !== true;
  const maxPixelDimension = normalizedPreviewPixelDimension(params);
  if (stat.size > MAX_IMAGE_READ_BYTES && !maxPixelDimension) {
    throw workspaceError(
      "image_too_large",
      "This image is too large to send to the phone. Open it on the Mac or move a smaller preview into the workspace."
    );
  }

  const result = {
    path: realImagePath,
    fileName: path.basename(realImagePath),
    mimeType,
    byteLength: stat.size,
    mtimeMs: stat.mtimeMs,
    previewMaxPixelDimension: maxPixelDimension || undefined,
  };
  if (!includeData) {
    return result;
  }
  if (isUnchangedImageRead(params, stat, maxPixelDimension)) {
    return {
      ...result,
      notModified: true,
    };
  }

  const data = maxPixelDimension && mimeType !== "image/svg+xml"
    ? await readPreviewImageData(realImagePath, maxPixelDimension, stat.size)
    : await fs.promises.readFile(realImagePath);
  return {
    ...result,
    dataByteLength: data.length,
    dataBase64: data.toString("base64"),
  };
}

function normalizedPreviewPixelDimension(params) {
  const requested = Number(params.maxPixelDimension || params.previewMaxPixelDimension);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  return Math.min(
    MAX_IMAGE_PREVIEW_PIXEL_DIMENSION,
    Math.max(MIN_IMAGE_PREVIEW_PIXEL_DIMENSION, Math.round(requested))
  );
}

async function sniffImageMimeType(filePath) {
  let header;
  try {
    const handle = await fs.promises.open(filePath, "r");
    try {
      header = Buffer.alloc(16);
      const read = await handle.read(header, 0, header.length, 0);
      header = header.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 6 && (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  return null;
}

// Resolves the active provider's generated-images directory. bridge.js passes
// an explicit thunk; direct callers of handleWorkspaceMethod (tests, scripts)
// fall back to the registry-resolved active provider so existing behavior is
// preserved when no option is supplied.
function resolveProviderGeneratedImagesDir(options = {}) {
  if (typeof options.generatedImagesDir === "function") {
    try {
      return options.generatedImagesDir() || null;
    } catch {
      return null;
    }
  }
  try {
    const { provider } = resolveActiveProvider();
    if (typeof provider?.generatedImagesDir === "function") {
      return provider.generatedImagesDir() || null;
    }
  } catch {}
  return null;
}

async function realTemporaryImageRoots() {
  const candidates = [
    os.tmpdir(),
    process.env.TMPDIR,
  ];

  if (process.platform === "darwin") {
    candidates.push("/tmp");
    candidates.push(path.join(os.homedir(), "Library", "Caches", "com.raycast-x.macos", "clipboard"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "CleanShot", "media"));
    candidates.push(path.join(os.homedir(), "Library", "Application Support", "CleanShot X", "media"));
  }

  const roots = await Promise.all(
    Array.from(new Set(candidates.filter(Boolean))).map((candidate) => realpathOrNull(candidate))
  );
  return Array.from(new Set(roots.filter(Boolean)));
}

// Read-only previews can scope non-git scratch folders to cwd while rejecting broad roots.
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

async function resolveImageWorkspaceRoot(cwd) {
  return resolveReadableWorkspaceRoot(cwd);
}

// Handles assistant links that only include a filename by finding one unique workspace match.
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

function isBroadWorkspaceRoot(candidatePath) {
  const normalized = path.resolve(candidatePath);
  return normalized === path.parse(normalized).root
    || normalized === path.resolve(os.homedir());
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

async function readPreviewImageData(imagePath, maxPixelDimension, originalByteLength) {
  const downsampler = resolveImageDownsampler();
  if (!downsampler) {
    if (originalByteLength <= MAX_IMAGE_PREVIEW_READ_BYTES) {
      return fs.promises.readFile(imagePath);
    }

    throw workspaceError(
      "image_preview_unsupported_platform",
      "This computer cannot resize image previews yet. Try a smaller image, install ImageMagick on Linux, or open it on the computer."
    );
  }

  let sawConversionFailure = false;
  const previewDeadline = Date.now() + IMAGE_PREVIEW_TOTAL_TIMEOUT_MS;
  for (const candidateDimension of previewPixelDimensionCandidates(maxPixelDimension)) {
    const remainingTimeoutMs = previewDeadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw workspaceError(
        "image_preview_timed_out",
        "This image preview took too long to resize. Try a smaller image or open it on the computer."
      );
    }

    try {
      const previewData = await downsampler(
        imagePath,
        candidateDimension,
        Math.min(IMAGE_PREVIEW_TOOL_TIMEOUT_MS, remainingTimeoutMs)
      );
      if (previewData && previewData.length > 0 && previewData.length <= MAX_IMAGE_PREVIEW_READ_BYTES) {
        return previewData;
      }
    } catch (err) {
      if (isImagePreviewTimeoutError(err)) {
        throw workspaceError(
          "image_preview_timed_out",
          "This image preview took too long to resize. Try a smaller image or open it on the computer."
        );
      }
      sawConversionFailure = true;
    }
  }

  if (sawConversionFailure) {
    throw workspaceError(
      "image_preview_failed",
      "This image could not be converted into a lightweight phone preview."
    );
  }

  throw workspaceError(
    "image_preview_too_large",
    "This image preview is still too large to send to the phone."
  );
}

function previewPixelDimensionCandidates(maxPixelDimension) {
  const dimensions = [];
  let next = maxPixelDimension;
  while (next >= MIN_IMAGE_PREVIEW_PIXEL_DIMENSION) {
    dimensions.push(next);
    if (next === MIN_IMAGE_PREVIEW_PIXEL_DIMENSION) {
      break;
    }
    next = Math.max(
      MIN_IMAGE_PREVIEW_PIXEL_DIMENSION,
      Math.floor(next * IMAGE_PREVIEW_RETRY_SCALE)
    );
  }

  // Hard-to-compress previews can stay oversized after one resize; these checkpoints keep retry behavior predictable.
  for (const checkpoint of [1024, 768, 512, 384, 256, MIN_IMAGE_PREVIEW_PIXEL_DIMENSION]) {
    if (checkpoint <= maxPixelDimension) {
      dimensions.push(checkpoint);
    }
  }

  return Array.from(new Set(dimensions)).sort((a, b) => b - a);
}

function usesSipsImagePreview() {
  const normalizedPlatform = String(process.platform || "").trim().toLowerCase();
  return normalizedPlatform === "darwin" || normalizedPlatform === "macos" || normalizedPlatform === "mac";
}

// Picks the first available image resize tool: macOS `sips`, then ImageMagick on Linux
// (`magick` for IM7 / `convert` for IM6). Other platforms fall back to direct reads.
function resolveImageDownsampler() {
  if (usesSipsImagePreview()) {
    return downsampleImageWithSips;
  }
  if (process.platform !== "linux") {
    return null;
  }
  const imageMagickBin = resolveImageMagickBinary();
  if (imageMagickBin) {
    return (imagePath, dim, timeoutMs) => downsampleImageWithImageMagick(imageMagickBin, imagePath, dim, timeoutMs);
  }
  return null;
}

let cachedImageMagickBinary;

function resolveImageMagickBinary() {
  if (cachedImageMagickBinary !== undefined) {
    return cachedImageMagickBinary;
  }
  const pathEnv = typeof process.env.PATH === "string" ? process.env.PATH : "";
  const segments = pathEnv ? pathEnv.split(path.delimiter) : [];
  for (const candidate of ["magick", "convert"]) {
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      const fullPath = path.join(segment, candidate);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          cachedImageMagickBinary = candidate;
          return candidate;
        }
      } catch {}
    }
  }
  cachedImageMagickBinary = null;
  return null;
}

async function downsampleImageWithSips(imagePath, maxPixelDimension, timeoutMs = IMAGE_PREVIEW_TOOL_TIMEOUT_MS) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agnt-image-preview-"));
  const outputPath = path.join(tempDir, `preview${path.extname(imagePath) || ".png"}`);
  try {
    await execFileAsync("sips", ["-Z", String(maxPixelDimension), imagePath, "--out", outputPath], {
      timeout: Math.max(1, Math.floor(timeoutMs)),
      maxBuffer: 1024 * 1024,
    });
    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// `-resize <dim>x<dim>>` (the trailing `>` only shrinks larger images and matches sips's `-Z` semantics).
async function downsampleImageWithImageMagick(bin, imagePath, maxPixelDimension, timeoutMs = IMAGE_PREVIEW_TOOL_TIMEOUT_MS) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agnt-image-preview-"));
  const outputPath = path.join(tempDir, `preview${path.extname(imagePath) || ".png"}`);
  try {
    const args = bin === "convert"
      ? [imagePath, "-resize", `${maxPixelDimension}x${maxPixelDimension}>`, outputPath]
      : ["convert", imagePath, "-resize", `${maxPixelDimension}x${maxPixelDimension}>`, outputPath];
    await execFileAsync(bin, args, {
      timeout: Math.max(1, Math.floor(timeoutMs)),
      maxBuffer: 1024 * 1024,
    });
    return await fs.promises.readFile(outputPath);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function isImagePreviewTimeoutError(err) {
  return err?.code === "ETIMEDOUT"
    || (err?.killed === true && err?.signal === "SIGTERM")
    || /timed out|timeout/i.test(String(err?.message || ""));
}

function isUnchangedImageRead(params, stat, maxPixelDimension) {
  const cachedByteLength = Number(params.ifByteLength);
  const cachedMtimeMs = Number(params.ifMtimeMs);
  const cachedPreviewMaxPixelDimension = Number(params.ifPreviewMaxPixelDimension || params.ifMaxPixelDimension);
  const previewDimensionMatches = maxPixelDimension
    ? Number.isFinite(cachedPreviewMaxPixelDimension) && cachedPreviewMaxPixelDimension === maxPixelDimension
    : !Number.isFinite(cachedPreviewMaxPixelDimension);
  return Number.isFinite(cachedByteLength)
    && Number.isFinite(cachedMtimeMs)
    && previewDimensionMatches
    && cachedByteLength === stat.size
    && cachedMtimeMs === stat.mtimeMs;
}

function isUnchangedTextFileRead(params, stat) {
  const cachedByteLength = Number(params.ifByteLength);
  const cachedMtimeMs = Number(params.ifMtimeMs);
  return Number.isFinite(cachedByteLength)
    && Number.isFinite(cachedMtimeMs)
    && cachedByteLength === stat.size
    && cachedMtimeMs === stat.mtimeMs;
}

async function withRepoMutationLock(cwd, callback) {
  const previous = repoMutationLocks.get(cwd) || Promise.resolve();
  let releaseCurrent = null;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => current);
  repoMutationLocks.set(cwd, chained);

  await previous;
  try {
    return await callback();
  } finally {
    releaseCurrent();
    if (repoMutationLocks.get(cwd) === chained) {
      repoMutationLocks.delete(cwd);
    }
  }
}

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

// Resolves the canonical repo root so revert safety checks stay stable from nested chat folders.
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

module.exports = { handleWorkspaceMethod, handleWorkspaceRequest };
