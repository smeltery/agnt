// FILE: macos-launch-agent.js
// Purpose: Owns macOS-only launchd install/start/stop/uninstall/status helpers for the background agnt bridge.
// Layer: CLI helper
// Exports: start/stop/uninstall/status helpers plus the launchd service runner used by `agnt up`.
// Depends on: child_process, fs, os, path, ./bridge, ./daemon-state, ./bridge-config, ./qr, ./secure-device-state

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge } = require("../bridge/bridge");
const { readBridgeConfig } = require("../bridge/bridge-config");
const { printQR } = require("../transport/qr");
const {
  readBridgeDeviceState,
  resetBridgeDeviceState,
} = require("../transport/secure-device-state");
const {
  assertDarwinPlatform,
  assertRelayConfigured,
  bootoutLaunchAgent,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  readLaunchAgentState,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  sleep,
} = require("./macos-launch-agent-launchd");
const {
  clearBridgeStatus,
  clearPairingSession,
  ensureAgntLogsDir,
  ensureAgntStateDir,
  readBridgeStatus,
  readDaemonConfig,
  readPairingSession,
  resolveBridgeStderrLogPath,
  resolveBridgeStdoutLogPath,
  resolveAgntStateDir,
  writeBridgeStatus,
  writeDaemonConfig,
  writePairingSession,
} = require("../daemon-state");

const SERVICE_LABEL = "com.smeltery.agnt.bridge";
const DEFAULT_PAIRING_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_WAIT_INTERVAL_MS = 200;

// Runs the bridge inside launchd while keeping QR rendering in the foreground CLI command.
function runMacOSBridgeService({ env = process.env } = {}) {
  assertDarwinPlatform();
  const config = readDaemonConfig({ env });
  if (!config?.relayUrl) {
    const message = "No relay URL configured for the macOS bridge service.";
    // Clear any stale QR so the CLI does not keep showing a pairing payload for a dead service.
    clearPairingSession({ env });
    writeBridgeStatus({
      state: "error",
      connectionStatus: "error",
      pid: process.pid,
      lastError: message,
    }, { env });
    console.error(`[agnt] ${message}`);
    return;
  }

  startBridge({
    config,
    printPairingQr: false,
    onPairingSession(pairingSession) {
      writePairingSession(pairingSession, { env });
    },
    onBridgeStatus(status) {
      writeBridgeStatus(
        mergeBridgeStatusForDaemon(status, readBridgeStatus({ env })),
        { env }
      );
    },
  });
}

// Prepares config + launchd state and optionally waits for the fresh pairing payload written by the service.
async function startMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "agnt.js"),
  waitForPairing = false,
  pairingTimeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  pairingPollIntervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
  providerId = "",
} = {}) {
  assertDarwinPlatform(platform);
  const config = readBridgeConfig({ env });
  assertRelayConfigured(config);
  const startedAt = Date.now();

  const persistedConfig = providerId
    ? { ...config, providerId }
    : config;
  writeDaemonConfig(persistedConfig, { env, fsImpl });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
  ensureAgntStateDir({ env, fsImpl, osImpl });
  ensureAgntLogsDir({ env, fsImpl, osImpl });

  const plistPath = writeLaunchAgentPlist({
    env,
    fsImpl,
    osImpl,
    nodePath,
    cliPath,
  });
  restartLaunchAgent({
    env,
    execFileSyncImpl,
    plistPath,
  });

  if (!waitForPairing) {
    return {
      plistPath,
      pairingSession: null,
    };
  }

  const pairingSession = await waitForFreshPairingSession({
    env,
    fsImpl,
    startedAt,
    timeoutMs: pairingTimeoutMs,
    intervalMs: pairingPollIntervalMs,
  });
  return {
    plistPath,
    pairingSession,
  };
}

function stopMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  processImpl = process,
} = {}) {
  assertDarwinPlatform(platform);
  const previousStatus = readBridgeStatus({ env, fsImpl });
  bootoutLaunchAgent({
    env,
    execFileSyncImpl,
    ignoreMissing: true,
  });
  terminateRecordedBridgeProcess(previousStatus, {
    execFileSyncImpl,
    processImpl,
  });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
}

// Removes launchd ownership of the bridge (unload + plist) while preserving daemon config,
// logs, device trust, and pairing identity for a future reinstall.
function uninstallMacOSBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  processImpl = process,
} = {}) {
  assertDarwinPlatform(platform);
  const plistPath = resolveLaunchAgentPlistPath({ env });
  const removed = fsImpl.existsSync(plistPath);
  // Stop first: a real bootout failure throws here and leaves the plist on disk.
  stopMacOSBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
    processImpl,
  });
  fsImpl.rmSync(plistPath, { force: true });
  return { plistPath, removed };
}

// Stops orphaned run-service processes left behind when launchd reports the job missing.
function terminateRecordedBridgeProcess(status, {
  execFileSyncImpl = execFileSync,
  processImpl = process,
} = {}) {
  const pid = Number(status?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === processImpl.pid) {
    return false;
  }

  if (!isRecordedAgntBridgeProcess(pid, { execFileSyncImpl })) {
    return false;
  }

  try {
    processImpl.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// Checks the command line before killing so stale status files cannot target unrelated processes.
function isRecordedAgntBridgeProcess(pid, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const command = execFileSyncImpl("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return command.includes("agnt")
      && command.includes("run-service");
  } catch {
    return false;
  }
}

// Revokes pairing immediately on macOS by stopping the daemon before rotating identity/trust state.
function resetMacOSBridgePairing({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  resetBridgePairingImpl = resetBridgeDeviceState,
} = {}) {
  assertDarwinPlatform(platform);
  stopMacOSBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
  });
  return resetBridgePairingImpl();
}

function getMacOSBridgeServiceStatus({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  assertDarwinPlatform(platform);
  const launchd = readLaunchAgentState({ env, execFileSyncImpl });
  return {
    label: SERVICE_LABEL,
    platform: "darwin",
    installed: fsImpl.existsSync(resolveLaunchAgentPlistPath({ env })),
    launchdLoaded: launchd.loaded,
    launchdPid: launchd.pid,
    daemonConfig: readDaemonConfig({ env, fsImpl }),
    bridgeStatus: readBridgeStatus({ env, fsImpl }),
    pairingSession: readPairingSession({ env, fsImpl }),
    trustedDevice: buildTrustedDeviceSummary(readBridgeDeviceState()),
    stdoutLogPath: resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: resolveBridgeStderrLogPath({ env }),
  };
}

function printMacOSBridgeServiceStatus(options = {}) {
  const status = getMacOSBridgeServiceStatus(options);
  const bridgeState = status.bridgeStatus?.state || "unknown";
  const connectionStatus = status.bridgeStatus?.connectionStatus || "unknown";
  const pairingCreatedAt = status.pairingSession?.createdAt || "none";
  const activeDevice = status.bridgeStatus?.activeDevice || status.bridgeStatus?.activePhone;
  const trustedPhoneCount = status.trustedDevice?.trustedPhoneCount || 0;
  const activeDeviceName = formatDeviceKind(activeDevice?.deviceKind) || "device";
  const trustedDeviceName = formatDeviceKind(status.trustedDevice?.lastSeenDeviceKind) || "device";
  console.log(`[agnt] Service label: ${status.label}`);
  console.log(`[agnt] Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`[agnt] Launchd loaded: ${status.launchdLoaded ? "yes" : "no"}`);
  console.log(`[agnt] PID: ${status.launchdPid || status.bridgeStatus?.pid || "unknown"}`);
  console.log(`[agnt] Bridge state: ${bridgeState}`);
  console.log(`[agnt] Connection: ${connectionStatus}`);
  console.log(`[agnt] Active ${activeDeviceName}: ${activeDevice?.connected ? activeDevice.phoneFingerprint || "yes" : "no"}`);
  console.log(`[agnt] Trusted ${trustedDeviceName}: ${trustedPhoneCount > 0 ? "yes" : "no"}`);
  console.log(`[agnt] Pairing payload: ${pairingCreatedAt}`);
  console.log(`[agnt] Stdout log: ${status.stdoutLogPath}`);
  console.log(`[agnt] Stderr log: ${status.stderrLogPath}`);
}

function printMacOSBridgePairingQr({ pairingSession = null, env = process.env, fsImpl = fs } = {}) {
  const nextPairingSession = pairingSession || readPairingSession({ env, fsImpl });
  const pairingPayload = nextPairingSession?.pairingPayload;
  if (!pairingPayload) {
    throw new Error("The macOS bridge service did not publish a pairing payload yet.");
  }

  printQR(nextPairingSession);
}

// Persists a launch agent that always runs the Node CLI entrypoint in service mode.
function writeLaunchAgentPlist({
  env = process.env,
  fsImpl = fs,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "agnt.js"),
} = {}) {
  const plistPath = resolveLaunchAgentPlistPath({ env, osImpl });
  const stateDir = resolveAgntStateDir({ env, osImpl });
  const stdoutLogPath = resolveBridgeStdoutLogPath({ env, osImpl });
  const stderrLogPath = resolveBridgeStderrLogPath({ env, osImpl });
  const homeDir = env.HOME || osImpl.homedir();
  const serialized = buildLaunchAgentPlist({
    homeDir,
    pathEnv: env.PATH || "",
    stateDir,
    stdoutLogPath,
    stderrLogPath,
    nodePath,
    cliPath,
  });

  fsImpl.mkdirSync(path.dirname(plistPath), { recursive: true });
  fsImpl.writeFileSync(plistPath, serialized, "utf8");
  return plistPath;
}

function mergeBridgeStatusForDaemon(nextStatus, persistedStatus) {
  if (!nextStatus || typeof nextStatus !== "object") {
    return nextStatus;
  }

  const lastError = normalizeNonEmptyString(nextStatus.lastError);
  if (lastError || nextStatus.connectionStatus === "connected") {
    return nextStatus;
  }

  if (
    nextStatus.codexLaunchState !== "starting"
    || (nextStatus.connectionStatus !== "starting" && nextStatus.connectionStatus !== "connecting")
  ) {
    return nextStatus;
  }

  const persistedError = normalizeNonEmptyString(persistedStatus?.lastError);
  if (!persistedError) {
    return nextStatus;
  }

  return {
    ...nextStatus,
    lastError: persistedError,
  };
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function buildTrustedDeviceSummary(deviceState) {
  const trustedPhoneEntries = Object.entries(deviceState?.trustedPhones || {})
    .filter(([phoneDeviceId, publicKey]) => (
      normalizeNonEmptyString(phoneDeviceId) && normalizeNonEmptyString(publicKey)
    ));
  const firstTrustedPhoneId = trustedPhoneEntries[0]?.[0] || "";
  const lastSeenPhoneAppVersion = normalizeNonEmptyString(deviceState?.lastSeenPhoneAppVersion) || null;
  return {
    macDeviceFingerprint: shortFingerprint(deviceState?.macDeviceId),
    trustedPhoneCount: trustedPhoneEntries.length,
    trustedPhoneFingerprint: shortFingerprint(firstTrustedPhoneId),
    lastSeenDeviceKind: normalizeNonEmptyString(deviceState?.lastSeenDeviceKind)
      || (lastSeenPhoneAppVersion ? "iphone" : null),
    lastSeenPhoneAppVersion,
  };
}

function formatDeviceKind(deviceKind) {
  const normalized = normalizeNonEmptyString(deviceKind).toLowerCase();
  if (normalized === "iphone") {
    return "iPhone";
  }
  if (normalized === "android") {
    return "Android";
  }
  if (normalized === "browser") {
    return "Browser";
  }
  if (normalized === "mac") {
    return "Mac";
  }
  return "";
}

function shortFingerprint(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

module.exports = {
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  buildTrustedDeviceSummary,
  formatDeviceKind,
  getMacOSBridgeServiceStatus,
  mergeBridgeStatusForDaemon,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  resetMacOSBridgePairing,
  resolveLaunchAgentPlistPath,
  runMacOSBridgeService,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
};
