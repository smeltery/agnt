// FILE: linux-systemd-agent.js
// Purpose: Owns Linux-only systemd-user install/start/stop/status helpers for the background agnt bridge.
// Layer: CLI helper
// Exports: start/stop/status helpers plus the service runner used by `agnt up`.
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
const {
  buildTrustedDeviceSummary,
  formatDeviceKind,
  mergeBridgeStatusForDaemon,
} = require("./macos-launch-agent");
const {
  assertNonDarwinPlatform,
  assertRelayConfigured,
  assertSystemdAvailable,
  buildSystemdUserUnit,
  isLinuxBridgeServiceNotInstalledError,
  readSystemdUserUnitState,
  resolveSystemdUserUnitPath,
  restartSystemdUserUnit,
  sleep,
  stopSystemdUserUnit,
} = require("./linux-systemd-agent-systemd");

const SERVICE_LABEL = "com.dotbrains.agnt.bridge";
const SERVICE_UNIT_NAME = `${SERVICE_LABEL}.service`;
const DEFAULT_PAIRING_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_WAIT_INTERVAL_MS = 200;

// Runs the bridge inside systemd-user while keeping QR rendering in the foreground CLI command.
function runLinuxBridgeService({ env = process.env } = {}) {
  const config = readDaemonConfig({ env });
  if (!config?.relayUrl) {
    const message = "No relay URL configured for the Linux bridge service.";
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

// Prepares config + systemd state and optionally waits for the fresh pairing payload written by the service.
async function startLinuxBridgeService({
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
  assertNonDarwinPlatform(platform);
  assertSystemdAvailable({ env, execFileSyncImpl });
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

  const unitPath = writeSystemdUserUnit({
    env,
    fsImpl,
    osImpl,
    nodePath,
    cliPath,
  });
  restartSystemdUserUnit({
    env,
    execFileSyncImpl,
    unitPath,
  });

  if (!waitForPairing) {
    return {
      unitPath,
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
    unitPath,
    pairingSession,
  };
}

function stopLinuxBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  processImpl = process,
} = {}) {
  assertNonDarwinPlatform(platform);
  const previousStatus = readBridgeStatus({ env, fsImpl });
  stopSystemdUserUnit({
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

// Stops orphaned run-service processes left behind when systemd reports the unit missing.
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

// Revokes pairing immediately on Linux by stopping the daemon before rotating identity/trust state.
function resetLinuxBridgePairing({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  resetBridgePairingImpl = resetBridgeDeviceState,
} = {}) {
  assertNonDarwinPlatform(platform);
  stopLinuxBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
  });
  return resetBridgePairingImpl();
}

function getLinuxBridgeServiceStatus({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  assertNonDarwinPlatform(platform);
  const systemd = readSystemdUserUnitState({ env, execFileSyncImpl });
  return {
    label: SERVICE_LABEL,
    platform: "linux",
    installed: fsImpl.existsSync(resolveSystemdUserUnitPath({ env })),
    systemdLoaded: systemd.loaded,
    systemdActive: systemd.active,
    systemdPid: systemd.pid,
    daemonConfig: readDaemonConfig({ env, fsImpl }),
    bridgeStatus: readBridgeStatus({ env, fsImpl }),
    pairingSession: readPairingSession({ env, fsImpl }),
    trustedDevice: buildTrustedDeviceSummary(readBridgeDeviceState()),
    stdoutLogPath: resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: resolveBridgeStderrLogPath({ env }),
  };
}

function printLinuxBridgeServiceStatus(options = {}) {
  const status = getLinuxBridgeServiceStatus(options);
  const bridgeState = status.bridgeStatus?.state || "unknown";
  const connectionStatus = status.bridgeStatus?.connectionStatus || "unknown";
  const pairingCreatedAt = status.pairingSession?.createdAt || "none";
  const activeDevice = status.bridgeStatus?.activeDevice || status.bridgeStatus?.activePhone;
  const trustedPhoneCount = status.trustedDevice?.trustedPhoneCount || 0;
  const activeDeviceName = formatDeviceKind(activeDevice?.deviceKind) || "device";
  const trustedDeviceName = formatDeviceKind(status.trustedDevice?.lastSeenDeviceKind) || "device";
  console.log(`[agnt] Service label: ${status.label}`);
  console.log(`[agnt] Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`[agnt] Systemd loaded: ${status.systemdLoaded ? "yes" : "no"}`);
  console.log(`[agnt] Systemd active: ${status.systemdActive ? "yes" : "no"}`);
  console.log(`[agnt] PID: ${status.systemdPid || status.bridgeStatus?.pid || "unknown"}`);
  console.log(`[agnt] Bridge state: ${bridgeState}`);
  console.log(`[agnt] Connection: ${connectionStatus}`);
  console.log(`[agnt] Active ${activeDeviceName}: ${activeDevice?.connected ? activeDevice.phoneFingerprint || "yes" : "no"}`);
  console.log(`[agnt] Trusted ${trustedDeviceName}: ${trustedPhoneCount > 0 ? "yes" : "no"}`);
  console.log(`[agnt] Pairing payload: ${pairingCreatedAt}`);
  console.log(`[agnt] Stdout log: ${status.stdoutLogPath}`);
  console.log(`[agnt] Stderr log: ${status.stderrLogPath}`);
}

function printLinuxBridgePairingQr({ pairingSession = null, env = process.env, fsImpl = fs } = {}) {
  const nextPairingSession = pairingSession || readPairingSession({ env, fsImpl });
  const pairingPayload = nextPairingSession?.pairingPayload;
  if (!pairingPayload) {
    throw new Error("The Linux bridge service did not publish a pairing payload yet.");
  }

  printQR(nextPairingSession);
}

// Persists a systemd user unit that always runs the Node CLI entrypoint in service mode.
function writeSystemdUserUnit({
  env = process.env,
  fsImpl = fs,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "agnt.js"),
} = {}) {
  const unitPath = resolveSystemdUserUnitPath({ env, osImpl });
  const stateDir = resolveAgntStateDir({ env, osImpl });
  const stdoutLogPath = resolveBridgeStdoutLogPath({ env, osImpl });
  const stderrLogPath = resolveBridgeStderrLogPath({ env, osImpl });
  const homeDir = env.HOME || osImpl.homedir();
  const serialized = buildSystemdUserUnit({
    homeDir,
    pathEnv: env.PATH || "",
    stateDir,
    stdoutLogPath,
    stderrLogPath,
    nodePath,
    cliPath,
  });

  fsImpl.mkdirSync(path.dirname(unitPath), { recursive: true });
  fsImpl.writeFileSync(unitPath, serialized, { mode: 0o600 });
  try {
    fsImpl.chmodSync(unitPath, 0o600);
  } catch {
    // Best-effort only on filesystems without POSIX mode support.
  }
  return unitPath;
}

module.exports = {
  buildSystemdUserUnit,
  getLinuxBridgeServiceStatus,
  isLinuxBridgeServiceNotInstalledError,
  printLinuxBridgePairingQr,
  printLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  resolveSystemdUserUnitPath,
  runLinuxBridgeService,
  startLinuxBridgeService,
  stopLinuxBridgeService,
};
