const { randomBytes } = require("crypto");
const { readBridgeConfig: defaultReadBridgeConfig } = require("./bridge-config");
const { resolveActiveProvider: defaultResolveActiveProvider } = require("../providers/index");
const {
  readDaemonConfig: defaultReadDaemonConfig,
  writeDaemonConfig: defaultWriteDaemonConfig,
} = require("../daemon-state");
const {
  loadOrCreateBridgeDeviceState: defaultLoadOrCreateBridgeDeviceState,
  resolveBridgeRelaySession: defaultResolveBridgeRelaySession,
} = require("../transport/secure-device-state");
const { createNoopDesktopRefresher } = require("./lifecycle");
const { buildCachedIOSAppCompatibilityWarning } = require("./ios-app-compatibility");

function createBridgeStartupContext({
  bridgePackageVersion,
  deps = {},
  explicitConfig,
  providerId,
}) {
  const {
    loadOrCreateBridgeDeviceState = defaultLoadOrCreateBridgeDeviceState,
    readBridgeConfig = defaultReadBridgeConfig,
    readDaemonConfig = defaultReadDaemonConfig,
    resolveActiveProvider = defaultResolveActiveProvider,
    resolveBridgeRelaySession = defaultResolveBridgeRelaySession,
    writeDaemonConfig = defaultWriteDaemonConfig,
  } = deps;
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
  persistExplicitProviderPreference(activeProvider, providerSource, {
    readDaemonConfig,
    writeDaemonConfig,
  });

  config.keepMacAwakeEnabled = config.keepMacAwakeEnabled === true;
  const desktopBundle = typeof activeProvider.desktopBundle === "function"
    ? activeProvider.desktopBundle({ env: process.env }) || { id: "", appPath: "" }
    : { id: "", appPath: "" };
  const relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
  if (!relayBaseUrl) {
    console.error("[agnt] No relay URL configured.");
    console.error("[agnt] In a source checkout, run ./scripts/run-local-agnt.sh or set AGNT_RELAY.");
    process.exit(1);
  }

  let deviceState = loadDeviceStateOrExit({ loadOrCreateBridgeDeviceState });
  const relaySession = resolveBridgeRelaySession(deviceState);
  deviceState = relaySession.deviceState;
  const sessionId = relaySession.sessionId;
  const relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
  const notificationSecret = randomBytes(24).toString("hex");
  const cachedIOSAppCompatibilityWarning = buildCachedIOSAppCompatibilityWarning({
    bridgeVersion: bridgePackageVersion,
    iosAppVersion: deviceState.lastSeenPhoneAppVersion,
  });
  const desktopRefresher = createDesktopRefresher({
    activeProvider,
    config,
    desktopBundle,
  });

  return {
    activeProvider,
    cachedIOSAppCompatibilityWarning,
    config,
    desktopBundle,
    desktopRefresher,
    deviceState,
    notificationSecret,
    relayBaseUrl,
    relaySessionUrl,
    sessionId,
  };
}

function persistExplicitProviderPreference(activeProvider, providerSource, {
  readDaemonConfig,
  writeDaemonConfig,
}) {
  if (providerSource !== "explicit") {
    return;
  }

  try {
    writeDaemonConfig({
      ...(readDaemonConfig() || {}),
      providerId: activeProvider.id,
    });
  } catch (error) {
    console.warn(`[agnt] Failed to persist provider preference: ${(error && error.message) || error}`);
  }
}

function loadDeviceStateOrExit({ loadOrCreateBridgeDeviceState }) {
  try {
    return loadOrCreateBridgeDeviceState();
  } catch (error) {
    console.error(`[agnt] ${(error && error.message) || "Failed to load the saved bridge pairing state."}`);
    process.exit(1);
  }
}

function createDesktopRefresher({ activeProvider, config, desktopBundle }) {
  return activeProvider.capabilities?.desktopRefresher && typeof activeProvider.createDesktopRefresher === "function"
    ? activeProvider.createDesktopRefresher({
      // IPC snapshots are accepted only after Codex mounts the route and
      // announces itself as a follower. Auto-follow performs that one-time
      // activation; refreshEnabled still controls the legacy reload workaround.
      enabled: config.refreshEnabled || config.desktopAutoFollowEnabled === true,
      navigationOnly: !config.codexEndpoint,
      debounceMs: config.refreshDebounceMs,
      refreshCommand: config.refreshCommand,
      bundleId: desktopBundle.id,
      appPath: desktopBundle.appPath,
    })
    : createNoopDesktopRefresher();
}

module.exports = {
  createBridgeStartupContext,
};
