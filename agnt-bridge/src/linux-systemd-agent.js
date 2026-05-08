// FILE: linux-systemd-agent.js
// Purpose: Owns Linux-only systemd-user install/start/stop/status helpers for the background agnt bridge.
// Layer: CLI helper
// Exports: start/stop/status helpers plus the service runner used by `agnt up`.
// Depends on: child_process, fs, os, path, ./bridge, ./daemon-state, ./bridge-config, ./qr, ./secure-device-state

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge } = require("./bridge");
const { readBridgeConfig } = require("./bridge-config");
const { printQR } = require("./qr");
const { resetBridgeDeviceState } = require("./secure-device-state");
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
} = require("./daemon-state");
const { mergeBridgeStatusForDaemon } = require("./macos-launch-agent");

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
    stdoutLogPath: resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: resolveBridgeStderrLogPath({ env }),
  };
}

function printLinuxBridgeServiceStatus(options = {}) {
  const status = getLinuxBridgeServiceStatus(options);
  const bridgeState = status.bridgeStatus?.state || "unknown";
  const connectionStatus = status.bridgeStatus?.connectionStatus || "unknown";
  const pairingCreatedAt = status.pairingSession?.createdAt || "none";
  console.log(`[agnt] Service label: ${status.label}`);
  console.log(`[agnt] Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`[agnt] Systemd loaded: ${status.systemdLoaded ? "yes" : "no"}`);
  console.log(`[agnt] Systemd active: ${status.systemdActive ? "yes" : "no"}`);
  console.log(`[agnt] PID: ${status.systemdPid || status.bridgeStatus?.pid || "unknown"}`);
  console.log(`[agnt] Bridge state: ${bridgeState}`);
  console.log(`[agnt] Connection: ${connectionStatus}`);
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

function buildSystemdUserUnit({
  homeDir,
  pathEnv,
  stateDir,
  stdoutLogPath,
  stderrLogPath,
  nodePath,
  cliPath,
}) {
  return `[Unit]
Description=agnt bridge (local-first iOS bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${escapeSystemdExec(nodePath)} ${escapeSystemdExec(cliPath)} run-service
Restart=on-failure
RestartSec=2
SuccessExitStatus=0
WorkingDirectory=${escapeSystemdValue(homeDir)}
Environment=${formatSystemdEnv("HOME", homeDir)}
Environment=${formatSystemdEnv("PATH", pathEnv)}
Environment=${formatSystemdEnv("AGNT_DEVICE_STATE_DIR", stateDir)}
StandardOutput=append:${escapeSystemdValue(stdoutLogPath)}
StandardError=append:${escapeSystemdValue(stderrLogPath)}

[Install]
WantedBy=default.target
`;
}

async function waitForFreshPairingSession({
  env = process.env,
  fsImpl = fs,
  startedAt = Date.now(),
  timeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const pairingSession = readPairingSession({ env, fsImpl });
    const createdAt = Date.parse(pairingSession?.createdAt || "");
    if (pairingSession?.pairingPayload && Number.isFinite(createdAt) && createdAt >= startedAt) {
      return pairingSession;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for the Linux bridge service to publish a pairing QR. `
    + `Check ${resolveBridgeStderrLogPath({ env })}.`
  );
}

function restartSystemdUserUnit({
  env = process.env,
  execFileSyncImpl = execFileSync,
  unitPath,
} = {}) {
  systemctlUser(["daemon-reload"], { env, execFileSyncImpl });
  // `restart` works whether the unit was already running or not.
  systemctlUser(["restart", SERVICE_UNIT_NAME], { env, execFileSyncImpl });
  return unitPath;
}

function stopSystemdUserUnit({
  env = process.env,
  execFileSyncImpl = execFileSync,
  ignoreMissing = false,
} = {}) {
  try {
    systemctlUser(["stop", SERVICE_UNIT_NAME], { env, execFileSyncImpl });
  } catch (error) {
    if (!ignoreMissing || !isMissingSystemdUnitError(error)) {
      throw error;
    }
  }
}

function readSystemdUserUnitState({
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl("systemctl", [
      "--user",
      "show",
      "--no-pager",
      "--property=LoadState,ActiveState,MainPID",
      SERVICE_UNIT_NAME,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return parseSystemctlShowOutput(output);
  } catch (error) {
    if (isMissingSystemdUnitError(error)) {
      return {
        loaded: false,
        active: false,
        pid: null,
        raw: "",
      };
    }
    return {
      loaded: false,
      active: false,
      pid: null,
      raw: "",
    };
  }
}

function parseSystemctlShowOutput(output) {
  const fields = {};
  const lines = typeof output === "string" ? output.split(/\r?\n/) : [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const mainPid = Number.parseInt(fields.MainPID || "", 10);
  return {
    loaded: fields.LoadState === "loaded",
    active: fields.ActiveState === "active" || fields.ActiveState === "activating",
    pid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null,
    raw: typeof output === "string" ? output : "",
  };
}

function resolveSystemdUserUnitPath({ env = process.env, osImpl = os } = {}) {
  const configHome = normalizeNonEmptyString(env.XDG_CONFIG_HOME)
    || path.join(env.HOME || osImpl.homedir(), ".config");
  return path.join(configHome, "systemd", "user", SERVICE_UNIT_NAME);
}

function systemctlUser(args, { env = process.env, execFileSyncImpl = execFileSync } = {}) {
  return execFileSyncImpl("systemctl", ["--user", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
}

function assertNonDarwinPlatform(platform = process.platform) {
  if (platform === "darwin") {
    throw new Error("Linux bridge service management is not available on macOS. Use the macOS launch agent helpers instead.");
  }
}

function assertRelayConfigured(config) {
  if (typeof config?.relayUrl === "string" && config.relayUrl.trim()) {
    return;
  }
  throw new Error("No relay URL configured. Run ./scripts/run-local-agnt.sh or set AGNT_RELAY before enabling the Linux bridge service.");
}

// systemd-user requires an active user session (`XDG_RUNTIME_DIR` is set when one exists)
// and the systemctl binary on PATH. Headless boxes should run `loginctl enable-linger` first.
function assertSystemdAvailable({ env = process.env, execFileSyncImpl = execFileSync } = {}) {
  if (!normalizeNonEmptyString(env.XDG_RUNTIME_DIR)) {
    throw new Error(
      "systemd user session not detected (XDG_RUNTIME_DIR is unset). "
      + "Log in via PAM/SSH with a user session, or run `loginctl enable-linger $USER` for headless boxes, "
      + "and re-run. To skip the service installer entirely, run `agnt up` (foreground)."
    );
  }

  try {
    execFileSyncImpl("systemctl", ["--user", "--version"], {
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });
  } catch (error) {
    const cause = error && error.message ? `: ${error.message}` : "";
    throw new Error(
      `systemctl --user is not available on this Linux box${cause}. `
      + "Run `agnt up` (foreground) or install systemd-user."
    );
  }
}

function isMissingSystemdUnitError(error) {
  const combined = [
    error?.message,
    error?.stderr?.toString?.("utf8"),
    error?.stdout?.toString?.("utf8"),
  ].filter(Boolean).join("\n").toLowerCase();
  return combined.includes("not loaded")
    || combined.includes("could not be found")
    || combined.includes("no such file or directory")
    || combined.includes("not found");
}

// Distinguishes "no service to manage on this box" (missing unit OR systemctl absent)
// from real systemd errors that should surface to the caller.
function isLinuxBridgeServiceNotInstalledError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "ENOENT") {
    return true;
  }
  return isMissingSystemdUnitError(error);
}

// systemd allows shell-style backslash escapes inside Environment=, ExecStart=, etc.
// Quote and escape so values containing spaces, quotes, or backslashes round-trip safely.
function escapeSystemdValue(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:@,+\-=]+$/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeSystemdExec(value) {
  return escapeSystemdValue(value);
}

function formatSystemdEnv(name, value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:@,+\-=]+$/.test(stringValue)) {
    return `${name}=${stringValue}`;
  }
  return `"${name}=${stringValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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
