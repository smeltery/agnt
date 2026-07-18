const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { resolveActiveProvider } = require("../providers/index");
const {
  firstNonEmptyString,
  isPathInside,
  realpathOrNull,
  resolveReadableWorkspaceRoot,
  resolveWorkspaceCwd,
  workspaceError,
} = require("./workspace-paths");

const execFileAsync = promisify(execFile);
const MAX_IMAGE_READ_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_READ_BYTES = 2 * 1024 * 1024;
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
    cwd ? resolveReadableWorkspaceRoot(cwd) : null,
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

module.exports = { workspaceReadImage };
