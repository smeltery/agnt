const { hasOwn, normalizeServiceTier, runtimeSettingsPatch } = require("./settings");

// Adapt legacy speed semantics once at ingress. Internal omission means inherit.
function normalizePhoneRuntimeRequest(rawMessage) {
  let parsed;
  try { parsed = JSON.parse(rawMessage); } catch { return rawMessage; }
  if (!["turn/start", "thread/start", "thread/settings/update"].includes(parsed?.method)
    || !parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)) return rawMessage;
  const params = { ...parsed.params };
  if (parsed.method === "turn/start" && params.agntRuntimeSettingsVersion !== 2
    && !hasOwn(params, "serviceTier") && !hasOwn(params, "service_tier")) params.serviceTier = "default";
  delete params.agntRuntimeSettingsVersion;
  if (hasOwn(params, "serviceTier") && params.serviceTier != null) {
    params.serviceTier = normalizeServiceTier(params.serviceTier)
      ?? (parsed.method === "thread/settings/update" ? null : "default");
  }
  if (params.collaborationMode?.settings) {
    const patch = runtimeSettingsPatch(params);
    params.collaborationMode = {
      ...params.collaborationMode,
      settings: {
        ...params.collaborationMode.settings,
        ...(patch.model ? { model: patch.model } : {}),
        ...(hasOwn(patch, "reasoningEffort") ? { reasoning_effort: patch.reasoningEffort } : {}),
      },
    };
  }
  return JSON.stringify({ ...parsed, params });
}

module.exports = { normalizePhoneRuntimeRequest };
