// Browser-side image attachment helpers. Reads a File/Blob, validates it as
// an image MIME type, base64-encodes the raw bytes for the bridge payload,
// and produces a smaller thumbnail for in-row preview.
//
// Thumbnail is generated via canvas downscaling so we don't ship multi-MB
// data URLs into IndexedDB (the persistence cap is per-thread so big
// payloads would push older messages out).

import type { ImageAttachment } from "../models";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB — bridge cap is similar
const THUMBNAIL_MAX_DIMENSION = 320;
const THUMBNAIL_QUALITY = 0.7;

export class ImageAttachError extends Error {
  constructor(message: string, public code: "type" | "size" | "decode") {
    super(message);
    this.name = "ImageAttachError";
  }
}

export async function attachmentFromFile(file: File): Promise<ImageAttachment> {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new ImageAttachError(`Unsupported image type: ${file.type || "unknown"}`, "type");
  }
  if (file.size > MAX_PAYLOAD_BYTES) {
    throw new ImageAttachError(
      `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the bridge accepts up to ${(MAX_PAYLOAD_BYTES / 1024 / 1024).toFixed(0)} MB`,
      "size"
    );
  }
  const payloadDataUrl = await readFileAsDataUrl(file);
  const thumbnailDataUrl = await downscaleToThumbnail(payloadDataUrl, file.type).catch(() => payloadDataUrl);
  return {
    id: crypto.randomUUID(),
    payloadDataUrl,
    thumbnailDataUrl,
    fileName: file.name || undefined,
    byteLength: file.size,
  };
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new ImageAttachError("Could not read image as data URL.", "decode"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new ImageAttachError("Image read failed.", "decode"));
    reader.readAsDataURL(file);
  });
}

async function downscaleToThumbnail(sourceDataUrl: string, mimeType: string): Promise<string> {
  if (typeof document === "undefined") return sourceDataUrl;
  const image = await loadImage(sourceDataUrl);
  const ratio = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const targetWidth = Math.max(1, Math.round(image.naturalWidth * ratio));
  const targetHeight = Math.max(1, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) return sourceDataUrl;
  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  // Always re-encode as JPEG for thumbnails so big PNG/HEIC sources collapse.
  const outputType = mimeType === "image/png" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(outputType, THUMBNAIL_QUALITY);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new ImageAttachError("Could not decode image.", "decode"));
    image.src = dataUrl;
  });
}
