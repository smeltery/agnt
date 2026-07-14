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
  normalizeCodexTurnStartParams,
  normalizeProviderMessage,
  readDesktopConversationState,
  rememberThreadFromMessage,
  sendApplicationResponse,
}) {
  const threadRuntimeSettingsStore = createThreadRuntimeSettingsStore();
  const desktopIpcLiveOwner = !config.codexEndpoint && activeProvider.id === "codex"
    ? createDesktopIpcLiveOwner({
      sendApplicationResponse,
      sendCodexRequest: bridgeManagedCodex.sendRequest,
      sendRawCodexMessage: (payload) => codex.send(payload),
      normalizeTurnStartParams: normalizeCodexTurnStartParams,
      socketPath: config.desktopIpcSocketPath || undefined,
      snapshotDebounceMs: config.desktopIpcSnapshotDebounceMs,
      runtimeSettingsStore: threadRuntimeSettingsStore,
    })
    : null;

  const desktopIpcActionFollower = !config.codexEndpoint
    ? createDesktopIpcActionFollower({
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

  return {
    desktopIpcActionFollower,
    desktopIpcLiveOwner,
    rolloutLiveMirror,
  };
}

module.exports = {
  createBridgeDesktopIntegrations,
};
