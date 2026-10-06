// FILE: desktop-ipc-live-owner-runtime.js
// Purpose: Owns Desktop follower runtime-setting overrides for the live owner.
// Layer: CLI helper
// Exports: createFollowerRuntimeState
// Depends on: ./desktop-ipc-shared

const { applyRuntimeSettingsToConversation, createThreadMutationQueue, hasOwn,
  normalizeThreadSettingsUpdate, threadSettingsFromRuntimeSettings } = require("./runtime/settings");

const {
  cloneJSON,
  readString,
} = require("./desktop-ipc-shared");

function createFollowerRuntimeState({
  conversations,
  followerRuntimeOverridesByThreadId,
  runtimeSettingsStore = null,
  sendCodexRequest,
  scheduleSnapshot,
  logPrefix = "[agnt]",
} = {}) {
  const enqueueMutation = createThreadMutationQueue();

  function applyModelAndReasoning(conversationId, params) {
    const settings = normalizeThreadSettingsUpdate(params);
    if (hasOwn(params, "reasoningEffort")) settings.effort = params.reasoningEffort;
    return applyThreadSettings(conversationId, settings);
  }

  function applyCollaborationMode(conversationId, params) {
    return applyThreadSettings(conversationId, { collaborationMode: params.collaborationMode });
  }

  function applyThreadSettings(conversationId, threadSettings, source = "desktop") {
    return enqueueMutation(conversationId, async () => {
      if (!threadSettings || typeof threadSettings !== "object" || Array.isArray(threadSettings)) {
        throw new Error("Missing thread settings.");
      }
      const revisionBefore = runtimeSettingsStore?.get?.(conversationId)?.revision;
      const settings = normalizeThreadSettingsUpdate(threadSettings);
      await sendCodexRequest("thread/settings/update", { threadId: conversationId, ...settings });
      const current = runtimeSettingsStore?.get?.(conversationId);
      const confirmed = current && current.revision !== revisionBefore
        ? current : runtimeSettingsStore?.commit?.(conversationId, settings, { source });
      const applied = confirmed ? { ...settings, ...threadSettingsFromRuntimeSettings(confirmed) } : settings;
      const overrides = followerRuntimeOverridesByThreadId.get(conversationId) || {};
      followerRuntimeOverridesByThreadId.set(conversationId, { ...overrides, ...applied });
      applyRuntimeSettingsToConversation(conversations.get(conversationId), applied, { authoritative: !!confirmed });
      scheduleSnapshot(conversationId);
      return { ok: true, runtimeSettings: confirmed || null };
    });
  }

  function mergeOverrides(conversationId, params) {
    const persistedSettings = runtimeSettingsStore?.get?.(conversationId) || null;
    const persistedOverrides = persistedSettings
      ? {
        model: persistedSettings.model,
        effort: persistedSettings.reasoningEffort,
        serviceTier: persistedSettings.serviceTier,
      }
      : null;
    const liveOverrides = followerRuntimeOverridesByThreadId.get(conversationId) || null;
    const overrides = persistedOverrides || liveOverrides
      ? { ...(persistedOverrides || {}), ...(liveOverrides || {}) }
      : null;
    if (!overrides) {
      return params;
    }
    const merged = { ...params };
    if (overrides.model && !readString(merged.model)) {
      merged.model = overrides.model;
    }
    if (hasOwn(overrides, "effort") && !hasOwn(merged, "effort")) {
      merged.effort = overrides.effort;
    }
    if (hasOwn(overrides, "serviceTier") && !hasOwn(merged, "serviceTier")) {
      merged.serviceTier = overrides.serviceTier;
    }
    if (overrides.collaborationMode && merged.collaborationMode == null) {
      merged.collaborationMode = cloneJSON(overrides.collaborationMode);
    }
    return merged;
  }

  function commitAccepted(threadId, params, source, turnId) {
    try {
      const settings = runtimeSettingsStore?.commit?.(threadId, params, { source, turnId });
      const conversation = conversations.get(threadId);
      if (settings && conversation) {
        runtimeSettingsStore.attachToConversation(threadId, conversation);
        scheduleSnapshot(threadId);
      }
      return settings || null;
    } catch (error) {
      console.warn(`${logPrefix} runtime settings persistence failed: ${error?.message || "unknown error"}`);
      return null;
    }
  }

  return {
    enqueueMutation,
    applyCollaborationMode,
    applyModelAndReasoning,
    applyThreadSettings,
    commitAccepted,
    mergeOverrides,
  };
}

module.exports = {
  createFollowerRuntimeState,
};
