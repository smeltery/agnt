// FILE: bridge.js
// Purpose: Runs Codex locally, bridges relay traffic, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ws, crypto, os, ./providers/codex/home, ./qr, ./bridge-config, ./providers/codex/transport, ./rollout-watch, ./voice-handler, ./ios-app-compatibility

const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const { readBridgeConfig } = require("./bridge-config");
const { resolveActiveProvider } = require("../providers/index");
const { withTranslator } = require("../providers/types");
const {
  createThreadRolloutActivityWatcher,
} = require("../desktop/rollout-watch");
const { printQR } = require("../transport/qr");
const { rememberActiveThread } = require("./session-state");
const { handleDesktopRequest } = require("../handlers/desktop-handler");
const { readDaemonConfig, writeDaemonConfig } = require("../daemon-state");
const { handleGitRequest } = require("../git/git-handler");
const { handleThreadContextRequest } = require("../handlers/thread-context-handler");
const { handleWorkspaceRequest } = require("../handlers/workspace-handler");
const { handleProjectRequest } = require("../handlers/project-handler");
const { handlePetRequest } = require("../handlers/pet-handler");
const { createNotificationsHandler } = require("../handlers/notifications-handler");
const { createVoiceHandler, resolveVoiceAuth } = require("../handlers/voice-handler");
const {
  composeSanitizedAuthStatusFromSettledResults,
} = require("../handlers/account-status");
const { createAccountHandler, createJsonRpcErrorResponse } = require("../handlers/account-handler");
const { createForwardedRequestTracker } = require("./forwarded-request-tracker");
const { createMacOSBridgeWakeAssertion } = require("../platform/wake-assertion");
const { createBridgePreferences, persistBridgePreferences } = require("./bridge-preferences");
const { createContextUsageWatcher } = require("./context-usage-watcher");
const { createHandshakeHandler } = require("./handshake-handler");
const { createBridgePackageVersionStatusReader } = require("./package-version-status");
const { createPushNotificationServiceClient } = require("../transport/push-notification-service-client");
const { createPushNotificationTracker } = require("../transport/push-notification-tracker");
const {
  RELAY_HISTORY_IMAGE_REFERENCE_URL,
  annotateImageGenerationHistoryItem,
  sanitizeInlineHistoryImageContentItem,
  sanitizeCompactionHistoryItem,
  sanitizeLiveGeneratedImageMessageForRelay,
} = require("./relay-image-sanitizer");
const {
  RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES,
  RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
  unwrapAppServerPayloadResult,
  compactHistoryItemForRelay,
  truncateRelayTextTail,
  parseAdaptiveThreadTurnsListRequest,
  fetchAdaptiveThreadTurnsListForRelay,
  maybeBuildJsonlThreadTurnsListFallback,
  buildEmptyTurnsListResponse,
  isEmptyTurnsListResponse,
  buildLargestSafeTurnsListResponse,
  buildEmergencySingleTurnResponse,
  compactEmergencySingleTurnForRelay,
} = require("./turns-list-pager");
const {
  trimThreadPayloadForRelay,
  trimTurnsListPayloadForRelay,
} = require("./relay-payload-trimmer");
const {
  normalizeRelayBoundJsonRpcMessage,
  isRelayBoundServerRequestMethod,
} = require("./jsonrpc-normalizer");
const {
  hasRelayConnectionGoneStale,
  buildHeartbeatBridgeStatus,
  createBridgeRelayHeartbeat,
} = require("./relay-heartbeat");
const {
  sanitizeThreadHistoryImagesForRelay,
  sanitizeThreadTurnsListForRelay,
  sanitizeRelayHistoryTurns,
  sanitizeRelayHistoryTurn,
} = require("./relay-payload-pipeline");
const {
  extractBridgeMessageContext,
  shouldStartContextUsageWatcher,
} = require("./message-context");
const {
  buildMacRegistration,
  buildMacRegistrationHeaders,
} = require("./mac-registration");
const {
  createNoopDesktopRefresher,
  shutdown,
} = require("./lifecycle");
const {
  createBridgeManagedCodexClient,
} = require("./bridge-managed-codex-client");
const {
  createRelayReconnectScheduler,
} = require("./relay-reconnect-scheduler");
const {
  createApplicationMessageRouter,
} = require("./application-message-router");
const {
  loadOrCreateBridgeDeviceState,
  resolveBridgeRelaySession,
} = require("../transport/secure-device-state");
const { createBridgeSecureTransport } = require("../transport/secure-transport");
const { createRolloutLiveMirrorController } = require("../desktop/rollout-live-mirror");
const {
  createDesktopIpcActionFollower,
  seedConversationStateFromThreadRead,
} = require("../desktop/desktop-ipc-action-follower");
const { version: bridgePackageVersion = "" } = require("../../package.json");
const { buildCachedIOSAppCompatibilityWarning } = require("./ios-app-compatibility");
const { createShortPairingCode, SHORT_PAIRING_CODE_LENGTH } = require("../transport/qr");

function startBridge({
  config: explicitConfig = null,
  printPairingQr = true,
  onPairingSession = null,
  onBridgeStatus = null,
  providerId = "",
} = {}) {
  const config = explicitConfig || readBridgeConfig();
  const { provider: activeProvider, source: providerSource } = resolveActiveProvider({
    id: providerId,
    env: process.env,
    persistedId: config.providerId || "",
  });
  if (!activeProvider) {
    console.error("[agnt] No providers registered.");
    process.exit(1);
  }
  console.log(`[agnt] Provider: ${activeProvider.displayName} (${activeProvider.id}, ${providerSource})`);
  if (providerSource === "explicit") {
    try {
      writeDaemonConfig({
        ...(readDaemonConfig() || {}),
        providerId: activeProvider.id,
      });
    } catch (error) {
      console.warn(`[agnt] Failed to persist provider preference: ${(error && error.message) || error}`);
    }
  }
  config.keepMacAwakeEnabled = config.keepMacAwakeEnabled === true;
  const bridgeWakeAssertion = createMacOSBridgeWakeAssertion({
    enabled: config.keepMacAwakeEnabled,
  });
  const bridgePreferences = createBridgePreferences({ config, bridgeWakeAssertion });
  // Static desktop-bundle metadata for the active provider (Codex.app today,
  // null for Claude / opencode / Cursor). Provider-agnostic handlers consume
  // this instead of reaching into Codex-named config fields.
  const desktopBundle = typeof activeProvider.desktopBundle === "function"
    ? activeProvider.desktopBundle({ env: process.env }) || { id: "", appPath: "" }
    : { id: "", appPath: "" };
  const relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
  if (!relayBaseUrl) {
    console.error("[agnt] No relay URL configured.");
    console.error("[agnt] In a source checkout, run ./scripts/run-local-agnt.sh or set AGNT_RELAY.");
    process.exit(1);
  }

  let deviceState;
  try {
    deviceState = loadOrCreateBridgeDeviceState();
  } catch (error) {
    console.error(`[agnt] ${(error && error.message) || "Failed to load the saved bridge pairing state."}`);
    process.exit(1);
  }
  const relaySession = resolveBridgeRelaySession(deviceState);
  deviceState = relaySession.deviceState;
  const cachedIOSAppCompatibilityWarning = buildCachedIOSAppCompatibilityWarning({
    bridgeVersion: bridgePackageVersion,
    iosAppVersion: deviceState.lastSeenPhoneAppVersion,
  });
  const sessionId = relaySession.sessionId;
  const relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
  const notificationSecret = randomBytes(24).toString("hex");
  const desktopRefresher = activeProvider.capabilities?.desktopRefresher && typeof activeProvider.createDesktopRefresher === "function"
    ? activeProvider.createDesktopRefresher({
      enabled: config.refreshEnabled,
      debounceMs: config.refreshDebounceMs,
      refreshCommand: config.refreshCommand,
      bundleId: desktopBundle.id,
      appPath: desktopBundle.appPath,
    })
    : createNoopDesktopRefresher();
  const pushServiceClient = createPushNotificationServiceClient({
    baseUrl: config.pushServiceUrl,
    sessionId,
    notificationSecret,
  });
  const notificationsHandler = createNotificationsHandler({
    pushServiceClient,
  });
  const pushNotificationTracker = createPushNotificationTracker({
    sessionId,
    pushServiceClient,
    previewMaxChars: config.pushPreviewMaxChars,
  });
  const readBridgePackageVersionStatus = createBridgePackageVersionStatusReader();

  // Keep the local Codex runtime alive across transient relay disconnects.
  let socket = null;
  let isShuttingDown = false;
  const heartbeat = createBridgeRelayHeartbeat();
  const reconnectScheduler = createRelayReconnectScheduler();
  let lastPublishedBridgeStatus = null;
  let lastConnectionStatus = null;
  let codexLaunchState = config.codexEndpoint ? "connected" : "starting";
  const bridgeManagedCodex = createBridgeManagedCodexClient({
    send: (payload) => codex.send(payload),
  });
  const forwardedRequestTracker = createForwardedRequestTracker({
    parseJson: safeParseJSON,
  });
  const handshakeHandler = createHandshakeHandler({
    sendApplicationResponse,
    bridgePackageVersion,
    initialHandshakeWarm: Boolean(config.codexEndpoint),
    getDeviceState: () => deviceState,
    setDeviceState: (next) => { deviceState = next; },
  });
  handshakeHandler.logCompatibilityWarning(cachedIOSAppCompatibilityWarning);
  const secureTransport = createBridgeSecureTransport({
    sessionId,
    relayUrl: relayBaseUrl,
    deviceState,
    onTrustedPhoneUpdate(nextDeviceState) {
      deviceState = nextDeviceState;
      sendRelayRegistrationUpdate(nextDeviceState);
    },
  });
  // Keeps one stable sender identity across reconnects so buffered replay state
  // reflects what actually made it onto the current relay socket.
  function sendRelayWireMessage(wireMessage) {
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(wireMessage);
    return true;
  }
  // Only the spawned local runtime needs rollout mirroring; a real endpoint
  // already provides the authoritative live stream for resumed threads.
  const rolloutLiveMirror = !config.codexEndpoint
    ? createRolloutLiveMirrorController({
      sendApplicationResponse,
    })
    : null;
  const desktopIpcActionFollower = !config.codexEndpoint
    ? createDesktopIpcActionFollower({
      sendApplicationResponse,
      readConversationState: readDesktopConversationState,
      socketPath: config.desktopIpcSocketPath || undefined,
    })
    : null;
  const contextUsageWatcher = createContextUsageWatcher({
    sendApplicationResponse,
  });

  const codex = withTranslator(
    activeProvider.createTransport({
      endpoint: config.codexEndpoint,
      env: process.env,
      appPath: desktopBundle.appPath,
      logPrefix: "[agnt]",
    }),
    activeProvider,
  );
  const voiceHandler = createVoiceHandler({
    sendCodexRequest: bridgeManagedCodex.sendRequest,
    logPrefix: "[agnt]",
  });
  const accountHandler = createAccountHandler({
    activeProvider,
    sendCodexRequest: bridgeManagedCodex.sendRequest,
    readBridgePackageVersionStatus,
    codexMode: codex.mode,
    tracker: forwardedRequestTracker,
    composeSanitizedAuthStatusFromSettledResults,
    resolveVoiceAuth,
  });
  startBridgeStatusHeartbeat();
  publishBridgeStatus({
    state: "starting",
    connectionStatus: "starting",
    pid: process.pid,
    lastError: "",
  });

  codex.onError((error) => {
    codexLaunchState = "error";
    publishBridgeStatus({
      state: "error",
      connectionStatus: "error",
      pid: process.pid,
      lastError: error.message,
    });
    if (config.codexEndpoint) {
      console.error(`[agnt] Failed to connect to Codex endpoint: ${config.codexEndpoint}`);
    } else {
      console.error("[agnt] Failed to start `codex app-server`.");
      console.error(`[agnt] Launch command: ${codex.describe()}`);
      console.error("[agnt] Make sure the Codex CLI is installed and that the launcher works on this OS.");
    }
    console.error(error.message);
    process.exit(1);
  });
  // Marks the local Codex runtime as launchable before relay/network recovery updates.
  codex.onStarted(() => {
    codexLaunchState = "connected";
    if (!lastPublishedBridgeStatus) {
      return;
    }

    publishBridgeStatus(lastPublishedBridgeStatus);
  });

  function clearReconnectTimer() {
    reconnectScheduler.clear();
  }

  // Periodically rewrites the latest bridge snapshot so CLI status does not stay frozen.
  function startBridgeStatusHeartbeat() {
    heartbeat.startStatusHeartbeat(({ wrapStatus }) => {
      if (!lastPublishedBridgeStatus || isShuttingDown) {
        return;
      }
      onBridgeStatus?.(wrapStatus(lastPublishedBridgeStatus));
    });
  }

  function clearBridgeStatusHeartbeat() {
    heartbeat.clearStatusHeartbeat();
  }

  // Tracks relay liveness locally so sleep/wake zombie sockets can be force-reconnected.
  function markRelayActivity() {
    heartbeat.markActivity();
  }

  function clearRelayWatchdog() {
    heartbeat.clearWatchdog();
  }

  function startRelayWatchdog(trackedSocket) {
    heartbeat.startWatchdog(({ isStale }) => {
      if (isShuttingDown || socket !== trackedSocket) {
        heartbeat.clearWatchdog();
        return;
      }

      if (trackedSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (isStale) {
        console.warn("[agnt] relay heartbeat stalled; forcing reconnect");
        logConnectionStatus("disconnected");
        trackedSocket.terminate();
        return;
      }

      try {
        trackedSocket.ping();
      } catch {
        trackedSocket.terminate();
      }
    });
  }

  // Keeps npm start output compact by emitting only high-signal connection states.
  function logConnectionStatus(status) {
    if (lastConnectionStatus === status) {
      return;
    }

    lastConnectionStatus = status;
    publishBridgeStatus({
      state: "running",
      connectionStatus: status,
      pid: process.pid,
      lastError: "",
    });
    console.log(`[agnt] ${status}`);
  }

  // Retries the relay socket while preserving the active Codex process and session id.
  function scheduleRelayReconnect(closeCode) {
    if (isShuttingDown) {
      return;
    }

    if (closeCode === 4000 || closeCode === 4001) {
      logConnectionStatus("disconnected");
      shutdown(codex, () => socket, () => {
        isShuttingDown = true;
        bridgeWakeAssertion.stop();
        clearReconnectTimer();
        clearRelayWatchdog();
        clearBridgeStatusHeartbeat();
      });
      return;
    }

    if (reconnectScheduler.isPending()) {
      return;
    }

    logConnectionStatus("connecting");
    reconnectScheduler.schedule(() => {
      connectRelay();
    });
  }

  function connectRelay() {
    if (isShuttingDown) {
      return;
    }

    logConnectionStatus("connecting");
    const nextSocket = new WebSocket(relaySessionUrl, {
      // The relay uses this per-session secret to authenticate the first push registration.
      headers: {
        "x-role": "mac",
        "x-notification-secret": notificationSecret,
        ...buildMacRegistrationHeaders(deviceState, pairingSession),
      },
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      markRelayActivity();
      clearReconnectTimer();
      reconnectScheduler.resetAttempt();
      startRelayWatchdog(nextSocket);
      logConnectionStatus("connected");
      secureTransport.bindLiveSendWireMessage(sendRelayWireMessage);
      sendRelayRegistrationUpdate(deviceState);
    });

    nextSocket.on("message", (data) => {
      markRelayActivity();
      const message = typeof data === "string" ? data : data.toString("utf8");
      if (secureTransport.handleIncomingWireMessage(message, {
        sendControlMessage(controlMessage) {
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.send(JSON.stringify(controlMessage));
          }
        },
        onApplicationMessage(plaintextMessage) {
          handleApplicationMessage(plaintextMessage);
        },
      })) {
        return;
      }
    });

    nextSocket.on("ping", () => {
      markRelayActivity();
    });

    nextSocket.on("pong", () => {
      markRelayActivity();
    });

    nextSocket.on("close", (code) => {
      if (socket === nextSocket) {
        clearRelayWatchdog();
      }
      logConnectionStatus("disconnected");
      if (socket === nextSocket) {
        socket = null;
      }
      contextUsageWatcher.stop();
      rolloutLiveMirror?.stopAll();
      desktopIpcActionFollower?.stopAll();
      desktopRefresher.handleTransportReset();
      scheduleRelayReconnect(code);
    });

    nextSocket.on("error", () => {
      if (socket === nextSocket) {
        clearRelayWatchdog();
      }
      logConnectionStatus("disconnected");
    });
  }

  const pairingPayload = secureTransport.createPairingPayload();
  const pairingSession = {
    pairingPayload,
    pairingCode: createShortPairingCode({ length: SHORT_PAIRING_CODE_LENGTH }),
  };
  onPairingSession?.(pairingSession);
  if (printPairingQr) {
    printQR(pairingSession);
  }
  pushServiceClient.logUnavailable();
  connectRelay();

  codex.onMessage((message) => {
    if (bridgeManagedCodex.handleResponse(message)) {
      return;
    }
    accountHandler.updatePendingAuthLoginFromCodexMessage(message);
    handshakeHandler.observeCodexResponse(message);
    desktopRefresher.handleOutbound(message);
    pushNotificationTracker.handleOutbound(message);
    rememberThreadFromMessage("codex", message);
    secureTransport.queueOutboundApplicationMessage(
      sanitizeRelayBoundCodexMessage(message),
      sendRelayWireMessage
    );
  });

  codex.onClose(() => {
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
    logConnectionStatus("disconnected");
    publishBridgeStatus({
      state: "stopped",
      connectionStatus: "disconnected",
      pid: process.pid,
      lastError: "",
    });
    isShuttingDown = true;
    bridgeWakeAssertion.stop();
    clearReconnectTimer();
    contextUsageWatcher.stop();
    rolloutLiveMirror?.stopAll();
    desktopIpcActionFollower?.stopAll();
    desktopRefresher.handleTransportReset();
    bridgeManagedCodex.failAll(new Error("Codex transport closed before the bridge request completed."));
    forwardedRequestTracker.clear();
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  });

  process.on("SIGINT", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    bridgeWakeAssertion.stop();
    clearReconnectTimer();
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
  }));
  process.on("SIGTERM", () => shutdown(codex, () => socket, () => {
    isShuttingDown = true;
    bridgeWakeAssertion.stop();
    clearReconnectTimer();
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
  }));

  // Routes decrypted app payloads through the same bridge handlers as before.
  // Stages run top-to-bottom; the first one that returns truthy claims the
  // message. Observation-only stages (desktopRefresher, rolloutLiveMirror)
  // do their work and return false so the walk continues.
  const handleApplicationMessage = createApplicationMessageRouter({
    stages: [
      (msg) => handshakeHandler.handlePhoneMessage(msg),
      (msg) => accountHandler.handleBridgeManagedAccountRequest(msg, sendApplicationResponse),
      (msg) => accountHandler.handleNonCodexVoiceRequest(msg, sendApplicationResponse),
      (msg) => voiceHandler.handleVoiceRequest(msg, sendApplicationResponse),
      (msg) => handleThreadContextRequest(msg, sendApplicationResponse),
      (msg) => handleWorkspaceRequest(msg, sendApplicationResponse, {
        // Forward whatever the active provider considers its generated-image root.
        // Codex returns `~/.codex/generated_images`; other providers return null
        // (or omit the hook entirely), which drops that allowlist branch.
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
      }),
      (msg) => handleGitRequest(msg, sendApplicationResponse, {
        codexAppPath: desktopBundle.appPath,
        onThreadNameSet: sendThreadNameUpdatedNotification,
        // Only the Codex CLI exposes the structured-JSON title-drafting flow.
        // Other providers handle thread/generateTitle in their own translator.
        codexTitleGeneration: activeProvider.id === "codex",
      }),
      // Observation-only — never claim the message.
      (msg) => { desktopRefresher.handleInbound(msg); return false; },
      (msg) => { rolloutLiveMirror?.observeInbound(msg); return false; },
      (msg) => desktopIpcActionFollower?.observeInbound(msg),
      (msg) => handleBridgeManagedThreadTurnsListRequest(msg),
    ],
    fallback: (msg) => {
      forwardedRequestTracker.rememberRequest(msg);
      rememberThreadFromMessage("phone", msg);
      codex.send(msg);
    },
  });

  function handleBridgeManagedThreadTurnsListRequest(rawMessage) {
    const request = parseAdaptiveThreadTurnsListRequest(rawMessage);
    if (!request) {
      return false;
    }

    rememberThreadFromMessage("phone", rawMessage);
    (async () => {
      try {
        const response = await fetchAdaptiveThreadTurnsListForRelay(request, {
          fetchPage: (params) => bridgeManagedCodex.sendRequest("thread/turns/list", params),
          sanitizeForRelay: sanitizeThreadHistoryImagesForRelay,
        });
        const fallbackResponse = maybeBuildJsonlThreadTurnsListFallback(activeProvider, request, response);
        forwardedRequestTracker.markSanitizedResponse(request.id, "thread/turns/list");
        sendApplicationResponse(JSON.stringify(fallbackResponse ?? response));
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

  // Encrypts bridge-generated responses instead of letting the relay see plaintext.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(
      sanitizeRelayBoundCodexMessage(rawMessage),
      sendRelayWireMessage
    );
  }

  // Mirrors accepted local renames back to the phone using the existing push-event shape.
  function sendThreadNameUpdatedNotification(result) {
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
  }

  // Seeds the desktop IPC follower when it receives patches before a full snapshot.
  async function readDesktopConversationState(threadId) {
    const result = await bridgeManagedCodex.sendRequest("thread/read", {
      threadId,
      includeTurns: true,
    });
    return seedConversationStateFromThreadRead(result);
  }

  // Replaces huge inline desktop-history images with lightweight references
  // before relay encryption. Delegates the request-id ↔ method bookkeeping to
  // the forwarded-request tracker so the bridge's relay loop doesn't have to
  // manage TTL'd Maps directly.
  function sanitizeRelayBoundCodexMessage(rawMessage) {
    forwardedRequestTracker.pruneExpired();
    const normalizedMessage = normalizeRelayBoundJsonRpcMessage(rawMessage, {
      pendingRequestMethodsById: forwardedRequestTracker.getSanitizedResponseMap(),
    });
    if (!normalizedMessage) {
      return null;
    }
    const parsed = safeParseJSON(normalizedMessage);
    const responseId = parsed?.id;
    if (responseId == null) {
      return sanitizeLiveGeneratedImageMessageForRelay(normalizedMessage);
    }
    const trackedRequest = forwardedRequestTracker.consumeSanitizedResponse(responseId);
    if (!trackedRequest) {
      return normalizedMessage;
    }
    return sanitizeThreadHistoryImagesForRelay(normalizedMessage, trackedRequest.method);
  }

  function safeParseJSON(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (!context.threadId) {
      return;
    }

    rememberActiveThread(context.threadId, source);
    if (shouldStartContextUsageWatcher(context)) {
      contextUsageWatcher.ensure(context);
    }
  }


  function publishBridgeStatus(status) {
    const nextStatus = {
      ...status,
      codexLaunchState,
    };
    lastPublishedBridgeStatus = nextStatus;
    onBridgeStatus?.(nextStatus);
  }

  // Refreshes the relay's trusted-mac index after the QR bootstrap locks in a phone identity.
  function sendRelayRegistrationUpdate(nextDeviceState) {
    deviceState = nextDeviceState;
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      kind: "relayMacRegistration",
      registration: buildMacRegistration(nextDeviceState, pairingSession),
    }));
  }

}


function readString(value) {
  return typeof value === "string" && value ? value : null;
}


module.exports = {
  buildEmergencySingleTurnResponse,
  buildEmptyTurnsListResponse,
  buildHeartbeatBridgeStatus,
  buildLargestSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  createNoopDesktopRefresher,
  fetchAdaptiveThreadTurnsListForRelay,
  hasRelayConnectionGoneStale,
  isEmptyTurnsListResponse,
  isRelayBoundServerRequestMethod,
  maybeBuildJsonlThreadTurnsListFallback,
  normalizeRelayBoundJsonRpcMessage,
  persistBridgePreferences,
  sanitizeLiveGeneratedImageMessageForRelay,
  sanitizeThreadHistoryImagesForRelay,
  startBridge,
  unwrapAppServerPayloadResult,
};
