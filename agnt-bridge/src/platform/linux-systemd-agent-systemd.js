const os = require("os");
const path = require("path");

const SERVICE_LABEL = "com.dotbrains.agnt.bridge";
const SERVICE_UNIT_NAME = `${SERVICE_LABEL}.service`;

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
};
