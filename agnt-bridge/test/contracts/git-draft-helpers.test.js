// FILE: contracts/git-draft-helpers.test.js
// Purpose: Pins the prompt + normalizer contracts the bridge hands to
//          `codex exec --output-schema`. Prompts must be byte-stable so
//          tweaks don't silently drift commit/PR/title quality; normalizers
//          must reject malformed Codex output so bad JSON never reaches the
//          iOS app as a "draft".
// Layer: Contract test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GIT_DRAFT_PATCH_MAX_BYTES,
  buildCommitDraftPrompt,
  buildPromptThreadTitleFallback,
  buildPullRequestDraftPrompt,
  buildThreadTitlePrompt,
  messageForPrompt,
  normalizeCommitDraft,
  normalizeCommitSubject,
  normalizeDraftErrorDetail,
  normalizePullRequestDraft,
  normalizeThreadTitleDraft,
  sanitizeGeneratedThreadTitle,
  titleCaseThreadTitle,
  tokenizeThreadTitleWords,
  truncateDraftPatch,
  wrapDraftGenerationError,
} = require("../../src/git/git-draft-helpers");

// ── prompt builders ──────────────────────────────────────────────────────

test("buildCommitDraftPrompt includes repo, branch, diff totals, file list and patch", () => {
  const prompt = buildCommitDraftPrompt({
    repoRoot: "/repo",
    branch: "main",
    diff: { additions: 5, deletions: 2, binaryFiles: 0 },
    files: [
      { status: "M", path: "a.js" },
      { status: "A", path: "b.js" },
    ],
    patch: "@@ -1,1 +1,2 @@",
  });
  assert.match(prompt, /Write a detailed Git commit message/);
  assert.match(prompt, /Repository: \/repo/);
  assert.match(prompt, /Branch: main/);
  assert.match(prompt, /Diff totals: \+5 -2 binary=0/);
  assert.match(prompt, /- M a\.js/);
  assert.match(prompt, /- A b\.js/);
  assert.match(prompt, /```diff\n@@ -1,1 \+1,2 @@\n```/);
});

test("buildCommitDraftPrompt renders '- (none)' when there are no changed files", () => {
  const prompt = buildCommitDraftPrompt({
    repoRoot: "/repo",
    branch: "main",
    diff: { additions: 0, deletions: 0, binaryFiles: 0 },
    files: [],
    patch: "",
  });
  assert.match(prompt, /Changed files:\n- \(none\)/);
});

test("buildPullRequestDraftPrompt enforces the Summary/Testing/Notes section rule in the instructions", () => {
  const prompt = buildPullRequestDraftPrompt({
    repoRoot: "/repo",
    baseBranch: "main",
    currentBranch: "feature/x",
    mergeBase: "abc123",
    diff: { additions: 10, deletions: 1, binaryFiles: 0 },
    commitList: ["abc123 first commit", "def456 second"],
    patch: "@@ patch @@",
  });
  assert.match(prompt, /## Summary.*## Testing.*## Notes/s);
  assert.match(prompt, /Base branch: main/);
  assert.match(prompt, /Current branch: feature\/x/);
  assert.match(prompt, /- abc123 first commit/);
  assert.match(prompt, /- def456 second/);
});

test("buildPullRequestDraftPrompt renders '- None' when there are no commits since base", () => {
  const prompt = buildPullRequestDraftPrompt({
    repoRoot: "/repo",
    baseBranch: "main",
    currentBranch: "feature/x",
    mergeBase: "abc",
    diff: { additions: 0, deletions: 0, binaryFiles: 0 },
    commitList: [],
    patch: "",
  });
  assert.match(prompt, /Commits since base:\n- None/);
});

test("buildThreadTitlePrompt enforces 2-to-4-word title and surfaces attachment count", () => {
  const prompt = buildThreadTitlePrompt({
    message: "First user message",
    attachmentCount: 2,
  });
  assert.match(prompt, /`title` must be 2 to 4 words/);
  assert.match(prompt, /Attachments: 2 images/);
  assert.match(prompt, /First message:\nFirst user message/);
});

test("buildThreadTitlePrompt renders 'Attachments: none' when count is 0", () => {
  const prompt = buildThreadTitlePrompt({ message: "hi", attachmentCount: 0 });
  assert.match(prompt, /Attachments: none/);
});

test("buildThreadTitlePrompt singularizes 'image' when count is 1", () => {
  const prompt = buildThreadTitlePrompt({ message: "hi", attachmentCount: 1 });
  assert.match(prompt, /Attachments: 1 image\n/);
});

// ── patch truncation ─────────────────────────────────────────────────────

test("GIT_DRAFT_PATCH_MAX_BYTES is the documented 80kB budget", () => {
  assert.equal(GIT_DRAFT_PATCH_MAX_BYTES, 80_000);
});

test("truncateDraftPatch returns the patch unchanged when under the byte budget", () => {
  const patch = "@@ small @@\n+ one\n- two";
  assert.equal(truncateDraftPatch(patch), patch);
});

test("truncateDraftPatch trims at line boundaries and appends a truncation note", () => {
  const longLine = "+ " + "a".repeat(1024);
  const patch = Array(200).fill(longLine).join("\n");
  const truncated = truncateDraftPatch(patch);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= GIT_DRAFT_PATCH_MAX_BYTES + 256,
    "truncated patch must respect the byte budget (plus the note)");
  assert.match(truncated, /\[Diff truncated for draft generation after 80000 bytes\.\]$/);
  // No partial-line truncation: the last kept line ends with a full newline.
  assert.ok(truncated.split("\n").every((line) => !line.endsWith(" a")
    || line === longLine
    || line === ""
    || line.startsWith("[Diff truncated")));
});

// ── message helper ───────────────────────────────────────────────────────

test("messageForPrompt returns short messages verbatim", () => {
  assert.equal(messageForPrompt("hello"), "hello");
});

test("messageForPrompt truncates messages over 4000 chars and appends a note", () => {
  const long = "a".repeat(5_000);
  const trimmed = messageForPrompt(long);
  assert.ok(trimmed.length < long.length);
  assert.match(trimmed, /\[Message truncated for title generation\.\]$/);
  assert.ok(trimmed.startsWith("a".repeat(100)));
});

test("messageForPrompt returns empty string for non-string input", () => {
  assert.equal(messageForPrompt(null), "");
  assert.equal(messageForPrompt(undefined), "");
  assert.equal(messageForPrompt(42), "");
});

// ── normalizers ──────────────────────────────────────────────────────────

test("normalizeCommitDraft accepts valid subject + body and synthesizes fullMessage", () => {
  const out = normalizeCommitDraft({
    subject: "fix: handle empty payload",
    body: "- guard against null\n- add test",
  });
  assert.equal(out.subject, "fix: handle empty payload");
  assert.equal(out.body, "- guard against null\n- add test");
  assert.equal(out.fullMessage, "fix: handle empty payload\n\n- guard against null\n- add test");
});

test("normalizeCommitDraft rejects missing subject or body", () => {
  assert.throws(() => normalizeCommitDraft({ subject: "x", body: "" }), /missing a valid/);
  assert.throws(() => normalizeCommitDraft({ subject: "", body: "x" }), /missing a valid/);
  assert.throws(() => normalizeCommitDraft({}), /missing a valid/);
});

test("normalizeCommitDraft strips trailing periods from the subject before fullMessage assembly", () => {
  const out = normalizeCommitDraft({
    subject: "Add foo.",
    body: "- did stuff",
  });
  assert.equal(out.subject, "Add foo");
  assert.match(out.fullMessage, /^Add foo\n\n- did stuff$/);
});

test("normalizeCommitDraft rejects subjects longer than 72 characters", () => {
  const longSubject = "x".repeat(73);
  assert.throws(() => normalizeCommitDraft({
    subject: longSubject,
    body: "- something",
  }), /missing a valid/);
});

test("normalizePullRequestDraft requires the Summary/Testing/Notes headings", () => {
  const valid = "## Summary\n- x\n\n## Testing\n- y\n\n## Notes\n- z";
  assert.deepEqual(
    normalizePullRequestDraft({ title: "Add foo", body: valid }),
    { title: "Add foo", body: valid },
  );
  assert.throws(
    () => normalizePullRequestDraft({ title: "Add foo", body: "## Summary\n- only summary" }),
    /required sections/,
  );
});

test("normalizePullRequestDraft rejects missing title or body", () => {
  assert.throws(() => normalizePullRequestDraft({ title: "", body: "## Summary\n## Testing\n## Notes" }), /missing a valid/);
  assert.throws(() => normalizePullRequestDraft({ title: "x", body: "" }), /missing a valid/);
});

test("normalizeThreadTitleDraft picks the Codex-returned title when present, else falls back to the message", () => {
  assert.deepEqual(
    normalizeThreadTitleDraft({ title: "Login Bug" }, "fallback message"),
    { title: "Login Bug" },
  );
  // No title from Codex -> fallback path tokenizes the seed message.
  const out = normalizeThreadTitleDraft({}, "fix login redirect now");
  assert.match(out.title, /Fix Login Redirect Now|Fix login redirect now/);
});

test("normalizeThreadTitleDraft caps the title at 50 characters and 4 words", () => {
  const out = normalizeThreadTitleDraft({ title: "one two three four five six seven" }, "");
  const words = out.title.split(" ");
  assert.ok(words.length <= 4, `expected ≤4 words, got ${words.length}`);
  assert.ok(out.title.length <= 50, `expected ≤50 chars, got ${out.title.length}`);
});

// ── thread-title text helpers ────────────────────────────────────────────

test("tokenizeThreadTitleWords strips markdown, quotes, and trailing punctuation", () => {
  assert.deepEqual(
    tokenizeThreadTitleWords("**Hello** _world_!"),
    ["Hello", "world"],
  );
  assert.deepEqual(
    tokenizeThreadTitleWords('"smart quotes"'),
    ["smart", "quotes"],
  );
  assert.deepEqual(tokenizeThreadTitleWords(""), []);
  assert.deepEqual(tokenizeThreadTitleWords(null), []);
});

test("titleCaseThreadTitle capitalizes only the first letter", () => {
  assert.equal(titleCaseThreadTitle("hello world"), "Hello world");
  assert.equal(titleCaseThreadTitle("  trimmed  "), "Trimmed");
  assert.equal(titleCaseThreadTitle(""), "");
  assert.equal(titleCaseThreadTitle(null), "");
});

test("sanitizeGeneratedThreadTitle defaults to 'New Thread' on empty/whitespace input", () => {
  assert.equal(sanitizeGeneratedThreadTitle(""), "New Thread");
  assert.equal(sanitizeGeneratedThreadTitle("   "), "New Thread");
  assert.equal(sanitizeGeneratedThreadTitle(null), "New Thread");
});

test("buildPromptThreadTitleFallback condenses arbitrary messages into a 4-word title", () => {
  assert.equal(
    buildPromptThreadTitleFallback("how do I install dependencies on macOS"),
    "How do I install",
  );
  assert.equal(buildPromptThreadTitleFallback(""), "New Thread");
});

// ── commit subject helper ────────────────────────────────────────────────

test("normalizeCommitSubject strips trailing periods and rejects long subjects", () => {
  assert.equal(normalizeCommitSubject("add things."), "add things");
  assert.equal(normalizeCommitSubject("add things..."), "add things");
  assert.equal(normalizeCommitSubject("x".repeat(73)), "");
  assert.equal(normalizeCommitSubject(""), "");
});

// ── error shaping ────────────────────────────────────────────────────────

test("wrapDraftGenerationError produces tagged errors with userMessage", () => {
  const wrapped = wrapDraftGenerationError(new Error("codex broke"), "commit");
  assert.equal(wrapped.errorCode, "commit_message_generation_failed");
  assert.match(wrapped.userMessage, /Could not generate a commit message/);
  assert.match(wrapped.userMessage, /codex broke\.$/);
});

test("wrapDraftGenerationError distinguishes the three kinds", () => {
  assert.equal(wrapDraftGenerationError(new Error("x"), "commit").errorCode,
    "commit_message_generation_failed");
  assert.equal(wrapDraftGenerationError(new Error("x"), "thread_title").errorCode,
    "thread_title_generation_failed");
  // Anything unrecognized falls through to the PR-draft default — pre-existing behaviour.
  assert.equal(wrapDraftGenerationError(new Error("x"), "pull_request").errorCode,
    "pull_request_draft_generation_failed");
  assert.equal(wrapDraftGenerationError(new Error("x"), "anything-else").errorCode,
    "pull_request_draft_generation_failed");
});

test("normalizeDraftErrorDetail picks the last meaningful stderr line and appends a period", () => {
  assert.equal(normalizeDraftErrorDetail(new Error("boom")), "boom.");
  assert.equal(normalizeDraftErrorDetail({ message: "line1\nline2\nline3" }), "line3.");
  assert.equal(normalizeDraftErrorDetail({ message: "" }), "");
  assert.equal(normalizeDraftErrorDetail(null), "");
});

test("normalizeDraftErrorDetail prefers userMessage over message when present", () => {
  assert.equal(
    normalizeDraftErrorDetail({ userMessage: "user-facing", message: "internal" }),
    "user-facing.",
  );
});
