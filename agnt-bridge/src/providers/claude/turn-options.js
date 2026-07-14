const {
  deriveTitleFromSeed,
  numberOr,
  readString,
} = require("../_shared/translator-utils");
const { mapCodexEffortToClaude } = require("./turn-input");

function publishTurnArgsForParams(params, transport) {
  const args = [];
  const model = readString(params?.model)
    || readString(params?.modelId)
    || readString(params?.modelID);
  if (model) args.push("--model", model);

  const effort = readString(params?.effort)
    || readString(params?.reasoning_effort);
  if (effort) {
    const mapped = mapCodexEffortToClaude(effort.toLowerCase());
    if (mapped) args.push("--effort", mapped);
  }

  const collaborationMode = readString(params?.collaborationMode?.mode);
  if (collaborationMode === "plan") {
    args.push("--permission-mode", "plan");
  } else {
    const explicitMode = readString(params?.permissionMode);
    const permissionMode = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]
      .includes(explicitMode) ? explicitMode : "";
    // In --print mode there is no TTY for Claude to prompt on. The `default`
    // mode would block forever waiting for an approval that never comes.
    args.push("--permission-mode", permissionMode || "acceptEdits");
  }

  try { transport?.setTurnArgs?.(args); } catch { /* best-effort */ }
}

function handleGenerateTitle({
  injectResponse,
  request,
  threadId,
}) {
  if (request?.id == null) return;
  const params = request?.params || {};
  const seed = readString(params.seed)
    || readString(params.firstMessage)
    || readString(params.message)
    || "";
  const title = deriveTitleFromSeed(seed);
  injectResponse(request.id, {
    threadId: readString(params.threadId) || threadId,
    title,
    name: title,
  });
}

function handleContextWindowRead({
  injectResponse,
  lastUsage,
  request,
  threadId,
}) {
  if (request?.id == null) return;
  // Claude doesn't surface a context-window endpoint on the CLI; report a
  // best-effort snapshot so the app's status row keeps rendering.
  injectResponse(request.id, {
    threadId: threadId || "",
    contextWindow: lastUsage
      ? {
        inputTokens: numberOr(lastUsage.input_tokens, 0),
        outputTokens: numberOr(lastUsage.output_tokens, 0),
        cacheReadTokens: numberOr(lastUsage.cache_read_input_tokens, 0),
        cacheCreateTokens: numberOr(lastUsage.cache_creation_input_tokens, 0),
      }
      : null,
  });
}

module.exports = {
  handleContextWindowRead,
  handleGenerateTitle,
  publishTurnArgsForParams,
};
