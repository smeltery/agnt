const { createRuntimeSettingsHandler } = require("../handlers/runtime-settings-handler");
const { createRolloutLiveMirrorController } = require("../desktop/rollout-live-mirror");
const { createDesktopIpcActionFollower } = require("../desktop/desktop-ipc-action-follower");
const { createDesktopIpcLiveOwner } = require("../desktop/desktop-ipc-live-owner");
const {
  createThreadRuntimeSettingsStore,
} = require("../desktop/thread-runtime-settings-store");

function createBridgeDesktopIntegrations({
  activeProvider,
  bridgeManagedCodex,
  codex,
  config,
  desktopRefresher,
  normalizeCodexTurnStartParams,
  normalizeProviderMessage,
  readDesktopConversationState,
  rememberThreadFromMessage,
  sendApplicationResponse,
}) {
  const threadRuntimeSettingsStore = createThreadRuntimeSettingsStore({
    onChange(threadId, runtimeSettings) {
      sendApplicationResponse(JSON.stringify({
        method: "agnt/runtimeSettings/updated", params: { threadId, runtimeSettings },
      }));
    },
  });
  // Both Desktop-owned (action follower) and bridge-owned (live owner) threads
  // can be the target of a phone-initiated auto-follow deep link, so both
  // sides forward Desktop's follow confirmation to the same refresher hook.
  function onFollowerStateChanged(threadId, following) {
    desktopRefresher?.handleFollowerStateChanged(threadId, following);
  }
  const desktopIpcLiveOwner = !config.codexEndpoint && activeProvider.id === "codex"
    ? createDesktopIpcLiveOwner({
      sendApplicationResponse,
      sendCodexRequest: bridgeManagedCodex.sendRequest,
      sendRawCodexMessage: (payload) => codex.send(payload),
      normalizeTurnStartParams: normalizeCodexTurnStartParams,
      socketPath: config.desktopIpcSocketPath || undefined,
      snapshotDebounceMs: config.desktopIpcSnapshotDebounceMs,
      runtimeSettingsStore: threadRuntimeSettingsStore,
      onFollowerStateChanged,
    })
    : null;

  const desktopIpcActionFollower = !config.codexEndpoint && activeProvider.id === "codex"
    ? createDesktopIpcActionFollower({
      runtimeSettingsStore: threadRuntimeSettingsStore,
      sendApplicationResponse,
      readConversationState: readDesktopConversationState,
      forwardToLocalCodex: (rawMessage) => {
        desktopIpcLiveOwner?.observeInbound(rawMessage);
        const forwarded = normalizeProviderMessage(rawMessage);
        rememberThreadFromMessage("phone", forwarded);
        codex.send(forwarded);
      },
      // Threads streamed by the bridge's own app-server must never be held,
      // served from Desktop echoes, or routed over the IPC bus.
      isLocallyOwnedThread: (threadId) => Boolean(desktopIpcLiveOwner?.isThreadOwned(threadId)),
      normalizeTurnStartParams: activeProvider.id === "codex"
        ? normalizeCodexTurnStartParams
        : (params) => params,
      socketPath: config.desktopIpcSocketPath || undefined,
      snapshotDebounceMs: config.desktopIpcSnapshotDebounceMs,
      onFollowerStateChanged,
    })
    : null;

  // Only the spawned local runtime needs rollout mirroring; a real endpoint
  // already provides the authoritative live stream for resumed threads.
  const rolloutLiveMirror = !config.codexEndpoint
    ? createRolloutLiveMirrorController({
      sendApplicationResponse,
      shouldSuppressThread: (threadId) => Boolean(
        desktopIpcLiveOwner?.isThreadOwned(threadId)
          || desktopIpcActionFollower?.hasFreshLiveThreadState(threadId)
      ),
    })
    : null;

  const handleRuntimeSettings = activeProvider.id === "codex" ? createRuntimeSettingsHandler({
    getLiveOwner: () => desktopIpcLiveOwner,
    getFollower: () => desktopIpcActionFollower,
    sendRequest: bridgeManagedCodex.sendRequest,
    runtimeSettingsStore: threadRuntimeSettingsStore,
  }) : () => false;

  return {
    handleRuntimeSettings,
    threadRuntimeSettingsStore,
    desktopIpcActionFollower,
    desktopIpcLiveOwner,
    rolloutLiveMirror,
  };
}

module.exports = {
  createBridgeDesktopIntegrations,
};
