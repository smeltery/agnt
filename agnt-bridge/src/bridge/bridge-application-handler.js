const { normalizePhoneRuntimeRequest } = require("../desktop/runtime/phone-request");
const { handleDesktopRequest } = require("../handlers/desktop-handler");
const { handleGitRequest } = require("../git/git-handler");
const { handleThreadContextRequest } = require("../handlers/thread-context-handler");
const { handleWorkspaceRequest } = require("../handlers/workspace-handler");
const { handleProjectRequest } = require("../handlers/project-handler");
const { handlePetRequest } = require("../handlers/pet-handler");
const { createJsonRpcErrorResponse } = require("../handlers/account-handler");
const { createApplicationMessageRouter } = require("./application-message-router");
const {
  parseAdaptiveThreadTurnsListRequest,
  fetchAdaptiveThreadTurnsListForRelay,
  maybeBuildJsonlThreadTurnsListFallback,
  buildEmptyTurnsListResponse,
} = require("./turns-list-pager");
const {
  annotateTurnStateProbeWithMirrorActiveTurn,
} = require("./turn-state-probe");

function createBridgeApplicationHandler({
  activeProvider,
  accountHandler,
  bridgeManagedCodex,
  bridgePreferences,
  codex,
  desktopBundle,
  desktopIpcActionFollower,
  desktopIpcLiveOwner,
  desktopRefresher,
  forwardedRequestTracker,
  handshakeHandler,
  handleFallbackMessage,
  handleRuntimeSettings = () => false,
  handleActivity = () => false,
  notificationsHandler,
  rememberThreadFromMessage,
  rolloutLiveMirror,
  sanitizeThreadHistoryImagesForRelay,
  sendApplicationResponse,
  sendThreadNameUpdatedNotification,
  terminalHandler,
  threadTurnsListFastPageCoordinator,
  updateBridgePackageAndRestart,
  voiceHandler,
}) {
  function handleBridgeManagedThreadTurnsListRequest(rawMessage) {
    const request = parseAdaptiveThreadTurnsListRequest(rawMessage);
    if (!request) {
      return false;
    }

    rememberThreadFromMessage("phone", rawMessage);
    (async () => {
      try {
        const selection = await threadTurnsListFastPageCoordinator.resolve(request, {
          fetchCanonical: (canonicalRequest) => fetchAdaptiveThreadTurnsListForRelay(canonicalRequest, {
            fetchPage: (params) => bridgeManagedCodex.sendRequest("thread/turns/list", params),
            sanitizeForRelay: (raw, method) => sanitizeThreadHistoryImagesForRelay(raw, method, {
              activeProviderId: activeProvider.id,
            }),
          }),
          readJsonl: (jsonlRequest) => ({
            response: maybeBuildJsonlThreadTurnsListFallback(
              activeProvider,
              jsonlRequest,
              buildEmptyTurnsListResponse(jsonlRequest)
            ),
            usesJsonl: true,
          }),
        });
        const response = annotateTurnStateProbeWithMirrorActiveTurn(
          request,
          selection.response,
          (threadId) => rolloutLiveMirror?.getActiveTurnId(threadId) || null
        );
        forwardedRequestTracker.markSanitizedResponse(request.id, "thread/turns/list");
        sendApplicationResponse(JSON.stringify(response));
      } catch (error) {
        sendApplicationResponse(createJsonRpcErrorResponse(
          request.id,
          error,
          "thread_turns_list_failed"
        ));
      }
    })();

    return true;
  }

  const route = createApplicationMessageRouter({
    stages: [
      (msg) => handshakeHandler.handlePhoneMessage(msg),
      (msg) => handleActivity(msg),
      (msg) => accountHandler.handleBridgeManagedAccountRequest(msg, sendApplicationResponse),
      (msg) => accountHandler.handleNonCodexVoiceRequest(msg, sendApplicationResponse),
      (msg) => voiceHandler.handleVoiceRequest(msg, sendApplicationResponse),
      (msg) => terminalHandler.handleTerminalRequest(msg, sendApplicationResponse),
      (msg) => handleThreadContextRequest(msg, sendApplicationResponse),
      (msg) => handleWorkspaceRequest(msg, sendApplicationResponse, {
        generatedImagesDir: typeof activeProvider.generatedImagesDir === "function"
          ? () => activeProvider.generatedImagesDir() || null
          : () => null,
      }),
      (msg) => handleProjectRequest(msg, sendApplicationResponse),
      (msg) => handlePetRequest(msg, sendApplicationResponse),
      (msg) => notificationsHandler.handleNotificationsRequest(msg, sendApplicationResponse),
      (msg) => handleDesktopRequest(msg, sendApplicationResponse, {
        bundleId: desktopBundle.id,
        appPath: desktopBundle.appPath,
        readBridgePreferences: bridgePreferences.read,
        updateBridgePreferences: bridgePreferences.update,
        updateBridgePackageAndRestart,
      }),
      (msg) => handleGitRequest(msg, sendApplicationResponse, {
        codexAppPath: desktopBundle.appPath,
        onThreadNameSet: sendThreadNameUpdatedNotification,
        codexTitleGeneration: activeProvider.id === "codex",
      }),
      (msg) => { desktopRefresher.handleInbound(msg); return false; },
      (msg) => { desktopIpcLiveOwner?.observeInbound(msg); return false; },
      (msg) => { rolloutLiveMirror?.observeInbound(msg); return false; },
      (msg) => { forwardedRequestTracker.rememberRequest(msg); return false; },
      (msg) => desktopIpcActionFollower?.observeInbound(msg),
      (msg) => handleRuntimeSettings(msg, sendApplicationResponse),
      (msg) => handleBridgeManagedThreadTurnsListRequest(msg),
    ],
    fallback: (msg) => handleFallbackMessage(msg, codex),
  });
  return (message) => route(activeProvider.id === "codex" ? normalizePhoneRuntimeRequest(message) : message);
}

module.exports = {
  createBridgeApplicationHandler,
};
