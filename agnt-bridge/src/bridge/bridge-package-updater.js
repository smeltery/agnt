// FILE: bridge-package-updater.js
// Purpose: Updates the installed agnt bridge package and schedules a service restart after the RPC response can be delivered.
// Layer: CLI helper
// Exports: createBridgePackageUpdateAndRestart, scheduleBridgeServiceRestartAfterUpdate
// Depends on: child_process, path, util

const { execFile, spawn } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const BRIDGE_PACKAGE_UPDATE_COMMAND = "npm install -g @dotbrains/agnt@latest";
const BRIDGE_PACKAGE_UPDATE_TIMEOUT_MS = 180_000;
const BRIDGE_RESTART_AFTER_UPDATE_DELAY_MS = 750;

function createBridgePackageUpdateAndRestart({
  platform = process.platform,
  executor = execFileAsync,
  spawnImpl = spawn,
  setTimeoutFn = setTimeout,
  env = process.env,
  execPath = process.execPath,
  cliPath = path.join(__dirname, "..", "..", "bin", "agnt.js"),
  logger = console,
  updateCommand = BRIDGE_PACKAGE_UPDATE_COMMAND,
  updateTimeoutMs = BRIDGE_PACKAGE_UPDATE_TIMEOUT_MS,
  restartDelayMs = BRIDGE_RESTART_AFTER_UPDATE_DELAY_MS,
} = {}) {
  return async function updateBridgePackageAndRestart() {
    if (platform !== "darwin") {
      throw bridgeUpdateError(
        "unsupported_platform",
        "Bridge self-update is available only for the macOS bridge service."
      );
    }

    try {
      await executor("/bin/zsh", [
        "-lc",
        [
          "export TERM=dumb",
          "source ~/.zshrc >/dev/null 2>/dev/null || true",
          updateCommand,
        ].join("; "),
      ], {
        timeout: updateTimeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      throw bridgeUpdateError(
        "bridge_update_failed",
        truncateCommandOutput(error?.stderr || error?.stdout || error?.message)
          || "Could not update the agnt bridge package on this Mac.",
        error
      );
    }

    scheduleBridgeServiceRestartAfterUpdate({
      spawnImpl,
      setTimeoutFn,
      env,
      execPath,
      cliPath,
      logger,
      restartDelayMs,
    });

    return {
      success: true,
      command: updateCommand,
      restartScheduled: true,
      restartDelayMs,
    };
  };
}

function scheduleBridgeServiceRestartAfterUpdate({
  spawnImpl = spawn,
  setTimeoutFn = setTimeout,
  env = process.env,
  execPath = process.execPath,
  cliPath = path.join(__dirname, "..", "..", "bin", "agnt.js"),
  logger = console,
  restartDelayMs = BRIDGE_RESTART_AFTER_UPDATE_DELAY_MS,
} = {}) {
  const restartTimer = setTimeoutFn(() => {
    const child = spawnImpl(execPath, [cliPath, "restart"], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child?.on?.("error", (error) => {
      logger.warn?.(`[agnt] Failed to schedule the post-update bridge restart: ${error?.message || error}`);
    });
    child?.unref?.();
  }, restartDelayMs);
  restartTimer?.unref?.();
  return restartTimer;
}

function bridgeUpdateError(code, message, cause = null) {
  const error = new Error(message);
  error.errorCode = code;
  error.userMessage = message;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function truncateCommandOutput(value, limit = 1_200) {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

module.exports = {
  BRIDGE_PACKAGE_UPDATE_COMMAND,
  BRIDGE_RESTART_AFTER_UPDATE_DELAY_MS,
  createBridgePackageUpdateAndRestart,
  scheduleBridgeServiceRestartAfterUpdate,
};
