// FILE: contracts/relay-image-sanitizer.test.js
// Purpose: Pins relay payload sanitization behaviour that bridge.js depends
//          on for phone-bound messages. The three load-bearing rules are:
//          1. Inline data: image URLs in history content get replaced with a
//             stable agnt:// placeholder — never forwarded to the relay.
//          2. Generated-image history items get a saved_path annotation
//             pointing at the local mirror and the bulky inline result is
//             elided.
//          3. Live image-generation notifications recursively walk
//             event/item/payload/data and apply the same elision so nested
//             completed-image blobs don't leak inline base64 over the wire.
//          Also pins the compaction-history dedup that prevents the relay
//          from ballooning when a compaction marker is emitted.
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RELAY_HISTORY_IMAGE_REFERENCE_URL,
  annotateImageGenerationHistoryItem,
  sanitizeInlineHistoryImageContentItem,
  sanitizeCompactionHistoryItem,
  sanitizeLiveGeneratedImageMessageForRelay,
} = require("../../src/bridge/relay-image-sanitizer");

test("RELAY_HISTORY_IMAGE_REFERENCE_URL is the agnt:// elision placeholder", () => {
  assert.equal(RELAY_HISTORY_IMAGE_REFERENCE_URL, "agnt://history-image-elided");
});

test("sanitizeInlineHistoryImageContentItem swaps data: URLs for the placeholder", () => {
  const out = sanitizeInlineHistoryImageContentItem({
    type: "image",
    url: "data:image/png;base64,AAA",
    extra: "preserved",
  });
  assert.equal(out.url, RELAY_HISTORY_IMAGE_REFERENCE_URL);
  assert.equal(out.extra, "preserved");
});

test("sanitizeInlineHistoryImageContentItem leaves non-data: URLs untouched", () => {
  const input = { type: "image", url: "https://example.com/cat.png" };
  const out = sanitizeInlineHistoryImageContentItem(input);
  assert.equal(out, input);
});

test("sanitizeInlineHistoryImageContentItem ignores non-image content types", () => {
  const input = { type: "text", url: "data:image/png;base64,AAA" };
  const out = sanitizeInlineHistoryImageContentItem(input);
  assert.equal(out, input);
});

test("sanitizeInlineHistoryImageContentItem treats input_image / local_image / output_image as image types", () => {
  for (const type of ["input_image", "local_image", "output_image"]) {
    const out = sanitizeInlineHistoryImageContentItem({
      type,
      image_url: "data:image/jpeg;base64,ZZZ",
    });
    assert.equal(out.url, RELAY_HISTORY_IMAGE_REFERENCE_URL, `type ${type} should sanitize`);
    assert.equal(out.image_url, undefined, `type ${type} should drop image_url`);
  }
});

test("annotateImageGenerationHistoryItem attaches saved_path for generated images using thread+call id", () => {
  const out = annotateImageGenerationHistoryItem(
    { type: "image_generation_call", call_id: "ig_abc", result: "BIG_BASE64" },
    "thread-xyz",
  );
  // path is platform-dependent but must contain the thread id and the call id PNG name
  assert.match(out.saved_path, /thread-xyz/);
  assert.match(out.saved_path, /ig_abc\.png$/);
  // bulky inline result must be elided, not forwarded
  assert.equal(out.result, undefined);
  assert.equal(out.result_elided_for_relay, true);
});

test("annotateImageGenerationHistoryItem preserves explicit saved_path if already present", () => {
  const out = annotateImageGenerationHistoryItem(
    { type: "image_generation_call", call_id: "ig_abc", saved_path: "/already/set.png" },
    "thread-xyz",
  );
  assert.equal(out.saved_path, "/already/set.png");
});

test("annotateImageGenerationHistoryItem leaves non-image-gen items untouched", () => {
  const input = { type: "message", text: "hello" };
  const out = annotateImageGenerationHistoryItem(input, "thread-xyz");
  assert.equal(out, input);
});

test("annotateImageGenerationHistoryItem normalizes type variants (image_generation_end, imageView, ...)", () => {
  for (const type of ["image_generation", "image_generation_call", "image_generation_end", "imageView"]) {
    const out = annotateImageGenerationHistoryItem(
      { type, call_id: "ig_42" },
      "thread-1",
    );
    assert.ok(out.saved_path, `type ${type} should be recognized`);
  }
});

test("sanitizeCompactionHistoryItem drops replacement_history at both top-level and inside payload", () => {
  const out = sanitizeCompactionHistoryItem({
    type: "compaction",
    replacement_history: ["...lots of turns..."],
    payload: {
      summary: "kept",
      replacementHistory: ["also lots"],
    },
  });
  assert.equal(out.replacement_history, undefined);
  assert.equal(out.payload.replacementHistory, undefined);
  assert.equal(out.payload.summary, "kept");
});

test("sanitizeCompactionHistoryItem is a no-op for items without replacement fields", () => {
  const input = { type: "compaction", payload: { summary: "kept" } };
  const out = sanitizeCompactionHistoryItem(input);
  assert.equal(out, input);
});

test("sanitizeLiveGeneratedImageMessageForRelay elides nested completed-image blobs", () => {
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    method: "notification",
    params: {
      threadId: "thread-live",
      event: {
        item: {
          type: "image_generation_end",
          call_id: "ig_99",
          result: "HUGE_BASE64_THAT_WOULD_BLOW_THE_RELAY",
        },
      },
    },
  });
  const sanitized = JSON.parse(sanitizeLiveGeneratedImageMessageForRelay(raw));
  const item = sanitized.params.event.item;
  assert.equal(item.result, undefined);
  assert.equal(item.result_elided_for_relay, true);
  assert.match(item.saved_path, /thread-live/);
  assert.match(item.saved_path, /ig_99\.png$/);
});

test("sanitizeLiveGeneratedImageMessageForRelay is a no-op for messages without image payloads", () => {
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    method: "thread/started",
    params: { threadId: "t" },
  });
  assert.equal(sanitizeLiveGeneratedImageMessageForRelay(raw), raw);
});

test("sanitizeLiveGeneratedImageMessageForRelay is tolerant of malformed input", () => {
  assert.equal(sanitizeLiveGeneratedImageMessageForRelay("not json"), "not json");
  assert.equal(sanitizeLiveGeneratedImageMessageForRelay(""), "");
  assert.equal(sanitizeLiveGeneratedImageMessageForRelay(JSON.stringify("string-payload")), JSON.stringify("string-payload"));
  assert.equal(
    sanitizeLiveGeneratedImageMessageForRelay(JSON.stringify({ method: "x", params: [] })),
    JSON.stringify({ method: "x", params: [] }),
  );
});

test("sanitizeLiveGeneratedImageMessageForRelay resolves threadId from event.conversationId fallback", () => {
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    method: "notification",
    params: {
      event: {
        conversationId: "thread-via-event",
        item: {
          type: "image_generation_call",
          call_id: "ig_fallback",
          result: "blob",
        },
      },
    },
  });
  const sanitized = JSON.parse(sanitizeLiveGeneratedImageMessageForRelay(raw));
  assert.match(sanitized.params.event.item.saved_path, /thread-via-event/);
});
