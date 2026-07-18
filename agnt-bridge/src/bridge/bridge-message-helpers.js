const { rememberActiveThread } = require("./session-state");
const {
  extractBridgeMessageContext,
  shouldStartContextUsageWatcher,
} = require("./message-context");
const { normalizeRelayBoundJsonRpcMessage } = require("./jsonrpc-normalizer");
const {
  sanitizeLiveContextualUserItemForRelay,
} = require("./relay-payload-pipeline");
const {
  sanitizeLiveGeneratedImageMessageForRelay,
} = require("./relay-image-sanitizer");

function createThreadMemoryObserver({ contextUsageWatcher }) {
  return function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (!context.threadId) {
      return;
    }

    rememberActiveThread(context.threadId, source);
    if (shouldStartContextUsageWatcher(context)) {
      contextUsageWatcher.ensure(context);
    }
  };
}

function createThreadNameNotifier({ sendApplicationResponse }) {
  return function sendThreadNameUpdatedNotification(result) {
    const threadId = readString(result?.threadId || result?.thread_id);
    const name = readString(result?.name || result?.title);
    if (!threadId || !name) {
      return;
    }

    sendApplicationResponse(JSON.stringify({
      method: "thread/name/updated",
      params: {
        threadId,
        thread_id: threadId,
        name,
        title: name,
      },
    }));
  };
}

function createRelayResponseSanitizer({
  activeProvider,
  forwardedRequestTracker,
  parseJson,
  sanitizeThreadHistoryImagesForRelay,
}) {
  return function sanitizeRelayBoundCodexMessage(rawMessage) {
    forwardedRequestTracker.pruneExpired();
    const normalizedMessage = normalizeRelayBoundJsonRpcMessage(rawMessage, {
      pendingRequestMethodsById: forwardedRequestTracker.getSanitizedResponseMap(),
    });
    if (!normalizedMessage) {
      return null;
    }
    const parsed = parseJson(normalizedMessage);
    const responseId = parsed?.id;
    if (responseId == null) {
      const liveContextSanitized = sanitizeLiveContextualUserItemForRelay(normalizedMessage);
      if (liveContextSanitized == null) {
        return null;
      }
      return sanitizeLiveGeneratedImageMessageForRelay(liveContextSanitized);
    }
    const trackedRequest = forwardedRequestTracker.consumeSanitizedResponse(responseId);
    if (!trackedRequest) {
      return normalizedMessage;
    }
    return sanitizeThreadHistoryImagesForRelay(normalizedMessage, trackedRequest.method, {
      activeProviderId: activeProvider.id,
    });
  };
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = {
  createRelayResponseSanitizer,
  createThreadMemoryObserver,
  createThreadNameNotifier,
};
