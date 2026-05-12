// FILE: relay-image-sanitizer.js
// Purpose: Pure transformations that scrub bridge → phone JSON-RPC payloads
//          before they hit the relay. The phone never wants to see inline
//          image data, full compaction-replacement transcripts, or
//          generated-image blobs without their saved paths attached; this
//          module is where those rules live so bridge.js can stay focused on
//          orchestration.
// Layer: Bridge support (pure)
// Exports:
//   - annotateImageGenerationHistoryItem
//   - sanitizeInlineHistoryImageContentItem
//   - sanitizeCompactionHistoryItem
//   - sanitizeLiveGeneratedImageMessageForRelay
//   - RELAY_HISTORY_IMAGE_REFERENCE_URL
// Depends on: path, ../providers/codex/home (Codex-only path resolution)

const path = require("path");
const { resolveCodexGeneratedImagesRoot } = require("../providers/codex/home");

const RELAY_HISTORY_IMAGE_REFERENCE_URL = "agnt://history-image-elided";

function readString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeNonEmptyString(value) {
  const str = readString(value).trim();
  return str.length > 0 ? str : "";
}

function parseJSON(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeLiveGeneratedImageMessageForRelay(rawMessage) {
  const parsed = parseJSON(rawMessage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawMessage;
  }

  const params = parsed.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return rawMessage;
  }

  const sanitizedParams = sanitizeLiveGeneratedImageParams(params);
  if (sanitizedParams === params) {
    return rawMessage;
  }

  return JSON.stringify({
    ...parsed,
    params: sanitizedParams,
  });
}

function sanitizeLiveGeneratedImageParams(params) {
  const threadId = liveGeneratedImageThreadId(params);
  let nextParams = params;
  let didChange = false;

  const item = params.item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const sanitizedItem = annotateImageGenerationPayload(item, threadId);
    if (sanitizedItem !== item) {
      nextParams = { ...nextParams, item: sanitizedItem };
      didChange = true;
    }
  }

  const event = params.event;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const sanitizedEvent = sanitizeNestedGeneratedImagePayloads(event, threadId);
    if (sanitizedEvent !== event) {
      nextParams = { ...nextParams, event: sanitizedEvent };
      didChange = true;
    }
  }

  const sanitizedDirectParams = annotateImageGenerationPayload(nextParams, threadId);
  if (sanitizedDirectParams !== nextParams) {
    nextParams = sanitizedDirectParams;
    didChange = true;
  }

  return didChange ? nextParams : params;
}

function sanitizeNestedGeneratedImagePayloads(value, threadId) {
  let nextValue = annotateImageGenerationPayload(value, threadId);
  let didChange = nextValue !== value;

  for (const key of ["item", "payload", "data"]) {
    const nested = nextValue?.[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }
    const sanitizedNested = sanitizeNestedGeneratedImagePayloads(nested, threadId);
    if (sanitizedNested !== nested) {
      if (!didChange) {
        nextValue = { ...nextValue };
        didChange = true;
      }
      nextValue[key] = sanitizedNested;
    }
  }

  return didChange ? nextValue : value;
}

// Drops huge replacement-history blobs from compaction items because the phone only needs
// the compacted marker itself, not the entire pre-compaction transcript snapshot.
function sanitizeCompactionHistoryItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  let sanitizedItem = omitCompactionReplacementHistory(item);
  const payload = sanitizedItem.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const sanitizedPayload = omitCompactionReplacementHistory(payload);
    if (sanitizedPayload !== payload) {
      sanitizedItem = {
        ...sanitizedItem,
        payload: sanitizedPayload,
      };
    }
  }

  return sanitizedItem;
}

function omitCompactionReplacementHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  let nextValue = value;
  let didChange = false;
  for (const key of ["replacement_history", "replacementHistory"]) {
    if (Object.prototype.hasOwnProperty.call(nextValue, key)) {
      if (!didChange) {
        nextValue = { ...nextValue };
        didChange = true;
      }
      delete nextValue[key];
    }
  }

  return didChange ? nextValue : value;
}

function annotateImageGenerationHistoryItem(item, threadId) {
  if (!item || typeof item !== "object") {
    return item;
  }

  const normalizedType = normalizeRelayHistoryContentType(item.type);
  if (!isGeneratedImageRelayType(normalizedType)) {
    return item;
  }

  return annotateImageGenerationPayload(item, threadId);
}

function annotateImageGenerationPayload(item, threadId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  const normalizedType = normalizeRelayHistoryContentType(item.type);
  if (!isGeneratedImageRelayType(normalizedType)) {
    return item;
  }

  let nextItem = item;
  let didChange = false;
  const existingPath = normalizeNonEmptyString(item.saved_path)
    || normalizeNonEmptyString(item.savedPath)
    || normalizeNonEmptyString(item.path)
    || normalizeNonEmptyString(item.file_path);
  const generatedPath = existingPath || generatedImagePathForHistoryItem(item, threadId);
  if (generatedPath && !existingPath) {
    nextItem = {
      ...nextItem,
      saved_path: generatedPath,
    };
    didChange = true;
  }

  if (typeof nextItem.result === "string" && nextItem.result.length > 0) {
    const {
      result: _result,
      ...withoutInlineResult
    } = nextItem;
    nextItem = {
      ...withoutInlineResult,
      result_elided_for_relay: true,
    };
    didChange = true;
  }

  return didChange ? nextItem : item;
}

function generatedImagePathForHistoryItem(item, threadId) {
  const resolvedThreadId = normalizeNonEmptyString(threadId);
  const normalizedType = normalizeRelayHistoryContentType(item.type);
  const callId = normalizedType === "imagegenerationend"
    ? normalizeNonEmptyString(item.call_id)
      || normalizeNonEmptyString(item.callId)
      || normalizeNonEmptyString(item.itemId)
      || normalizeNonEmptyString(item.item_id)
      || normalizeNonEmptyString(item.id)
    : normalizeNonEmptyString(item.id)
      || normalizeNonEmptyString(item.call_id)
      || normalizeNonEmptyString(item.callId)
      || normalizeNonEmptyString(item.itemId)
      || normalizeNonEmptyString(item.item_id);
  if (!resolvedThreadId || !callId) {
    return "";
  }

  return path.join(resolveCodexGeneratedImagesRoot(), resolvedThreadId, `${callId}.png`);
}

function isGeneratedImageRelayType(normalizedType) {
  return normalizedType === "imagegeneration"
    || normalizedType === "imagegenerationcall"
    || normalizedType === "imagegenerationend"
    || normalizedType === "imageview";
}

function liveGeneratedImageThreadId(params) {
  const event = params?.event && typeof params.event === "object" && !Array.isArray(params.event)
    ? params.event
    : null;
  const item = params?.item && typeof params.item === "object" && !Array.isArray(params.item)
    ? params.item
    : null;

  return normalizeNonEmptyString(params?.threadId)
    || normalizeNonEmptyString(params?.thread_id)
    || normalizeNonEmptyString(params?.conversationId)
    || normalizeNonEmptyString(params?.conversation_id)
    || normalizeNonEmptyString(event?.threadId)
    || normalizeNonEmptyString(event?.thread_id)
    || normalizeNonEmptyString(event?.conversationId)
    || normalizeNonEmptyString(event?.conversation_id)
    || normalizeNonEmptyString(item?.threadId)
    || normalizeNonEmptyString(item?.thread_id)
    || "";
}

// Converts `data:image/...` history content into a tiny placeholder the iPhone can render safely.
function sanitizeInlineHistoryImageContentItem(contentItem) {
  if (!contentItem || typeof contentItem !== "object") {
    return contentItem;
  }

  const normalizedType = normalizeRelayHistoryContentType(contentItem.type);
  if (!isRelayHistoryImageContentType(normalizedType)) {
    return contentItem;
  }

  const hasInlineUrl = hasInlineHistoryImageDataURL(contentItem.url)
    || hasInlineHistoryImageDataURL(contentItem.image_url)
    || hasInlineHistoryImageDataURL(contentItem.path);
  if (!hasInlineUrl) {
    return contentItem;
  }

  const {
    url: _url,
    image_url: _imageUrl,
    path: _path,
    ...rest
  } = contentItem;

  return {
    ...rest,
    url: RELAY_HISTORY_IMAGE_REFERENCE_URL,
  };
}

function normalizeRelayHistoryContentType(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[\s_-]+/g, "")
    : "";
}

// Covers Codex history variants such as image, local_image, and input_image.
function isRelayHistoryImageContentType(normalizedType) {
  return normalizedType === "image"
    || normalizedType === "localimage"
    || normalizedType === "inputimage"
    || normalizedType === "outputimage";
}

function hasInlineHistoryImageDataURL(value) {
  if (typeof value === "string") {
    return value.toLowerCase().startsWith("data:image");
  }

  if (Array.isArray(value)) {
    return value.some(hasInlineHistoryImageDataURL);
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(hasInlineHistoryImageDataURL);
  }

  return false;
}

module.exports = {
  RELAY_HISTORY_IMAGE_REFERENCE_URL,
  annotateImageGenerationHistoryItem,
  sanitizeInlineHistoryImageContentItem,
  sanitizeCompactionHistoryItem,
  sanitizeLiveGeneratedImageMessageForRelay,
};
