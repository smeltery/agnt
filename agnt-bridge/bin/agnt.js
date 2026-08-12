#!/usr/bin/env node
// FILE: agnt.js
// Purpose: CLI surface for foreground bridge runs, pairing reset, thread resume, and macOS/Linux service control.
// Layer: CLI binary
// Exports: none
// Depends on: ../src

const {
  getMacOSBridgeServiceStatus,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  readBridgeConfig,
  resetMacOSBridgePairing,
  runMacOSBridgeService,
  startBridge,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
  getLinuxBridgeServiceStatus,
  isLinuxBridgeServiceNotInstalledError,
  printLinuxBridgePairingQr,
  printLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  runLinuxBridgeService,
  startLinuxBridgeService,
  stopLinuxBridgeService,
  resetBridgePairing,
  openLastActiveThread,
  watchThreadRollout,
} = require("../src/index");
const { version } = require("../package.json");

const defaultDeps = {
  getMacOSBridgeServiceStatus,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  readBridgeConfig,
  resetMacOSBridgePairing,
  runMacOSBridgeService,
  startBridge,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
  getLinuxBridgeServiceStatus,
  printLinuxBridgePairingQr,
  printLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  runLinuxBridgeService,
  startLinuxBridgeService,
  stopLinuxBridgeService,
  resetBridgePairing,
  openLastActiveThread,
  watchThreadRollout,
};

if (require.main === module) {
  void runCli();
}

// ─── ENTRY POINT ─────────────────────────────────────────────

async function main({
  argv = process.argv,
  platform = process.platform,
  consoleImpl = console,
  exitImpl = process.exit,
  deps = defaultDeps,
} = {}) {
  const { command, jsonOutput, watchThreadId, providerId } = parseCliArgs(argv.slice(2));

  if (isVersionCommand(command)) {
    emitVersion({ jsonOutput, consoleImpl });
    return;
  }

  if (command === "up") {
    if (platform === "darwin") {
      consoleImpl.log("[agnt] Starting bridge and pairing QR...");
      const result = await deps.startMacOSBridgeService({
        waitForPairing: true,
        providerId,
      });
      deps.printMacOSBridgePairingQr({
        pairingSession: result.pairingSession,
      });
      return;
    }

    if (platform === "linux" && canUseLinuxBridgeService(consoleImpl)) {
      consoleImpl.log("[agnt] Starting bridge and pairing QR...");
      try {
        const result = await deps.startLinuxBridgeService({
          waitForPairing: true,
          providerId,
        });
        deps.printLinuxBridgePairingQr({
          pairingSession: result.pairingSession,
        });
        return;
      } catch (error) {
        consoleImpl.warn(
          `[agnt] systemd-user service unavailable (${(error && error.message) || "unknown error"}). `
          + "Falling back to foreground bridge."
        );
      }
    }

    deps.startBridge({ providerId });
    return;
  }

  if (command === "run") {
    deps.startBridge({ providerId });
    return;
  }

  if (command === "run-service") {
    if (platform === "darwin") {
      deps.runMacOSBridgeService();
      return;
    }
    deps.runLinuxBridgeService();
    return;
  }

  if (command === "start") {
    assertServiceCommand(command, { platform, consoleImpl, exitImpl });
    deps.readBridgeConfig();
    const result = platform === "darwin"
      ? await deps.startMacOSBridgeService({ waitForPairing: false, providerId })
      : await deps.startLinuxBridgeService({ waitForPairing: false, providerId });
    emitResult({
      payload: {
        ok: true,
        currentVersion: version,
        plistPath: result?.plistPath,
        unitPath: result?.unitPath,
        pairingSession: sanitizePairingSessionForOutput(result?.pairingSession),
      },
      message: platform === "darwin"
        ? "[agnt] macOS bridge service is running."
        : "[agnt] Linux bridge service is running.",
      jsonOutput,
      consoleImpl,
    });
    return;
  }

  if (command === "restart") {
    assertServiceCommand(command, { platform, consoleImpl, exitImpl });
    deps.readBridgeConfig();
    const result = platform === "darwin"
      ? await deps.startMacOSBridgeService({ waitForPairing: false, providerId })
      : await deps.startLinuxBridgeService({ waitForPairing: false, providerId });
    emitResult({
      payload: {
        ok: true,
        currentVersion: version,
        plistPath: result?.plistPath,
        unitPath: result?.unitPath,
        pairingSession: sanitizePairingSessionForOutput(result?.pairingSession),
      },
      message: platform === "darwin"
        ? "[agnt] macOS bridge service restarted."
        : "[agnt] Linux bridge service restarted.",
      jsonOutput,
      consoleImpl,
    });
    return;
  }

  if (command === "stop") {
    assertServiceCommand(command, { platform, consoleImpl, exitImpl });
    if (platform === "darwin") {
      deps.stopMacOSBridgeService();
    } else {
      deps.stopLinuxBridgeService();
    }
    emitResult({
      payload: {
        ok: true,
        currentVersion: version,
      },
      message: platform === "darwin"
        ? "[agnt] macOS bridge service stopped."
        : "[agnt] Linux bridge service stopped.",
      jsonOutput,
      consoleImpl,
    });
    return;
  }

  if (command === "uninstall-service") {
    assertMacOSOnlyCommand(command, { platform, consoleImpl, exitImpl });
    const result = deps.uninstallMacOSBridgeService();
    emitResult({
      payload: {
        ok: true,
        currentVersion: version,
        plistPath: result?.plistPath,
        removed: result?.removed,
      },
      message: "[agnt] Removed the macOS bridge service. You can now run `npm uninstall -g @dotbrains/agnt`.",
      jsonOutput,
      consoleImpl,
    });
    return;
  }

  if (command === "qr" || command === "pair" || command === "connect") {
    assertServiceCommand(command, { platform, consoleImpl, exitImpl });
    const result = platform === "darwin"
      ? await deps.startMacOSBridgeService({ waitForPairing: true, providerId })
      : await deps.startLinuxBridgeService({ waitForPairing: true, providerId });

    if (jsonOutput) {
      emitJson({
        ok: true,
        currentVersion: version,
        plistPath: result?.plistPath,
        unitPath: result?.unitPath,
        pairingSession: sanitizePairingSessionForOutput(result?.pairingSession),
      });
      return;
    }

    consoleImpl.log(command === "connect"
      ? "[agnt] Connecting this machine with a fresh pairing QR..."
      : "[agnt] Refreshing bridge pairing QR...");
    if (platform === "darwin") {
      deps.printMacOSBridgePairingQr({ pairingSession: result.pairingSession });
    } else {
      deps.printLinuxBridgePairingQr({ pairingSession: result.pairingSession });
    }
    return;
  }

  if (command === "status") {
    assertServiceCommand(command, { platform, consoleImpl, exitImpl });
    if (jsonOutput) {
      emitJson({
        ...sanitizeBridgeServiceStatusForOutput(platform === "darwin"
          ? deps.getMacOSBridgeServiceStatus()
          : deps.getLinuxBridgeServiceStatus()),
        currentVersion: version,
      });
      return;
    }
    if (platform === "darwin") {
      deps.printMacOSBridgeServiceStatus();
    } else {
      deps.printLinuxBridgeServiceStatus();
    }
    return;
  }

  if (command === "reset-pairing") {
    try {
      if (platform === "darwin") {
        deps.resetMacOSBridgePairing();
        emitResult({
          payload: {
            ok: true,
            currentVersion: version,
            platform: "darwin",
          },
          message: "[agnt] Stopped the macOS bridge service and cleared the saved pairing state. Run `agnt up` to pair again.",
          jsonOutput,
          consoleImpl,
        });
      } else if (platform === "linux") {
        try {
          deps.resetLinuxBridgePairing();
          emitResult({
            payload: {
              ok: true,
              currentVersion: version,
              platform: "linux",
            },
            message: "[agnt] Stopped the Linux bridge service and cleared the saved pairing state. Run `agnt up` to pair again.",
            jsonOutput,
            consoleImpl,
          });
        } catch (innerError) {
          // Only fall back to a file-only reset when systemd has nothing to manage on this box.
          // Real systemd errors (`systemctl` permission denied, dbus failure, etc.) must surface.
          if (!isLinuxBridgeServiceNotInstalledError(innerError)) {
            throw innerError;
          }
          deps.resetBridgePairing();
          emitResult({
            payload: {
              ok: true,
              currentVersion: version,
              platform: "linux",
            },
            message: "[agnt] Cleared the saved pairing state. Run `agnt up` to pair again.",
            jsonOutput,
            consoleImpl,
          });
        }
      } else {
        deps.resetBridgePairing();
        emitResult({
          payload: {
            ok: true,
            currentVersion: version,
            platform,
          },
          message: "[agnt] Cleared the saved pairing state. Run `agnt up` to pair again.",
          jsonOutput,
          consoleImpl,
        });
      }
    } catch (error) {
      consoleImpl.error(`[agnt] ${(error && error.message) || "Failed to clear the saved pairing state."}`);
      exitImpl(1);
    }
    return;
  }

  if (command === "resume") {
    try {
      const state = deps.openLastActiveThread();
      emitResult({
        payload: {
          ok: true,
          currentVersion: version,
          threadId: state.threadId,
          source: state.source || "unknown",
        },
        message: `[agnt] Opened last active thread: ${state.threadId} (${state.source || "unknown"})`,
        jsonOutput,
        consoleImpl,
      });
    } catch (error) {
      consoleImpl.error(`[agnt] ${(error && error.message) || "Failed to reopen the last thread."}`);
      exitImpl(1);
    }
    return;
  }

  if (command === "watch") {
    try {
      deps.watchThreadRollout(watchThreadId);
    } catch (error) {
      consoleImpl.error(`[agnt] ${(error && error.message) || "Failed to watch the thread rollout."}`);
      exitImpl(1);
    }
    return;
  }

  consoleImpl.error(`Unknown command: ${command}`);
  consoleImpl.error(
    "Usage: agnt up | agnt run | agnt connect | agnt qr | agnt pair | agnt start | agnt restart | agnt stop | agnt uninstall-service | agnt status | "
    + "agnt reset-pairing | agnt resume | agnt watch [threadId] | agnt --version | "
    + "append --json to connect/qr/pair/start/restart/stop/uninstall-service/status/reset-pairing/resume for machine-readable output"
  );
  exitImpl(1);
}

async function runCli({
  mainImpl = main,
  consoleImpl = console,
  exitImpl = process.exit,
} = {}) {
  try {
    await mainImpl({ consoleImpl, exitImpl });
  } catch (error) {
    consoleImpl.error(`[agnt] ${(error && error.message) || "Unexpected failure."}`);
    exitImpl(1);
  }
}

function parseCliArgs(rawArgs) {
  const positionals = [];
  let jsonOutput = false;
  let providerId = "";

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg === "--provider" || arg === "-p") {
      providerId = rawArgs[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providerId = arg.slice("--provider=".length);
      continue;
    }
    positionals.push(arg);
  }

  return {
    command: positionals[0] || "up",
    jsonOutput,
    watchThreadId: positionals[1] || "",
    providerId,
  };
}

function emitVersion({
  jsonOutput = false,
  consoleImpl = console,
} = {}) {
  if (jsonOutput) {
    emitJson({
      currentVersion: version,
    });
    return;
  }

  consoleImpl.log(version);
}

function emitResult({
  payload,
  message,
  jsonOutput = false,
  consoleImpl = console,
} = {}) {
  if (jsonOutput) {
    emitJson(payload);
    return;
  }

  consoleImpl.log(message);
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function sanitizeBridgeServiceStatusForOutput(status = {}) {
  return {
    ...status,
    daemonConfig: sanitizeDaemonConfigForOutput(status.daemonConfig),
    pairingSession: sanitizePairingSessionForOutput(status.pairingSession),
  };
}

function sanitizeDaemonConfigForOutput(config) {
  if (!config || typeof config !== "object") {
    return config || null;
  }

  const { relayUrl, pushServiceUrl, ...rest } = config;
  return {
    ...rest,
    relayConfigured: Boolean(relayUrl),
    pushServiceConfigured: Boolean(pushServiceUrl),
  };
}

function sanitizePairingSessionForOutput(pairingSession) {
  if (!pairingSession || typeof pairingSession !== "object") {
    return pairingSession || null;
  }

  const payload = pairingSession.pairingPayload || {};
  return {
    createdAt: pairingSession.createdAt,
    pairingCode: pairingSession.pairingCode,
    pairingPayload: {
      v: payload.v,
      expiresAt: payload.expiresAt,
      hasRelay: Boolean(payload.relay),
      hasSessionId: Boolean(payload.sessionId),
      hasMacIdentityPublicKey: Boolean(payload.macIdentityPublicKey),
      displayName: payload.displayName,
    },
  };
}

function assertServiceCommand(name, {
  platform = process.platform,
  consoleImpl = console,
  exitImpl = process.exit,
} = {}) {
  if (platform === "darwin" || platform === "linux") {
    return;
  }

  consoleImpl.error(`[agnt] \`${name}\` is only available on macOS or Linux. Use \`agnt up\` or \`agnt run\` for the foreground bridge on this OS.`);
  exitImpl(1);
}

// `uninstall-service` only has a launchd implementation today; Linux service removal
// is not yet wired up, so it stays macOS-only rather than silently no-op-ing there.
function assertMacOSOnlyCommand(name, {
  platform = process.platform,
  consoleImpl = console,
  exitImpl = process.exit,
} = {}) {
  if (platform === "darwin") {
    return;
  }

  consoleImpl.error(`[agnt] \`${name}\` is only available on macOS. Use \`agnt up\` or \`agnt run\` for the foreground bridge on this OS.`);
  exitImpl(1);
}

// Cheap pre-check so we can fall back to foreground when a Linux box has no user systemd.
function canUseLinuxBridgeService(consoleImpl = console) {
  if (process.platform !== "linux") {
    return false;
  }
  if (!process.env.XDG_RUNTIME_DIR || !process.env.XDG_RUNTIME_DIR.trim()) {
    return false;
  }
  try {
    require("child_process").execFileSync("systemctl", ["--user", "--version"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function isVersionCommand(value) {
  return value === "-v" || value === "--v" || value === "-V" || value === "--version" || value === "version";
}

module.exports = {
  isVersionCommand,
  main,
  runCli,
  sanitizeBridgeServiceStatusForOutput,
  sanitizeDaemonConfigForOutput,
  sanitizePairingSessionForOutput,
};
