// FILE: wake-assertion.js
// Purpose: Holds a single host idle-sleep assertion for as long as the bridge
//          process stays alive. macOS uses `caffeinate -i -w <pid>`; Linux
//          uses `systemd-inhibit --what=idle:sleep` when a D-Bus session is
//          reachable and `systemd-inhibit` is on PATH. Returns a no-op
//          controller on any other platform (or when neither tool is usable)
//          so callers don't have to branch.
// Layer: bridge utility — pure, no closure deps on bridge.js.
// Exports: createMacOSBridgeWakeAssertion, resolveWakeAssertionCommand,
//          hasSystemdInhibit
//
// Why a module: this used to sit at module scope inside bridge.js, mixed in
// with relay-loop helpers. It has no implicit coupling to anything else
// there — `createMacOSBridgeWakeAssertion` takes spawn / console / env via
// parameters and returns a self-contained controller — so lifting it gives
// the bridge a smaller surface and a more honest module name.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function createMacOSBridgeWakeAssertion({
  platform = process.platform,
  pid = process.pid,
  spawnImpl = spawn,
  consoleImpl = console,
  enabled = true,
  envImpl = process.env,
} = {}) {
  const command = resolveWakeAssertionCommand({ platform, pid, envImpl });
  if (!command) {
    return {
      active: false,
      enabled: false,
      setEnabled() {
        return { active: false, enabled: false };
      },
      stop() {},
    };
  }

  let desiredEnabled = Boolean(enabled);
  let child = null;

  function stop() {
    if (!child || child.killed || typeof child.kill !== "function") {
      child = null;
      return;
    }

    try {
      child.kill();
    } catch {}
    child = null;
  }

  function start() {
    if (!desiredEnabled || child) {
      return;
    }

    try {
      const nextChild = spawnImpl(command.bin, command.args, {
        stdio: "ignore",
      });

      nextChild.on?.("error", (error) => {
        consoleImpl.warn(`[agnt] Failed to hold the host awake while the bridge is active: ${error.message}`);
      });
      nextChild.on?.("exit", () => {
        if (child === nextChild) {
          child = null;
        }
      });
      nextChild.unref?.();
      child = nextChild;
    } catch (error) {
      consoleImpl.warn(
        `[agnt] Failed to start the bridge wake assertion: ${(error && error.message) || "unknown error"}`
      );
      child = null;
    }
  }

  function setEnabled(nextEnabled) {
    desiredEnabled = Boolean(nextEnabled);
    if (desiredEnabled) {
      start();
    } else {
      stop();
    }

    return {
      active: Boolean(child && !child.killed),
      enabled: desiredEnabled,
    };
  }

  start();

  return {
    get active() {
      return Boolean(child && !child.killed);
    },
    get enabled() {
      return desiredEnabled;
    },
    setEnabled,
    stop,
  };
}

function resolveWakeAssertionCommand({ platform, pid, envImpl }) {
  if (platform === "darwin") {
    return {
      bin: "/usr/bin/caffeinate",
      args: ["-i", "-w", String(pid)],
    };
  }
  if (platform === "linux" && hasSystemdInhibit({ envImpl })) {
    // `--who/--why` are advisory labels surfaced by `systemd-inhibit --list`.
    // `sleep infinity` keeps the inhibitor alive until the bridge exits and reaps the child.
    return {
      bin: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=agnt",
        "--why=agnt bridge keeps the host reachable while paired",
        "--mode=block",
        "sleep",
        "infinity",
      ],
    };
  }
  return null;
}

function hasSystemdInhibit({ envImpl = process.env } = {}) {
  const envPath = typeof envImpl?.PATH === "string" ? envImpl.PATH : process.env.PATH || "";
  if (!envPath) {
    return false;
  }
  // Only consider the inhibitor available when a user/system D-Bus session is reachable;
  // otherwise the spawn would just print "Failed to inhibit" and exit immediately.
  if (!envImpl?.XDG_RUNTIME_DIR && !envImpl?.DBUS_SESSION_BUS_ADDRESS) {
    return false;
  }
  // Inexpensive PATH probe — avoids spawning when systemd is not installed.
  try {
    for (const segment of envPath.split(":")) {
      if (!segment) {
        continue;
      }
      const candidate = path.join(segment, "systemd-inhibit");
      if (fs.existsSync(candidate)) {
        return true;
      }
    }
  } catch {}
  return false;
}

module.exports = {
  createMacOSBridgeWakeAssertion,
  resolveWakeAssertionCommand,
  hasSystemdInhibit,
};
