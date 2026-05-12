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

const RELAY_WATCHDOG_PING_INTERVAL_MS = 10_000;
// Keep the watchdog above the relay heartbeat cadence so quiet healthy sockets survive idle gaps.
const RELAY_WATCHDOG_STALE_AFTER_MS = 70_000;
const BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_RELAY_STATUS_MESSAGE = "Relay heartbeat stalled; reconnect pending.";
const RELAY_HISTORY_RECENT_TURN_TARGET = 40;

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
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let relayWatchdogTimer = null;
  let statusHeartbeatTimer = null;
  let lastRelayActivityAt = 0;
  let lastPublishedBridgeStatus = null;
  let lastConnectionStatus = null;
  let codexLaunchState = config.codexEndpoint ? "connected" : "starting";
  const bridgeManagedCodexRequestWaiters = new Map();
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
    sendCodexRequest,
    logPrefix: "[agnt]",
  });
  const accountHandler = createAccountHandler({
    activeProvider,
    sendCodexRequest,
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
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Periodically rewrites the latest bridge snapshot so CLI status does not stay frozen.
  function startBridgeStatusHeartbeat() {
    if (statusHeartbeatTimer) {
      return;
    }

    statusHeartbeatTimer = setInterval(() => {
      if (!lastPublishedBridgeStatus || isShuttingDown) {
        return;
      }

      onBridgeStatus?.(buildHeartbeatBridgeStatus(lastPublishedBridgeStatus, lastRelayActivityAt));
    }, BRIDGE_STATUS_HEARTBEAT_INTERVAL_MS);
    statusHeartbeatTimer.unref?.();
  }

  function clearBridgeStatusHeartbeat() {
    if (!statusHeartbeatTimer) {
      return;
    }

    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  // Tracks relay liveness locally so sleep/wake zombie sockets can be force-reconnected.
  function markRelayActivity() {
    lastRelayActivityAt = Date.now();
  }

  function clearRelayWatchdog() {
    if (!relayWatchdogTimer) {
      return;
    }

    clearInterval(relayWatchdogTimer);
    relayWatchdogTimer = null;
  }

  function startRelayWatchdog(trackedSocket) {
    clearRelayWatchdog();
    markRelayActivity();

    relayWatchdogTimer = setInterval(() => {
      if (isShuttingDown || socket !== trackedSocket) {
        clearRelayWatchdog();
        return;
      }

      if (trackedSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (hasRelayConnectionGoneStale(lastRelayActivityAt)) {
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
    }, RELAY_WATCHDOG_PING_INTERVAL_MS);
    relayWatchdogTimer.unref?.();
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

    if (reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = Math.min(1_000 * reconnectAttempt, 5_000);
    logConnectionStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay();
    }, delayMs);
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
      reconnectAttempt = 0;
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
    if (handleBridgeManagedCodexResponse(message)) {
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
    failBridgeManagedCodexRequests(new Error("Codex transport closed before the bridge request completed."));
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
  function handleApplicationMessage(rawMessage) {
    if (handshakeHandler.handlePhoneMessage(rawMessage)) {
      return;
    }
    if (accountHandler.handleBridgeManagedAccountRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (accountHandler.handleNonCodexVoiceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (voiceHandler.handleVoiceRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleThreadContextRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendApplicationResponse, {
      // Forward whatever the active provider considers its generated-image root.
      // Codex returns `~/.codex/generated_images`; other providers return null
      // (or omit the hook entirely), which drops that allowlist branch.
      generatedImagesDir: typeof activeProvider.generatedImagesDir === "function"
        ? () => activeProvider.generatedImagesDir() || null
        : () => null,
    })) {
      return;
    }
    if (handleProjectRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handlePetRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (notificationsHandler.handleNotificationsRequest(rawMessage, sendApplicationResponse)) {
      return;
    }
    if (handleDesktopRequest(rawMessage, sendApplicationResponse, {
      bundleId: desktopBundle.id,
      appPath: desktopBundle.appPath,
      readBridgePreferences: bridgePreferences.read,
      updateBridgePreferences: bridgePreferences.update,
    })) {
      return;
    }
    if (handleGitRequest(rawMessage, sendApplicationResponse, {
      codexAppPath: desktopBundle.appPath,
      onThreadNameSet: sendThreadNameUpdatedNotification,
      // Only the Codex CLI exposes the structured-JSON title-drafting flow.
      // Other providers handle thread/generateTitle in their own translator.
      codexTitleGeneration: activeProvider.id === "codex",
    })) {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rolloutLiveMirror?.observeInbound(rawMessage);
    if (desktopIpcActionFollower?.observeInbound(rawMessage)) {
      return;
    }
    if (handleBridgeManagedThreadTurnsListRequest(rawMessage)) {
      return;
    }
    forwardedRequestTracker.rememberRequest(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
    codex.send(rawMessage);
  }

  function handleBridgeManagedThreadTurnsListRequest(rawMessage) {
    const request = parseAdaptiveThreadTurnsListRequest(rawMessage);
    if (!request) {
      return false;
    }

    rememberThreadFromMessage("phone", rawMessage);
    (async () => {
      try {
        const response = await fetchAdaptiveThreadTurnsListForRelay(request, {
          fetchPage: (params) => sendCodexRequest("thread/turns/list", params),
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
    const result = await sendCodexRequest("thread/read", {
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

  // Runs bridge-private JSON-RPC calls against the local app-server so token-bearing responses
  // can power bridge features like transcription without ever reaching the phone.
  function sendCodexRequest(method, params) {
    const requestId = `bridge-managed-${randomBytes(12).toString("hex")}`;
    const payload = JSON.stringify({
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bridgeManagedCodexRequestWaiters.delete(requestId);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 20_000);

      bridgeManagedCodexRequestWaiters.set(requestId, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        codex.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        bridgeManagedCodexRequestWaiters.delete(requestId);
        reject(error);
      }
    });
  }

  // Intercepts responses for bridge-private requests so only user-visible app-server traffic
  // is forwarded back through secure transport.
  function handleBridgeManagedCodexResponse(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const responseId = typeof parsed?.id === "string" ? parsed.id : null;
    if (!responseId) {
      return false;
    }

    const waiter = bridgeManagedCodexRequestWaiters.get(responseId);
    if (!waiter) {
      return false;
    }

    bridgeManagedCodexRequestWaiters.delete(responseId);
    clearTimeout(waiter.timeout);

    if (parsed.error) {
      const error = new Error(parsed.error.message || `Codex request failed: ${waiter.method}`);
      error.code = parsed.error.code;
      error.data = parsed.error.data;
      waiter.reject(error);
      return true;
    }

    waiter.resolve(readBridgeManagedSuccessPayload(parsed));
    return true;
  }

  // Normalizes private app-server responses before the bridge re-wraps them for iOS.
  // Codex's app-server occasionally hands back `{payload}` instead of `{result}`;
  // non-Codex providers always return `{result}`, so this is a no-op for them.
  function readBridgeManagedSuccessPayload(parsed) {
    if (Object.prototype.hasOwnProperty.call(parsed, "result")) {
      return parsed.result ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "payload")) {
      return parsed.payload ?? null;
    }
    return null;
  }

  function failBridgeManagedCodexRequests(error) {
    for (const waiter of bridgeManagedCodexRequestWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    bridgeManagedCodexRequestWaiters.clear();
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

// Registers the canonical Mac identity and the one trusted iPhone allowed for auto-resolve.
function buildMacRegistrationHeaders(deviceState, pairingSession) {
  const registration = buildMacRegistration(deviceState, pairingSession);
  const headers = {
    "x-mac-device-id": registration.macDeviceId,
    "x-mac-identity-public-key": registration.macIdentityPublicKey,
    "x-machine-name": registration.displayName,
    "x-pairing-code": registration.pairingCode,
    "x-pairing-version": registration.pairingVersion ? String(registration.pairingVersion) : "",
    "x-pairing-expires-at": registration.pairingExpiresAt ? String(registration.pairingExpiresAt) : "",
  };
  if (registration.trustedPhoneDeviceId && registration.trustedPhonePublicKey) {
    headers["x-trusted-phone-device-id"] = registration.trustedPhoneDeviceId;
    headers["x-trusted-phone-public-key"] = registration.trustedPhonePublicKey;
  }
  return headers;
}

function buildMacRegistration(deviceState, pairingSession) {
  const trustedPhoneEntry = Object.entries(deviceState?.trustedPhones || {})[0] || null;
  return {
    macDeviceId: normalizeNonEmptyString(deviceState?.macDeviceId),
    macIdentityPublicKey: normalizeNonEmptyString(deviceState?.macIdentityPublicKey),
    displayName: normalizeNonEmptyString(os.hostname()),
    trustedPhoneDeviceId: normalizeNonEmptyString(trustedPhoneEntry?.[0]),
    trustedPhonePublicKey: normalizeNonEmptyString(trustedPhoneEntry?.[1]),
    pairingCode: normalizeNonEmptyString(pairingSession?.pairingCode),
    pairingVersion: Number.isInteger(pairingSession?.pairingPayload?.v) ? pairingSession.pairingPayload.v : 0,
    pairingExpiresAt: Number.isFinite(pairingSession?.pairingPayload?.expiresAt)
      ? pairingSession.pairingPayload.expiresAt
      : 0,
  };
}

function shutdown(codex, getSocket, beforeExit = () => {}) {
  beforeExit();

  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close();
  }

  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function shouldStartContextUsageWatcher(context) {
  if (!context?.threadId) {
    return false;
  }

  return context.method === "turn/start"
    || context.method === "turn/started";
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
      || readString(params?.turn?.turnId)
      || readString(params?.turn?.turn_id)
    );
  }

  return null;
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Shrinks thread history snapshots/pages for mobile relay delivery.
// This elides bulky blobs and replaces oversized older history with a compact marker.
function sanitizeThreadHistoryImagesForRelay(rawMessage, requestMethod) {
  if (requestMethod === "thread/turns/list") {
    return sanitizeThreadTurnsListForRelay(rawMessage);
  }

  if (requestMethod !== "thread/read" && requestMethod !== "thread/resume") {
    return rawMessage;
  }

  const parsed = parseBridgeJSON(rawMessage);
  const thread = parsed?.result?.thread;
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    return rawMessage;
  }

  const threadId = normalizeNonEmptyString(thread.id)
    || normalizeNonEmptyString(thread.threadId)
    || normalizeNonEmptyString(thread.thread_id);
  const { turns: sanitizedTurns, didSanitize } = sanitizeRelayHistoryTurns(thread.turns, threadId);

  if (!didSanitize) {
    const trimmedPayload = trimThreadPayloadForRelay(parsed, thread);
    return trimmedPayload == null ? rawMessage : trimmedPayload;
  }

  const sanitizedPayload = JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      thread: {
        ...thread,
        turns: sanitizedTurns,
      },
    },
  });

  return trimThreadPayloadForRelay(parseBridgeJSON(sanitizedPayload), null) ?? sanitizedPayload;
}

function sanitizeThreadTurnsListForRelay(rawMessage) {
  const parsed = parseBridgeJSON(rawMessage);
  const result = parsed?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return rawMessage;
  }

  const turnsKey = ["data", "items", "turns"].find((key) => Array.isArray(result[key]));
  if (!turnsKey) {
    return rawMessage;
  }

  const threadId = normalizeNonEmptyString(result.threadId)
    || normalizeNonEmptyString(result.thread_id)
    || normalizeNonEmptyString(result.thread?.id)
    || normalizeNonEmptyString(result.thread?.threadId)
    || normalizeNonEmptyString(result.thread?.thread_id);
  const { turns: sanitizedTurns, didSanitize } = sanitizeRelayHistoryTurns(result[turnsKey], threadId);
  const sanitizedParsed = didSanitize
    ? {
      ...parsed,
      result: {
        ...result,
        [turnsKey]: sanitizedTurns,
      },
    }
    : parsed;

  return trimTurnsListPayloadForRelay(sanitizedParsed, turnsKey, didSanitize ? null : rawMessage);
}

function sanitizeRelayHistoryTurns(turns, threadId = "") {
  let didSanitize = false;
  const sanitizedTurns = turns.map((turn) => {
    const sanitizedTurn = sanitizeRelayHistoryTurn(turn, threadId);
    if (sanitizedTurn !== turn) {
      didSanitize = true;
    }
    return sanitizedTurn;
  });

  return { turns: sanitizedTurns, didSanitize };
}

function sanitizeRelayHistoryTurn(turn, threadId = "") {
  if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
    return turn;
  }

  let turnDidChange = false;
  const turnThreadId = normalizeNonEmptyString(threadId)
    || normalizeNonEmptyString(turn.threadId)
    || normalizeNonEmptyString(turn.thread_id);
  const sanitizedItems = turn.items.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    let itemDidChange = false;
    let sanitizedItem = annotateImageGenerationHistoryItem(item, turnThreadId);
    if (sanitizedItem !== item) {
      itemDidChange = true;
    }

    if (Array.isArray(sanitizedItem.content)) {
      const sanitizedContent = sanitizedItem.content.map((contentItem) => {
        const sanitizedEntry = sanitizeInlineHistoryImageContentItem(contentItem);
        if (sanitizedEntry !== contentItem) {
          itemDidChange = true;
        }
        return sanitizedEntry;
      });

      if (itemDidChange) {
        sanitizedItem = {
          ...sanitizedItem,
          content: sanitizedContent,
        };
      }
    }

    const sanitizedCompactionItem = sanitizeCompactionHistoryItem(sanitizedItem);
    if (sanitizedCompactionItem !== sanitizedItem) {
      sanitizedItem = sanitizedCompactionItem;
      itemDidChange = true;
    }

    if (itemDidChange) {
      turnDidChange = true;
    }

    return itemDidChange ? sanitizedItem : item;
  });

  return turnDidChange
    ? {
      ...turn,
      items: sanitizedItems,
    }
    : turn;
}


function parseBridgeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Keeps app-server responses in the JSON-RPC shape that the iOS client decodes.
// Some agent CLIs (notably Codex's app-server) return responses wrapped in
// `{payload}` instead of `{result}`; iOS only knows how to read `{result}`. This
// helper rewrites those responses into the canonical shape, leaves
// already-canonical messages untouched, and drops anything that should not be
// forwarded to the relay (e.g. server-initiated requests for which we have no
// matching tracked request).
function normalizeRelayBoundJsonRpcMessage(rawMessage, {
  pendingRequestMethodsById = null,
} = {}) {
  const parsed = parseBridgeJSON(rawMessage);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const hasMethod = typeof parsed.method === "string" && parsed.method.length > 0;
  const hasResponseId = parsed.id !== undefined && parsed.id !== null;
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
  const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
  const hasPayload = Object.prototype.hasOwnProperty.call(parsed, "payload");
  if (hasResponseId && !hasMethod && !hasResult && !hasError && hasPayload) {
    const { payload, ...rest } = parsed;
    return JSON.stringify({
      ...rest,
      result: payload ?? null,
    });
  }

  if (hasResponseId && !hasMethod && hasResult && !hasError) {
    const unwrappedResult = unwrapAppServerPayloadResult(parsed.result);
    if (unwrappedResult !== parsed.result) {
      return JSON.stringify({
        ...parsed,
        result: unwrappedResult,
      });
    }
  }

  if (hasMethod && hasResponseId && !isRelayBoundServerRequestMethod(parsed.method)) {
    const trackedRequest = pendingRequestMethodsById?.get(String(parsed.id));
    const isTrackedResponse = trackedRequest?.method === parsed.method
      && (hasResult || hasError || hasPayload);
    if (isTrackedResponse) {
      const { method, payload, ...rest } = parsed;
      if (!hasResult && !hasError && hasPayload) {
        return JSON.stringify({
          ...rest,
          result: payload ?? null,
        });
      }
      if (hasResult && !hasError) {
        return JSON.stringify({
          ...rest,
          result: unwrapAppServerPayloadResult(rest.result),
        });
      }
      return JSON.stringify(rest);
    }

    return null;
  }

  if (!hasMethod && !hasResponseId) {
    return null;
  }

  return rawMessage;
}

function isRelayBoundServerRequestMethod(method) {
  return method === "item/tool/requestUserInput"
    || method === "tool/requestUserInput"
    || method.endsWith("requestApproval");
}

function trimThreadPayloadForRelay(parsed, explicitThread = undefined) {
  const thread = explicitThread ?? parsed?.result?.thread;
  if (!parsed || !thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    return null;
  }

  let workingThread = thread;
  let encoded = encodeRelayThreadPayload(parsed, workingThread);
  if (encoded == null) {
    return null;
  }

  if (Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    return explicitThread === undefined ? null : encoded;
  }

  const turns = thread.turns;
  let trimmedTurns = turns.length > RELAY_HISTORY_RECENT_TURN_TARGET
    ? turns.slice(-RELAY_HISTORY_RECENT_TURN_TARGET)
    : turns.slice();
  while (trimmedTurns.length > 1) {
    if (trimmedTurns.length === turns.length) {
      trimmedTurns = trimmedTurns.slice(1);
    }
    const candidateThread = buildRelayHistoryCompactedThread(
      thread,
      buildRelayCompactedHistoryTurns(turns, trimmedTurns),
      Math.max(0, turns.length - trimmedTurns.length),
      trimmedTurns.length
    );
    encoded = encodeRelayThreadPayload(parsed, candidateThread);
    if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return encoded;
    }
    workingThread = candidateThread;
    trimmedTurns = trimmedTurns.slice(1);
  }

  const newestTurn = trimmedTurns[0];
  if (!newestTurn || typeof newestTurn !== "object" || !Array.isArray(newestTurn.items)) {
    return encodeRelayThreadPayload(parsed, workingThread);
  }

  let trimmedItems = newestTurn.items.slice();
  while (trimmedItems.length > 1) {
    trimmedItems = trimmedItems.slice(1);
    const compactedTurnPrefix = buildRelayHistoryCompactionTurn(
      Math.max(0, turns.length - 1),
      1,
      thread
    );
    const candidateThread = buildRelayHistoryCompactedThread(
      thread,
      compactedTurnPrefix ? [compactedTurnPrefix, {
        ...newestTurn,
        items: trimmedItems,
      }] : [{
        ...newestTurn,
        items: trimmedItems,
      }],
      Math.max(0, turns.length - 1),
      1
    );
    encoded = encodeRelayThreadPayload(parsed, candidateThread);
    if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return encoded;
    }
    workingThread = candidateThread;
  }

  const mostRecentItem = trimmedItems[0];
  if (!mostRecentItem || typeof mostRecentItem !== "object") {
    return encodeRelayThreadPayload(parsed, workingThread);
  }

  const truncatedItem = truncateHistoryItemTextForRelay(
    mostRecentItem,
    RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS
  );
  let candidateThread = buildRelayHistoryCompactedThread(
    thread,
    [
      ...buildRelayCompactedHistoryTurns(turns, [newestTurn]).slice(0, -1),
      {
        ...newestTurn,
        items: [truncatedItem],
      },
    ],
    Math.max(0, turns.length - 1),
    1
  );
  encoded = encodeRelayThreadPayload(parsed, candidateThread);
  if (encoded != null && Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    return encoded;
  }

  candidateThread = buildRelayHistoryCompactedThread(
    thread,
    [
      ...buildRelayCompactedHistoryTurns(turns, [newestTurn]).slice(0, -1),
      {
        ...newestTurn,
        items: [compactHistoryItemForRelay(mostRecentItem, RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS)],
      },
    ],
    Math.max(0, turns.length - 1),
    1
  );
  return encodeRelayThreadPayload(parsed, candidateThread);
}

function trimTurnsListPayloadForRelay(parsed, turnsKey, originalRawMessage = null) {
  const result = parsed?.result;
  const turns = result?.[turnsKey];
  if (!parsed || !result || !Array.isArray(turns)) {
    return originalRawMessage ?? JSON.stringify(parsed);
  }

  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
    return originalRawMessage ?? encoded;
  }

  let fallbackCompactedPayload = null;
  for (const maxChars of [
    RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS,
    Math.floor(RELAY_HISTORY_TEXT_TAIL_LIMIT_CHARS / 4),
    1_000,
    0,
  ]) {
    const compactedTurns = turns.map((turn) => compactTurnsListTurnForRelay(turn, maxChars));
    const compactedPayload = JSON.stringify({
      ...parsed,
      result: {
        ...result,
        [turnsKey]: compactedTurns,
        agntPageCompactedForRelay: true,
      },
    });
    fallbackCompactedPayload = compactedPayload;
    if (Buffer.byteLength(compactedPayload, "utf8") <= RELAY_THREAD_PAYLOAD_SOFT_LIMIT_BYTES) {
      return compactedPayload;
    }
  }

  return fallbackCompactedPayload ?? (originalRawMessage ?? encoded);
}

function compactTurnsListTurnForRelay(turn, maxChars) {
  if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) {
    return turn;
  }

  return {
    ...turn,
    items: turn.items.map((item) => compactHistoryItemForRelay(item, maxChars)),
    agntPageCompactedForRelay: true,
  };
}


function buildRelayHistoryCompactedThread(thread, turns, omittedTurnCount, keptTurnCount) {
  return {
    ...thread,
    turns,
    historyTailTruncatedForRelay: true,
    agntHistoryCompacted: omittedTurnCount > 0,
    agntOmittedTurnCount: omittedTurnCount,
    agntKeptTurnCount: keptTurnCount,
  };
}

function buildRelayCompactedHistoryTurns(allTurns, keptTurns) {
  const omittedTurnCount = Math.max(0, allTurns.length - keptTurns.length);
  const compactionTurn = buildRelayHistoryCompactionTurn(
    omittedTurnCount,
    keptTurns.length,
    allTurns[0]
  );
  return compactionTurn ? [compactionTurn, ...keptTurns] : keptTurns;
}

function buildRelayHistoryCompactionTurn(omittedTurnCount, keptTurnCount, idSource = {}) {
  if (omittedTurnCount <= 0) {
    return null;
  }

  const baseId = normalizeNonEmptyString(idSource?.id)
    || normalizeNonEmptyString(idSource?.turnId)
    || normalizeNonEmptyString(idSource?.turn_id)
    || "history";
  const text = [
    "Earlier conversation compacted for mobile loading.",
    "",
    `Older turns omitted: ${omittedTurnCount}`,
    `Recent turns kept: ${keptTurnCount}`,
    "Full history remains available on the Mac runtime.",
  ].join("\n");

  return {
    id: `agnt-history-compacted-${baseId}`,
    agntSynthetic: true,
    agntHistoryCompacted: true,
    agntOmittedTurnCount: omittedTurnCount,
    agntKeptTurnCount: keptTurnCount,
    items: [
      {
        id: `agnt-history-compacted-item-${baseId}`,
        type: "assistant_message",
        role: "assistant",
        text,
        agntSynthetic: true,
        agntHistoryCompacted: true,
      },
    ],
  };
}

function encodeRelayThreadPayload(parsed, thread) {
  try {
    return JSON.stringify({
      ...parsed,
      result: {
        ...parsed.result,
        thread,
      },
    });
  } catch {
    return null;
  }
}

function truncateHistoryItemTextForRelay(item, maxChars) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  let didChange = false;
  let nextItem = item;
  const textKeys = ["text", "message", "summary", "output", "outputText", "output_text"];

  for (const key of textKeys) {
    if (typeof item[key] === "string" && item[key].length > maxChars) {
      nextItem = {
        ...nextItem,
        [key]: truncateRelayTextTail(item[key], maxChars),
      };
      didChange = true;
    }
  }

  if (Array.isArray(item.content)) {
    const nextContent = item.content.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }

      const truncatedEntry = truncateHistoryItemTextForRelay(entry, maxChars);
      if (truncatedEntry !== entry) {
        didChange = true;
      }
      return truncatedEntry;
    });

    if (didChange) {
      nextItem = {
        ...nextItem,
        content: nextContent,
      };
    }
  }

  return didChange
    ? {
      ...nextItem,
      relayTextTailTruncated: true,
    }
    : item;
}


// Treats silent relay sockets as stale so the daemon can self-heal after sleep/wake.
function hasRelayConnectionGoneStale(
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
  } = {}
) {
  return Number.isFinite(lastActivityAt)
    && Number.isFinite(now)
    && now - lastActivityAt >= staleAfterMs;
}

// Keeps persisted daemon status honest by downgrading stale "connected" snapshots.
function buildHeartbeatBridgeStatus(
  status,
  lastActivityAt,
  {
    now = Date.now(),
    staleAfterMs = RELAY_WATCHDOG_STALE_AFTER_MS,
    staleMessage = STALE_RELAY_STATUS_MESSAGE,
  } = {}
) {
  if (!status || typeof status !== "object") {
    return status;
  }

  if (status.connectionStatus !== "connected") {
    return status;
  }

  if (!hasRelayConnectionGoneStale(lastActivityAt, { now, staleAfterMs })) {
    return status;
  }

  return {
    ...status,
    connectionStatus: "disconnected",
    lastError: staleMessage,
  };
}

function createNoopDesktopRefresher() {
  return {
    handleInbound() {},
    handleOutbound() {},
    handleTransportReset() {},
  };
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
