const MODELS_WITHOUT_REASONING_SUMMARY = new Set([
  "gpt-5.3-codex-spark",
]);

// Forces app-server summary generation off for models whose Responses API calls
// reject reasoning.summary, while leaving the phone-facing runtime choice intact.
function disableUnsupportedReasoningSummaryForTurnStart(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return rawMessage;
  }
  if (!parsed || parsed.method !== "turn/start") {
    return rawMessage;
  }

  const params = parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
    ? parsed.params
    : null;
  if (!params || params.summary === "none") {
    return rawMessage;
  }

  const model = readTurnStartModel(params);
  if (!MODELS_WITHOUT_REASONING_SUMMARY.has(model)) {
    return rawMessage;
  }

  return JSON.stringify({
    ...parsed,
    params: {
      ...params,
      summary: "none",
    },
  });
}

function readTurnStartModel(params) {
  return readNonEmptyLowerString(params?.model)
    || readNonEmptyLowerString(params?.collaborationMode?.settings?.model)
    || readNonEmptyLowerString(params?.collaboration_mode?.settings?.model);
}

function readNonEmptyLowerString(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

module.exports = {
  disableUnsupportedReasoningSummaryForTurnStart,
};
