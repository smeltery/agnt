// FILE: bridge.js
// Purpose: Runs Codex locally, bridges relay traffic, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ws, crypto, os, ./providers/codex/home, ./qr, ./bridge-config, ./providers/codex/transport, ./rollout-watch, ./voice-handler, ./ios-app-compatibility

const WebSocket = require("ws");
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
const { readDaemonConfig, writeDaemonConfig } = require("../daemon-state");
const { createNotificationsHandler } = require("../handlers/notifications-handler");
const { createVoiceHandler, resolveVoiceAuth } = require("../handlers/voice-handler");
const { createTerminalHandler } = require("../handlers/terminal-handler");
const {
  composeSanitizedAuthStatusFromSettledResults,
} = require("../handlers/account-status");
const { createAccountHandler } = require("../handlers/account-handler");
const { createForwardedRequestTracker } = require("./forwarded-request-tracker");
const { createMacOSBridgeWakeAssertion } = require("../platform/wake-assertion");
const { createBridgePreferences } = require("./bridge-preferences");
const { createContextUsageWatcher } = require("./context-usage-watcher");
const { createHandshakeHandler } = require("./handshake-handler");
const { createBridgePackageVersionStatusReader } = require("./package-version-status");
const { createBridgePackageUpdateAndRestart } = require("./bridge-package-updater");
const { createPushNotificationServiceClient } = require("../transport/push-notification-service-client");
const { createPushNotificationTracker } = require("../transport/push-notification-tracker");
const {
  createThreadTurnsListFastPageCoordinator,
} = require("./turns-list-pager");
const {
  sanitizeThreadHistoryImagesForRelay,
} = require("./relay-payload-pipeline");
const {
  buildMacRegistration,
} = require("./mac-registration");
const {
  shutdown,
} = require("./lifecycle");
const {
  createBridgeManagedCodexClient,
} = require("./bridge-managed-codex-client");
const {
  createRelayOutboundPipeline,
} = require("./relay-outbound-pipeline");
const {
  createBridgeApplicationHandler,
} = require("./bridge-application-handler");
const {
  disableUnsupportedReasoningSummaryForTurnStart,
} = require("./turn-start-normalizer");
const {
  createBridgeStatusRuntime,
} = require("./bridge-status-runtime");
const { createBridgeSecureTransport } = require("../transport/secure-transport");
const {
  seedConversationStateFromThreadRead,
} = require("../desktop/desktop-ipc-action-follower");
const {
  createBridgeDesktopIntegrations,
} = require("./bridge-desktop-integrations");
const { version: bridgePackageVersion = "" } = require("../../package.json");
const { createShortPairingCode, SHORT_PAIRING_CODE_LENGTH } = require("../transport/qr");
const {
  createBridgeStartupContext,
} = require("./bridge-startup-context");
const {
  createBridgeRelaySocketLoop,
} = require("./bridge-relay-socket");
const {
  createRelayResponseSanitizer,
  createThreadMemoryObserver,
  createThreadNameNotifier,
} = require("./bridge-message-helpers");
const { createThreadListProvenanceEnricher } = require("./thread-list-provenance");
const { createWorktreeOriginEnricher } = require("./worktree-origin");
const bridgeTestExports = require("./bridge-test-exports");
const {
  loadOrCreateBridgeDeviceState,
  resolveBridgeRelaySession,
} = require("../transport/secure-device-state");

function startBridge({
  config: explicitConfig = null,
  printPairingQr = true,
  onPairingSession = null,
  onBridgeStatus = null,
  providerId = "",
} = {}) {
  const startup = createBridgeStartupContext({
    bridgePackageVersion,
    deps: {
      loadOrCreateBridgeDeviceState,
      readBridgeConfig,
      readDaemonConfig,
      resolveActiveProvider,
      resolveBridgeRelaySession,
      writeDaemonConfig,
    },
    explicitConfig,
    providerId,
  });
  const {
    activeProvider,
    cachedIOSAppCompatibilityWarning,
    config,
    desktopBundle,
    desktopRefresher,
    notificationSecret,
    relayBaseUrl,
    relaySessionUrl,
    sessionId,
  } = startup;
  let { deviceState } = startup;
  const bridgeWakeAssertion = createMacOSBridgeWakeAssertion({
    enabled: config.keepMacAwakeEnabled,
  });
  const bridgePreferences = createBridgePreferences({ config, bridgeWakeAssertion });
  const threadTurnsListFastPageCoordinator = createThreadTurnsListFastPageCoordinator();
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
    readThread: (threadId) => bridgeManagedCodex.sendRequest("thread/read", {
      threadId,
      includeTurns: true,
    }),
  });
  const readBridgePackageVersionStatus = createBridgePackageVersionStatusReader();

  // Keep the local Codex runtime alive across transient relay disconnects.
  let isShuttingDown = false;
  const bridgeStatus = createBridgeStatusRuntime({
    WebSocketCtor: WebSocket,
    initialCodexLaunchState: config.codexEndpoint ? "connected" : "starting",
    isShuttingDown: () => isShuttingDown,
    getSocket: () => socketLoop.getSocket(),
    onBridgeStatus,
  });
  const bridgeManagedCodex = createBridgeManagedCodexClient({
    send: (payload) => codex.send(payload),
  });
  const forwardedRequestTracker = createForwardedRequestTracker({
    parseJson: safeParseJSON,
  });
  const threadRowEnrichers = activeProvider.id === "codex"
    ? [
      createWorktreeOriginEnricher(),
      createThreadListProvenanceEnricher(),
    ]
    : [];
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
  const codex = withTranslator(
    activeProvider.createTransport({
      endpoint: config.codexEndpoint,
      env: process.env,
      appPath: desktopBundle.appPath,
      logPrefix: "[agnt]",
    }),
    activeProvider,
  );
  const contextUsageWatcher = createContextUsageWatcher({
    sendApplicationResponse,
  });
  const rememberThreadFromMessage = createThreadMemoryObserver({
    contextUsageWatcher,
  });
  const sanitizeRelayBoundCodexMessage = createRelayResponseSanitizer({
    activeProvider,
    forwardedRequestTracker,
    parseJson: safeParseJSON,
    sanitizeThreadHistoryImagesForRelay,
    threadRowEnrichers,
  });
  const sendThreadNameUpdatedNotification = createThreadNameNotifier({
    sendApplicationResponse,
  });
  const {
    handleRuntimeSettings,
    threadRuntimeSettingsStore,
    desktopIpcActionFollower,
    desktopIpcLiveOwner,
    rolloutLiveMirror,
  } = createBridgeDesktopIntegrations({
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
  });

  if (activeProvider.id === "codex") threadRowEnrichers.push(threadRuntimeSettingsStore);

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
  const updateBridgePackageAndRestart = createBridgePackageUpdateAndRestart({
    logger: console,
  });
  const terminalHandler = createTerminalHandler({
    isEnabled: () => config.enableWebTerminal === true,
    sendApplicationResponse: (raw) => sendApplicationResponse(raw),
    logPrefix: "[agnt]",
  });
  bridgeStatus.startBridgeStatusHeartbeat();
  bridgeStatus.publishBridgeStatus({
    state: "starting",
    connectionStatus: "starting",
    pid: process.pid,
    lastError: "",
  });

  codex.onError((error) => {
    bridgeStatus.setCodexLaunchState("error");
    bridgeStatus.publishBridgeStatus({
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
    bridgeStatus.setCodexLaunchState("connected");
    const lastPublishedBridgeStatus = bridgeStatus.getLastPublishedBridgeStatus();
    if (!lastPublishedBridgeStatus) {
      return;
    }

    bridgeStatus.publishBridgeStatus(lastPublishedBridgeStatus);
  });

  // Consolidates the non-relay teardown sequence so SIGINT / SIGTERM and the
  // codex.onClose handler all stop the same set of background work in the same
  // order. The relay-socket-loop's own onShutdown callback intentionally keeps
  // its inline teardown — its close-code-4000/4001 path is agnt-specific and
  // owned by that module.
  function prepareBridgeShutdown() {
    isShuttingDown = true;
    bridgeWakeAssertion.stop();
    bridgeStatus.clearReconnectTimer();
    bridgeStatus.clearRelayWatchdog();
    bridgeStatus.clearBridgeStatusHeartbeat();
    contextUsageWatcher.stop();
    rolloutLiveMirror?.stopAll();
    desktopIpcLiveOwner?.stopAll();
    desktopIpcActionFollower?.stopAll();
    terminalHandler.shutdown();
  }

  let handleApplicationMessage;
  const socketLoop = createBridgeRelaySocketLoop({
    WebSocketCtor: WebSocket,
    bridgeStatus,
    bridgeWakeAssertion,
    codex,
    contextUsageWatcher,
    desktopIpcActionFollower,
    desktopIpcLiveOwner,
    getDeviceState: () => deviceState,
    getPairingSession: () => pairingSession,
    getRelaySessionUrl: () => relaySessionUrl,
    handleApplicationMessage: (plaintextMessage) => handleApplicationMessage(plaintextMessage),
    isShuttingDown: () => isShuttingDown,
    markShuttingDown: () => { isShuttingDown = true; },
    notificationSecret,
    rolloutLiveMirror,
    secureTransport,
    sendRelayRegistrationUpdate,
    sendRelayWireMessage,
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
      (msg) => { desktopIpcLiveOwner?.observeOutbound(msg); return false; },
      (msg) => rememberThreadFromMessage("codex", msg),
    ],
    sanitize: sanitizeRelayBoundCodexMessage,
    forward: forwardApplicationMessage,
  }));

  codex.onClose(() => {
    bridgeStatus.logConnectionStatus("disconnected");
    bridgeStatus.publishBridgeStatus({
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

  handleApplicationMessage = createBridgeApplicationHandler({
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
    handleFallbackMessage: forwardApplicationMessageToProvider,
    handleRuntimeSettings,
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
  });

  function forwardApplicationMessageToProvider(msg, providerTransport) {
    // Spark's Responses API rejects reasoning.summary, so rewrite turn/start before forwarding.
    // Other providers handle their own model quirks in their translators.
    const forwarded = normalizeProviderMessage(msg);
    rememberThreadFromMessage("phone", forwarded);
    providerTransport.send(forwarded);
  }

  function normalizeProviderMessage(rawMessage) {
    return activeProvider.id === "codex"
      ? disableUnsupportedReasoningSummaryForTurnStart(rawMessage)
      : rawMessage;
  }

  function normalizeCodexTurnStartParams(params) {
    const raw = JSON.stringify({ method: "turn/start", params });
    const normalized = disableUnsupportedReasoningSummaryForTurnStart(raw);
    return safeParseJSON(normalized)?.params || params;
  }

  // Encrypts bridge-generated responses instead of letting the relay see plaintext.
  function sendApplicationResponse(rawMessage) {
    forwardApplicationMessage(sanitizeRelayBoundCodexMessage(rawMessage));
  }

  function forwardApplicationMessage(payload) {
    if (payload == null) return;
    pushNotificationTracker.handleOutbound(payload);
    secureTransport.queueOutboundApplicationMessage(payload, sendRelayWireMessage);
  }

  // Seeds the desktop IPC follower without pulling huge turn history into baseline recovery.
  async function readDesktopConversationState(threadId) {
    const result = await bridgeManagedCodex.sendRequest("thread/read", {
      threadId,
      includeTurns: false,
    });
    return seedConversationStateFromThreadRead(result);
  }

  function safeParseJSON(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
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


module.exports = {
  ...bridgeTestExports,
  startBridge,
};
