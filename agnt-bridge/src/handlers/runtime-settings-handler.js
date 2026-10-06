// A runtime acknowledgement, not a local mirror edit, confirms next-turn settings.
const { createJsonRpcRequestHandler } = require("./handler-utils");
const { normalizeThreadSettingsUpdate, createThreadMutationQueue } = require("../desktop/runtime/settings");

function createRuntimeSettingsHandler({ getLiveOwner, getFollower, sendRequest, runtimeSettingsStore }) {
  const enqueue = createThreadMutationQueue();
  return createJsonRpcRequestHandler({
    match: (method) => method === "thread/settings/update",
    defaultErrorCode: "runtime_settings_update_failed",
    defaultErrorMessage: "Could not update this task's runtime settings.",
    dispatch: async (_method, params) => {
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (!threadId) throw new Error("A threadId is required.");
      const owner = getLiveOwner();
      if (owner && !owner.isThreadOwned(threadId) && !getFollower()?.isLocallyAcquiredThread(threadId)) {
        throw new Error("Could not confirm this task's owner yet. Reopen the task and retry.");
      }
      const settings = normalizeThreadSettingsUpdate(params);
      if (owner?.isThreadOwned(threadId)) return owner.updateThreadSettings(threadId, settings);
      return enqueue(threadId, async () => {
        await sendRequest("thread/settings/update", { threadId, ...settings });
        return { runtimeSettings: runtimeSettingsStore.commit(threadId, settings, { source: "phone" }) };
      });
    },
  });
}

module.exports = { createRuntimeSettingsHandler };
