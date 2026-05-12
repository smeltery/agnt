// FILE: git-draft-helpers.js
// Purpose: Pure helpers for the bridge's AI-draft RPCs — prompts handed to
//          `codex exec --output-schema`, normalizers that validate the JSON
//          objects Codex returns, and the error wrappers that surface
//          failures to the iOS app.
// Layer: utility — no spawn, no fs, no git. Just text in / text out plus a
//        couple of error shape builders. Reusable for any structured-JSON
//        draft (commit message, PR draft, thread title).
// Exports: see module.exports at the bottom.
//
// Why a module: git-handler.js used to inline 15 small pure helpers across
// ~250 lines, interleaved with file-system + spawn-heavy git plumbing.
// Lifting the helpers makes the prompt contracts (what Codex sees) and the
// schema contracts (what the bridge expects back) visible in one place, and
// lets contract tests pin them without spinning up a git workspace.
//
// Three private helpers (gitError, normalizeNonEmptyLine,
// normalizeNonEmptyMultilineString) are duplicated from git-handler.js
// rather than imported. They are pure, four to five lines each, and used by
// both modules; duplicating them avoids a circular import and keeps the
// draft-helpers module self-contained.

const GIT_DRAFT_PATCH_MAX_BYTES = 80_000;

// ── prompts ──────────────────────────────────────────────────────────────

function buildCommitDraftPrompt(context) {
  const changedFiles = context.files
    .map((file) => `- ${file.status || "M"} ${file.path}`)
    .join("\n");

  return [
    "Write a detailed Git commit message from the repository context below.",
    "Return JSON only that matches the provided schema.",
    "Rules:",
    "- `subject` must be imperative, 72 characters or fewer, and must not end with a period.",
    "- `body` must be non-empty and use 2 to 5 concise Markdown bullets.",
    "- `fullMessage` must equal the final commit text: subject, blank line, then body.",
    "- Do not mention AI, Codex, prompt instructions, or that the message was generated.",
    "",
    `Repository: ${context.repoRoot}`,
    `Branch: ${context.branch}`,
    `Diff totals: +${context.diff.additions} -${context.diff.deletions} binary=${context.diff.binaryFiles}`,
    "Changed files:",
    changedFiles || "- (none)",
    "",
    "Patch:",
    "```diff",
    context.patch,
    "```",
  ].join("\n");
}

function buildPullRequestDraftPrompt(context) {
  const commitLines = context.commitList.length > 0 ? context.commitList.map((line) => `- ${line}`).join("\n") : "- None";

  return [
    "Write a pull request title and body from the repository context below.",
    "Return JSON only that matches the provided schema.",
    "Rules:",
    "- `title` should be concise and readable on GitHub.",
    "- `body` must be Markdown with exactly these top-level sections: `## Summary`, `## Testing`, `## Notes`.",
    "- In `## Testing`, explicitly say when testing was not run or could not be verified. Do not invent test results.",
    "- Keep the body specific to the actual diff and commits.",
    "- Do not mention AI, Codex, prompt instructions, or that the text was generated.",
    "",
    `Repository: ${context.repoRoot}`,
    `Base branch: ${context.baseBranch}`,
    `Current branch: ${context.currentBranch}`,
    `Merge base: ${context.mergeBase}`,
    `Diff totals: +${context.diff.additions} -${context.diff.deletions} binary=${context.diff.binaryFiles}`,
    "Commits since base:",
    commitLines,
    "",
    "Patch:",
    "```diff",
    context.patch,
    "```",
  ].join("\n");
}

function buildThreadTitlePrompt(context) {
  const attachmentLine = context.attachmentCount > 0
    ? `Attachments: ${context.attachmentCount} image${context.attachmentCount === 1 ? "" : "s"}`
    : "Attachments: none";

  return [
    "Write a short chat thread title from the user's first message.",
    "Return JSON only that matches the provided schema.",
    "Rules:",
    "- `title` must be 2 to 4 words, maximum 4 words.",
    "- Use a concise noun or verb phrase that captures the task.",
    "- Do not use markdown, quotes, emoji, or final punctuation.",
    "- Do not mention AI, Codex, prompt instructions, or that the title was generated.",
    "",
    attachmentLine,
    "",
    "First message:",
    messageForPrompt(context.message),
  ].join("\n");
}

// Caps the user's first message so the prompt stays under Codex limits.
function messageForPrompt(message) {
  const trimmed = normalizeNonEmptyMultilineString(message);
  if (trimmed.length <= 4_000) {
    return trimmed;
  }
  return `${trimmed.slice(0, 4_000).trimEnd()}\n[Message truncated for title generation.]`;
}

// Trims the diff embedded in commit / PR prompts. Codex still needs enough
// context to summarize but unbounded patches blow the prompt budget.
function truncateDraftPatch(patch) {
  if (Buffer.byteLength(patch, "utf8") <= GIT_DRAFT_PATCH_MAX_BYTES) {
    return patch;
  }

  let byteCount = 0;
  const keptLines = [];
  for (const line of patch.split("\n")) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (byteCount + lineBytes > GIT_DRAFT_PATCH_MAX_BYTES) {
      break;
    }
    keptLines.push(line);
    byteCount += lineBytes;
  }

  return [
    ...keptLines,
    "",
    `[Diff truncated for draft generation after ${GIT_DRAFT_PATCH_MAX_BYTES} bytes.]`,
  ].join("\n");
}

// ── normalizers ──────────────────────────────────────────────────────────

function normalizeCommitDraft(draft) {
  const subject = normalizeCommitSubject(draft?.subject);
  const body = normalizeNonEmptyMultilineString(draft?.body);

  if (!subject || !body) {
    throw new Error("Commit draft was missing a valid subject or body.");
  }

  const fullMessage = `${subject}\n\n${body}`;
  return { subject, body, fullMessage };
}

function normalizePullRequestDraft(draft) {
  const title = normalizeNonEmptyLine(draft?.title);
  const body = normalizeNonEmptyMultilineString(draft?.body);

  if (!title || !body) {
    throw new Error("Pull request draft was missing a valid title or body.");
  }

  const requiredHeadings = ["## Summary", "## Testing", "## Notes"];
  if (!requiredHeadings.every((heading) => body.includes(heading))) {
    throw new Error("Pull request draft body was missing one or more required sections.");
  }

  return { title, body };
}

function normalizeThreadTitleDraft(draft, fallbackMessage) {
  const title = sanitizeGeneratedThreadTitle(draft?.title || buildPromptThreadTitleFallback(fallbackMessage));
  return { title };
}

function buildPromptThreadTitleFallback(message) {
  const words = tokenizeThreadTitleWords(message);
  if (words.length === 0) {
    return "New Thread";
  }
  return titleCaseThreadTitle(words.slice(0, 4).join(" "));
}

function sanitizeGeneratedThreadTitle(rawTitle) {
  const words = tokenizeThreadTitleWords(rawTitle);
  const title = words.slice(0, 4).join(" ");
  return titleCaseThreadTitle(title || "New Thread").slice(0, 50).trim() || "New Thread";
}

function tokenizeThreadTitleWords(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .replace(/[`*_~#[\](){}<>]/g, " ")
    .replace(/[.!?;:,，。！？；：]+$/g, "")
    .replace(/["'“”‘’]/g, "")
    .split(/\s+/)
    .map((word) => word.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

function titleCaseThreadTitle(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return "";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function normalizeCommitSubject(rawValue) {
  const trimmed = normalizeNonEmptyLine(rawValue);
  if (!trimmed) {
    return "";
  }

  const withoutTrailingPeriod = trimmed.replace(/\.+$/, "");
  if (!withoutTrailingPeriod || withoutTrailingPeriod.length > 72) {
    return "";
  }

  return withoutTrailingPeriod;
}

// ── error shaping ────────────────────────────────────────────────────────

function wrapDraftGenerationError(error, kind) {
  const detail = normalizeDraftErrorDetail(error);
  if (kind === "commit") {
    return gitError(
      "commit_message_generation_failed",
      detail ? `Could not generate a commit message. ${detail}` : "Could not generate a commit message."
    );
  }

  if (kind === "thread_title") {
    return gitError(
      "thread_title_generation_failed",
      detail ? `Could not generate a thread title. ${detail}` : "Could not generate a thread title."
    );
  }

  return gitError(
    "pull_request_draft_generation_failed",
    detail ? `Could not generate a pull request draft. ${detail}` : "Could not generate a pull request draft."
  );
}

function normalizeDraftErrorDetail(error) {
  const rawMessage = typeof error?.userMessage === "string"
    ? error.userMessage
    : typeof error?.message === "string"
      ? error.message
      : "";
  const trimmed = rawMessage.trim();
  if (!trimmed) {
    return "";
  }

  const singleLine = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).pop() || trimmed;
  return singleLine.endsWith(".") ? singleLine : `${singleLine}.`;
}

// ── private (duplicated from git-handler.js, see module header) ──────────

function gitError(errorCode, userMessage) {
  const error = new Error(userMessage);
  error.errorCode = errorCode;
  error.userMessage = userMessage;
  return error;
}

function normalizeNonEmptyLine(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  return rawValue.split("\n")[0].trim();
}

function normalizeNonEmptyMultilineString(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  return trimmed || "";
}

module.exports = {
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
};
