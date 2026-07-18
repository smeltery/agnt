const {
  appServerResultForFollowerRequest,
  desktopFollowerPayloadForResponse,
  projectedResolvedNotification,
} = require("../desktop-ipc-action-follower-support");
const {
  cloneJSON,
  readString,
  requestIdKey,
} = require("../desktop-ipc-shared");

function createDesktopRequestRouter({
  forwardToLocalCodex,
  ipc,
  isDeliveryFailureError,
  logPrefix,
  markDeliveryFailureError,
  normalizeTurnStartParams,
  pendingRoutesByRequestId,
  releaseDesktopThreadState,
  sendApplicationResponse,
}) {
  function desktopRouteForResponse(message) {
    if (!message || typeof message !== "object" || message.method) {
      return null;
    }

    const requestId = requestIdKey(message.id);
    return requestId ? pendingRoutesByRequestId.get(requestId) || null : null;
  }

  function submitDesktopActionResponse(route, responseMessage) {
    const payload = desktopFollowerPayloadForResponse(route, responseMessage);
    if (!payload) {
      sendApplicationResponse(JSON.stringify({
        id: responseMessage?.id ?? route.requestId,
        error: {
          code: -32602,
          message: "Invalid desktop action response.",
        },
      }));
      return;
    }

    ipc.sendRequest(payload.method, payload.params)
      .then(() => {
        pendingRoutesByRequestId.delete(route.requestId);
        sendApplicationResponse(JSON.stringify(
          projectedResolvedNotification(route.threadId, route.requestId)
        ));
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop action reply failed for ${route.threadId}: ${error.message}`);
        sendApplicationResponse(JSON.stringify({
          id: responseMessage.id,
          error: {
            code: -32000,
            message: "Could not send this action to Codex on the Mac.",
          },
        }));
      });
  }

  function submitDesktopFollowerRequest(route, originalMessage) {
    Promise.resolve()
      .then(() => resolveFollowerRequestParams(route))
      .then(async (params) => {
        if (route.method === "thread-follower-start-turn") {
          await syncDesktopOwnerRuntimeSettings(route.threadId, params.turnStartParams)
            .catch((error) => { throw markDeliveryFailureError(error); });
        }
        return ipc.sendRequest(route.method, params);
      })
      .then((result) => {
        sendApplicationResponse(JSON.stringify({
          id: originalMessage.id,
          result: appServerResultForFollowerRequest(route.method, result),
        }));
      })
      .catch((error) => {
        console.warn(`${logPrefix} desktop follower request failed: ${error.message}`);
        if (typeof forwardToLocalCodex === "function" && isDeliveryFailureError(error)) {
          const threadId = readString(route.threadId) || readString(route.params?.conversationId);
          if (threadId) {
            releaseDesktopThreadState(threadId);
          }
          forwardToLocalCodex(JSON.stringify(originalMessage));
          return;
        }
        sendApplicationResponse(JSON.stringify({
          id: originalMessage.id,
          error: {
            code: -32000,
            message: "Could not continue this Codex Desktop-owned thread from the phone.",
          },
        }));
      });
  }

  async function syncDesktopOwnerRuntimeSettings(threadId, turnStartParams) {
    const params = turnStartParams && typeof turnStartParams === "object" ? turnStartParams : {};
    const collaborationMode = params.collaborationMode && typeof params.collaborationMode === "object"
      ? cloneJSON(params.collaborationMode) : null;
    const collaborationSettings = collaborationMode?.settings;
    const model = readString(params.model) || readString(collaborationSettings?.model);
    const effort = readString(params.effort) || readString(params.reasoningEffort)
      || readString(collaborationSettings?.reasoning_effort) || readString(collaborationSettings?.reasoningEffort);
    const serviceTier = readString(params.serviceTier) || readString(params.service_tier) || null;
    if (!model && !effort && !collaborationMode) return;
    await ipc.sendRequest("thread-follower-update-thread-settings", {
      conversationId: threadId,
      threadSettings: {
        ...(model ? { model } : {}),
        effort: effort || null,
        serviceTier,
        ...(collaborationMode ? { collaborationMode } : {}),
      },
    });
  }

  async function resolveFollowerRequestParams(route) {
    if (route.method !== "thread-follower-start-turn") {
      return route.params;
    }

    const normalized = await Promise.resolve(
      normalizeTurnStartParams(cloneJSON(route.params.turnStartParams))
    );
    const turnStartParams = normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? normalized
      : route.params.turnStartParams;
    return {
      ...route.params,
      turnStartParams,
    };
  }

  return {
    desktopRouteForResponse,
    submitDesktopActionResponse,
    submitDesktopFollowerRequest,
  };
}

module.exports = {
  createDesktopRequestRouter,
};
