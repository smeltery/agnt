const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveAgntStateDir,
  resolveBridgeStderrLogPath,
  resolveBridgeStdoutLogPath,
} = require("../daemon-state");

const SERVICE_LABEL = "com.smeltery.agnt.bridge";

// If the saved Node binary or CLI entrypoint disappears (npm uninstall, deleted
// checkout), exit 0 so launchd's KeepAlive.SuccessfulExit=false stops rescheduling
// the job; `exec` keeps genuine daemon failures non-zero so they still restart.
const LAUNCH_AGENT_GUARD_SCRIPT = 'if [ ! -x "$1" ] || [ ! -f "$2" ]; then exit 0; fi; exec "$1" "$2" run-service';

// Keeps the guard script constant: the installed paths are shell positionals, never interpolated source.
function buildLaunchAgentProgramArguments({ nodePath, cliPath }) {
  return [
    "/bin/sh",
    "-c",
    LAUNCH_AGENT_GUARD_SCRIPT,
    SERVICE_LABEL,
    nodePath,
    cliPath,
  ];
}

function buildLaunchAgentPlist({
  homeDir,
  pathEnv,
  stateDir,
  stdoutLogPath,
  stderrLogPath,
  nodePath,
  cliPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${buildLaunchAgentProgramArguments({ nodePath, cliPath })
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homeDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homeDir)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
    <key>AGNT_DEVICE_STATE_DIR</key>
    <string>${escapeXml(stateDir)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLogPath)}</string>
</dict>
</plist>
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
    `Timed out waiting for the macOS bridge service to publish a pairing QR. `
    + `Check ${resolveBridgeStderrLogPath({ env })}.`
  );
}

function restartLaunchAgent({
  env = process.env,
  execFileSyncImpl = execFileSync,
  plistPath,
} = {}) {
  bootoutLaunchAgent({
    env,
    execFileSyncImpl,
    ignoreMissing: true,
  });
  execFileSyncImpl("launchctl", [
    "bootstrap",
    launchAgentDomain(env),
    plistPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSyncImpl("launchctl", [
    "kickstart",
    "-k",
    launchAgentLabelDomain(env),
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

function bootoutLaunchAgent({
  env = process.env,
  execFileSyncImpl = execFileSync,
  ignoreMissing = false,
} = {}) {
  const bootoutTargets = [
    // Some macOS setups only fully unload the agent when bootout targets the plist path.
    [launchAgentDomain(env), resolveLaunchAgentPlistPath({ env })],
    [launchAgentLabelDomain(env)],
  ];
  let lastError = null;

  for (const targetArgs of bootoutTargets) {
    try {
      execFileSyncImpl("launchctl", [
        "bootout",
        ...targetArgs,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (ignoreMissing && isMissingLaunchAgentError(lastError)) {
    return;
  }
  throw lastError;
}

function readLaunchAgentState({
  env = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl("launchctl", [
      "print",
      launchAgentLabelDomain(env),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      loaded: true,
      pid: parseLaunchdPid(output),
      raw: output,
    };
  } catch (error) {
    if (isMissingLaunchAgentError(error)) {
      return {
        loaded: false,
        pid: null,
        raw: "",
      };
    }
    throw error;
  }
}

function resolveLaunchAgentPlistPath({ env = process.env, osImpl = os } = {}) {
  const homeDir = env.HOME || osImpl.homedir();
  return path.join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function assertDarwinPlatform(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error("macOS bridge service management is only available on macOS.");
  }
}

function assertRelayConfigured(config) {
  if (typeof config?.relayUrl === "string" && config.relayUrl.trim()) {
    return;
  }
  throw new Error("No relay URL configured. Run ./scripts/run-local-agnt.sh or set AGNT_RELAY before enabling the macOS bridge service.");
}

function launchAgentDomain(env) {
  return `gui/${resolveUid(env)}`;
}

function launchAgentLabelDomain(env) {
  return `${launchAgentDomain(env)}/${SERVICE_LABEL}`;
}

function resolveUid(env) {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }

  const uid = Number.parseInt(env.UID || "", 10);
  if (Number.isFinite(uid)) {
    return uid;
  }

  throw new Error("Could not determine the current macOS user id for launchctl.");
}

function parseLaunchdPid(output) {
  const match = typeof output === "string" ? output.match(/\bpid = (\d+)/) : null;
  return match ? Number.parseInt(match[1], 10) : null;
}

function isMissingLaunchAgentError(error) {
  const combined = [
    error?.message,
    error?.stderr?.toString?.("utf8"),
    error?.stdout?.toString?.("utf8"),
  ].filter(Boolean).join("\n").toLowerCase();
  return combined.includes("could not find service")
    || combined.includes("service could not be found")
    || combined.includes("no such process");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  assertDarwinPlatform,
  assertRelayConfigured,
  bootoutLaunchAgent,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  readLaunchAgentState,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  sleep,
};
