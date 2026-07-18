// FILE: desktop-ipc-live-owner-runtime.js
// Purpose: Owns Desktop follower runtime-setting overrides for the live owner.
// Layer: CLI helper
// Exports: createFollowerRuntimeState
// Depends on: ./desktop-ipc-shared

const {
  cloneJSON,
  readString,
} = require("./desktop-ipc-shared");

function createFollowerRuntimeState({
  conversations,
  followerRuntimeOverridesByThreadId,
  runtimeSettingsStore = null,
  scheduleSnapshot,
  logPrefix = "[agnt]",
} = {}) {
  function applyModelAndReasoning(conversationId, params) {
    const overrides = followerRuntimeOverridesByThreadId.get(conversationId) || {};
    const conversation = conversations.get(conversationId);
    if (Object.prototype.hasOwnProperty.call(params, "model")) {
      overrides.model = readString(params.model);
      if (conversation) {
        conversation.latestModel = overrides.model;
      }
    }
    if (Object.prototype.hasOwnProperty.call(params, "reasoningEffort")) {
      overrides.effort = params.reasoningEffort || null;
      if (conversation) {
        conversation.latestReasoningEffort = overrides.effort;
      }
    }
    followerRuntimeOverridesByThreadId.set(conversationId, overrides);
    if (conversation) {
      scheduleSnapshot(conversationId);
    }
    return { ok: true };
  }

  function applyCollaborationMode(conversationId, params) {
    if (!params.collaborationMode) {
      return { ok: true };
    }
    const overrides = followerRuntimeOverridesByThreadId.get(conversationId) || {};
    overrides.collaborationMode = cloneJSON(params.collaborationMode);
    followerRuntimeOverridesByThreadId.set(conversationId, overrides);
    const conversation = conversations.get(conversationId);
    if (conversation) {
      conversation.latestCollaborationMode = cloneJSON(params.collaborationMode);
      scheduleSnapshot(conversationId);
    }
    return { ok: true };
  }

  function applyThreadSettings(conversationId, threadSettings) {
    if (!threadSettings || typeof threadSettings !== "object" || Array.isArray(threadSettings)) {
      return { ok: true };
    }
    const overrides = followerRuntimeOverridesByThreadId.get(conversationId) || {};
    const model = readString(threadSettings.model)
      || readString(threadSettings.collaborationMode?.settings?.model);
    const effort = threadSettings.effort;
    if (model) {
      overrides.model = model;
    }
    if (effort !== undefined) {
      overrides.effort = effort ?? null;
    }
    if (threadSettings.collaborationMode && typeof threadSettings.collaborationMode === "object") {
      overrides.collaborationMode = cloneJSON(threadSettings.collaborationMode);
    }
    followerRuntimeOverridesByThreadId.set(conversationId, overrides);

    const conversation = conversations.get(conversationId);
    if (conversation) {
      conversation.latestThreadSettings = {
        ...(conversation.latestThreadSettings && typeof conversation.latestThreadSettings === "object"
          ? conversation.latestThreadSettings
          : {}),
        ...cloneJSON(threadSettings),
      };
      if (model) {
        conversation.latestModel = model;
      }
      if (effort !== undefined) {
        conversation.latestReasoningEffort = effort ?? null;
      }
      if (overrides.collaborationMode) {
        conversation.latestCollaborationMode = cloneJSON(overrides.collaborationMode);
      }
      scheduleSnapshot(conversationId);
    }
    return { ok: true };
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
    if (overrides.effort != null && merged.effort == null) {
      merged.effort = overrides.effort;
    }
    if (overrides.serviceTier && !readString(merged.serviceTier)) {
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
