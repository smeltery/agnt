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
const { createTerminalHandler } = require("../handlers/terminal-handler");
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
  sanitizeLiveContextualUserItemForRelay,
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
  createRelayOutboundPipeline,
} = require("./relay-outbound-pipeline");
const {
  createRelaySocketLoop,
} = require("./relay-socket-loop");

// Close codes used by the relay to signal "this pairing is rejected; don't
// loop". Anything else triggers the bridge's normal reconnect schedule.
const RELAY_TERMINAL_CLOSE_CODES = new Set([4000, 4001]);
function shouldShutdownOnRelayCloseCode(code) {
  return RELAY_TERMINAL_CLOSE_CODES.has(code);
}
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
      navigationOnly: !config.codexEndpoint,
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
    providerId: activeProvider.id,
  });
  handshakeHandler.logCompatibilityWarning(cachedIOSAppCompatibilityWarning);
  const secureTransport = createBridgeSecureTransport({
    sessionId,
    relayUrl: relayBaseUrl,
    deviceState,
    displayName: os.hostname(),
    onTrustedPhoneUpdate(nextDeviceState) {
      deviceState = nextDeviceState;
      sendRelayRegistrationUpdate(nextDeviceState);
    },
  });
  // Keeps one stable sender identity across reconnects so buffered replay state
  // reflects what actually made it onto the current relay socket.
  function sendRelayWireMessage(wireMessage) {
    const live = socketLoop.getSocket();
    if (live?.readyState !== WebSocket.OPEN) {
      return false;
    }

    live.send(wireMessage);
    return true;
  }
  // Only the spawned local runtime needs rollout mirroring; a real endpoint
  // already provides the authoritative live stream for resumed threads.
  const rolloutLiveMirror = !config.codexEndpoint
    ? createRolloutLiveMirrorController({
      sendApplicationResponse,
      shouldSuppressThread: (threadId) => Boolean(desktopIpcActionFollower?.hasFreshLiveThreadState(threadId)),
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
    isWebTerminalEnabled: () => config.enableWebTerminal === true,
  });
  const terminalHandler = createTerminalHandler({
    isEnabled: () => config.enableWebTerminal === true,
    sendApplicationResponse: (raw) => sendApplicationResponse(raw),
    logPrefix: "[agnt]",
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
      console.error("[agnt] Make sure the Codex CLI is installed, authenticated, and launchable on this OS.");
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

  // Consolidates the non-relay teardown sequence so SIGINT / SIGTERM and the
  // codex.onClose handler all stop the same set of background work in the same
  // order. The relay-socket-loop's own onShutdown callback intentionally keeps
  // its inline teardown — its close-code-4000/4001 path is agnt-specific and
  // owned by that module.
  function prepareBridgeShutdown() {
    isShuttingDown = true;
    bridgeWakeAssertion.stop();
    clearReconnectTimer();
    clearRelayWatchdog();
    clearBridgeStatusHeartbeat();
    contextUsageWatcher.stop();
    rolloutLiveMirror?.stopAll();
    desktopIpcActionFollower?.stopAll();
    terminalHandler.shutdown();
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
      if (isShuttingDown || socketLoop.getSocket() !== trackedSocket) {
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

  // The relay socket lifecycle (connect → open → message → close → reconnect)
  // and its close-code policy live in relay-socket-loop. bridge.js still owns
  // the per-event side effects (status logging, watchdog, watcher teardown,
  // secure-transport binding, push registration) by passing callbacks.
  const socketLoop = createRelaySocketLoop({
    WebSocketCtor: WebSocket,
    relaySessionUrl: () => relaySessionUrl,
    buildHeaders: () => ({
      // The relay uses this per-session secret to authenticate the first push registration.
      "x-role": "mac",
      "x-notification-secret": notificationSecret,
      ...buildMacRegistrationHeaders(deviceState, pairingSession),
    }),
    isShuttingDown: () => isShuttingDown,
    reconnectScheduler,
    shouldShutdownOnClose: shouldShutdownOnRelayCloseCode,
    onShutdown: () => {
      shutdown(codex, () => socketLoop.getSocket(), () => {
        isShuttingDown = true;
        bridgeWakeAssertion.stop();
        clearReconnectTimer();
        clearRelayWatchdog();
        clearBridgeStatusHeartbeat();
      });
    },
    onStatus: logConnectionStatus,
    markActivity: markRelayActivity,
    startWatchdog: startRelayWatchdog,
    clearWatchdog: clearRelayWatchdog,
    onOpen: () => {
      secureTransport.bindLiveSendWireMessage(sendRelayWireMessage);
      sendRelayRegistrationUpdate(deviceState);
    },
    onTeardown: () => {
      contextUsageWatcher.stop();
      rolloutLiveMirror?.stopAll();
      desktopIpcActionFollower?.stopAll();
      desktopRefresher.handleTransportReset();
    },
    handleIncomingWireMessage: (message, ctx) => secureTransport.handleIncomingWireMessage(message, ctx),
    onApplicationMessage: (plaintextMessage) => {
      handleApplicationMessage(plaintextMessage);
    },
  });

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
  socketLoop.connect();

  codex.onMessage(createRelayOutboundPipeline({
    shortCircuit: (msg) => bridgeManagedCodex.handleResponse(msg),
    observers: [
      (msg) => accountHandler.updatePendingAuthLoginFromCodexMessage(msg),
      (msg) => handshakeHandler.observeCodexResponse(msg),
      (msg) => desktopRefresher.handleOutbound(msg),
      (msg) => pushNotificationTracker.handleOutbound(msg),
      (msg) => rememberThreadFromMessage("codex", msg),
    ],
    sanitize: sanitizeRelayBoundCodexMessage,
    forward: (payload) => secureTransport.queueOutboundApplicationMessage(payload, sendRelayWireMessage),
  }));

  codex.onClose(() => {
    logConnectionStatus("disconnected");
    publishBridgeStatus({
      state: "stopped",
      connectionStatus: "disconnected",
      pid: process.pid,
      lastError: "",
    });
    prepareBridgeShutdown();
    desktopRefresher.handleTransportReset();
    bridgeManagedCodex.failAll(new Error("Codex transport closed before the bridge request completed."));
    forwardedRequestTracker.clear();
    const live = socketLoop.getSocket();
    if (live?.readyState === WebSocket.OPEN || live?.readyState === WebSocket.CONNECTING) {
      live.close();
    }
  });

  process.on("SIGINT", () => shutdown(codex, () => socketLoop.getSocket(), prepareBridgeShutdown));
  process.on("SIGTERM", () => shutdown(codex, () => socketLoop.getSocket(), prepareBridgeShutdown));

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
      (msg) => terminalHandler.handleTerminalRequest(msg, sendApplicationResponse),
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
      // Spark's Responses API rejects reasoning.summary, so rewrite turn/start before forwarding.
      // Other providers handle their own model quirks in their translators.
      const forwarded = activeProvider.id === "codex"
        ? disableUnsupportedReasoningSummaryForTurnStart(msg)
        : msg;
      forwardedRequestTracker.rememberRequest(forwarded);
      rememberThreadFromMessage("phone", forwarded);
      codex.send(forwarded);
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
          sanitizeForRelay: (raw, method) => sanitizeThreadHistoryImagesForRelay(raw, method, {
            activeProviderId: activeProvider.id,
          }),
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

  // Seeds the desktop IPC follower without pulling huge turn history into baseline recovery.
  async function readDesktopConversationState(threadId) {
    const result = await bridgeManagedCodex.sendRequest("thread/read", {
      threadId,
      includeTurns: false,
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
    const live = socketLoop.getSocket();
    if (live?.readyState !== WebSocket.OPEN) {
      return;
    }

    live.send(JSON.stringify({
      kind: "relayMacRegistration",
      registration: buildMacRegistration(nextDeviceState, pairingSession),
    }));
  }

  // External teardown hook for hosts and tests that need to ask the bridge to
  // stop without nuking the process (the SIGINT/SIGTERM path uses `shutdown()`
  // which exits). Idempotent.
  function stopBridge() {
    if (isShuttingDown) {
      return;
    }

    prepareBridgeShutdown();
    desktopRefresher.handleTransportReset();
    bridgeManagedCodex.failAll(new Error("Bridge stopped before the request completed."));
    forwardedRequestTracker.clear();

    const live = socketLoop.getSocket();
    if (live?.readyState === WebSocket.OPEN || live?.readyState === WebSocket.CONNECTING) {
      live.close();
    }
    codex.shutdown();
  }

  return {
    stop: stopBridge,
  };
}


function readString(value) {
  return typeof value === "string" && value ? value : null;
}

const MODELS_WITHOUT_REASONING_SUMMARY = new Set([
  "gpt-5.3-codex-spark",
]);

// Forces app-server summary generation off for models whose Responses API calls
// reject reasoning.summary, while leaving the phone-facing runtime choice intact.
function disableUnsupportedReasoningSummaryForTurnStart(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return rawMessage;
  }
  if (!parsed || parsed.method !== "turn/start") {
    return rawMessage;
  }

  const params = parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
    ? parsed.params
    : null;
  if (!params || params.summary === "none") {
    return rawMessage;
  }

  const model = readTurnStartModel(params);
  if (!MODELS_WITHOUT_REASONING_SUMMARY.has(model)) {
    return rawMessage;
  }

  return JSON.stringify({
    ...parsed,
    params: {
      ...params,
      summary: "none",
    },
  });
}

function readTurnStartModel(params) {
  return readNonEmptyLowerString(params?.model)
    || readNonEmptyLowerString(params?.collaborationMode?.settings?.model)
    || readNonEmptyLowerString(params?.collaboration_mode?.settings?.model);
}

function readNonEmptyLowerString(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}


module.exports = {
  buildEmergencySingleTurnResponse,
  buildEmptyTurnsListResponse,
  buildHeartbeatBridgeStatus,
  buildLargestSafeTurnsListResponse,
  compactEmergencySingleTurnForRelay,
  createNoopDesktopRefresher,
  disableUnsupportedReasoningSummaryForTurnStart,
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
