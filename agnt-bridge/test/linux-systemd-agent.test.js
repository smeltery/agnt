// FILE: linux-systemd-agent.test.js
// Purpose: Verifies systemd-user unit generation and Linux service cleanup helpers.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/linux-systemd-agent, ../src/daemon-state

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildSystemdUserUnit,
  getLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  resolveSystemdUserUnitPath,
  startLinuxBridgeService,
  stopLinuxBridgeService,
} = require("../src/linux-systemd-agent");
const {
  writeDaemonConfig,
  readBridgeStatus,
  readPairingSession,
  writeBridgeStatus,
  writePairingSession,
} = require("../src/daemon-state");

test("buildSystemdUserUnit points systemd at run-service with agnt state paths", () => {
  const unit = buildSystemdUserUnit({
    homeDir: "/home/tester",
    pathEnv: "/usr/local/bin:/usr/bin",
    stateDir: "/home/tester/.agnt",
    stdoutLogPath: "/home/tester/.agnt/logs/bridge.stdout.log",
    stderrLogPath: "/home/tester/.agnt/logs/bridge.stderr.log",
    nodePath: "/usr/local/bin/node",
    cliPath: "/tmp/agnt/bin/agnt.js",
  });

  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Type=simple/);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/tmp\/agnt\/bin\/agnt\.js run-service/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /Environment=HOME=\/home\/tester/);
  assert.match(unit, /Environment=AGNT_DEVICE_STATE_DIR=\/home\/tester\/\.agnt/);
  assert.match(unit, /StandardOutput=append:\/home\/tester\/\.agnt\/logs\/bridge\.stdout\.log/);
  assert.match(unit, /StandardError=append:\/home\/tester\/\.agnt\/logs\/bridge\.stderr\.log/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("buildSystemdUserUnit quotes values with spaces or special characters", () => {
  const unit = buildSystemdUserUnit({
    homeDir: "/home/test user",
    pathEnv: "/opt/with spaces:/usr/bin",
    stateDir: "/home/test user/.agnt",
    stdoutLogPath: "/home/test user/.agnt/logs/bridge.stdout.log",
    stderrLogPath: "/home/test user/.agnt/logs/bridge.stderr.log",
    nodePath: "/usr/local/bin/node",
    cliPath: "/tmp/agnt/bin/agnt.js",
  });

  assert.match(unit, /WorkingDirectory="\/home\/test user"/);
  assert.match(unit, /Environment="HOME=\/home\/test user"/);
  assert.match(unit, /Environment="PATH=\/opt\/with spaces:\/usr\/bin"/);
});

test("resolveSystemdUserUnitPath uses XDG_CONFIG_HOME when set", () => {
  assert.equal(
    resolveSystemdUserUnitPath({
      env: { HOME: "/home/tester", XDG_CONFIG_HOME: "/home/tester/.xdg" },
      osImpl: { homedir: () => "/home/fallback" },
    }),
    path.join("/home/tester/.xdg", "systemd", "user", "com.dotbrains.agnt.bridge.service")
  );
});

test("resolveSystemdUserUnitPath falls back to ~/.config/systemd/user", () => {
  assert.equal(
    resolveSystemdUserUnitPath({
      env: { HOME: "/home/tester" },
      osImpl: { homedir: () => "/home/fallback" },
    }),
    path.join("/home/tester", ".config", "systemd", "user", "com.dotbrains.agnt.bridge.service")
  );
});

test("stopLinuxBridgeService clears stale pairing and status files", () => {
  withTempDaemonEnv(() => {
    writePairingSession({ sessionId: "session-linux" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected" });

    stopLinuxBridgeService({
      platform: "linux",
      execFileSyncImpl() {
        const error = new Error("Unit not loaded");
        error.stderr = Buffer.from("Unit not loaded");
        throw error;
      },
    });

    assert.equal(readPairingSession(), null);
    assert.equal(readBridgeStatus(), null);
  });
});

test("startLinuxBridgeService writes a unit, daemon-reloads, and restarts the service", () => {
  withTempDaemonEnv(({ rootDir }) => {
    const calls = [];
    const env = {
      HOME: rootDir,
      AGNT_DEVICE_STATE_DIR: rootDir,
      AGNT_RELAY: "ws://127.0.0.1:9000/relay",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CONFIG_HOME: path.join(rootDir, ".config"),
    };

    startLinuxBridgeService({
      env,
      platform: "linux",
      waitForPairing: false,
      execFileSyncImpl(command, args) {
        calls.push([command, args[0], args[1], args[2]]);
        return "";
      },
    });

    // First the systemd availability probe, then daemon-reload + restart.
    assert.deepEqual(calls, [
      ["systemctl", "--user", "--version", undefined],
      ["systemctl", "--user", "daemon-reload", undefined],
      ["systemctl", "--user", "restart", "com.dotbrains.agnt.bridge.service"],
    ]);
    assert.ok(
      fs.existsSync(path.join(rootDir, ".config", "systemd", "user", "com.dotbrains.agnt.bridge.service")),
      "expected unit file to be written under XDG_CONFIG_HOME"
    );
  });
});

test("startLinuxBridgeService refuses to run when XDG_RUNTIME_DIR is missing", async () => {
  await withTempDaemonEnvAsync(async ({ rootDir }) => {
    await assert.rejects(
      () => startLinuxBridgeService({
        env: {
          HOME: rootDir,
          AGNT_DEVICE_STATE_DIR: rootDir,
          AGNT_RELAY: "ws://127.0.0.1:9000/relay",
        },
        platform: "linux",
        execFileSyncImpl() {
          throw new Error("should not be called");
        },
      }),
      /XDG_RUNTIME_DIR/
    );
  });
});

test("resetLinuxBridgePairing stops the daemon before revoking persisted trust", () => {
  withTempDaemonEnv(() => {
    writePairingSession({ sessionId: "session-reset" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected" });

    let stopCalls = 0;
    let resetCalls = 0;
    const result = resetLinuxBridgePairing({
      platform: "linux",
      execFileSyncImpl() {
        stopCalls += 1;
        const error = new Error("Unit not found");
        error.stderr = Buffer.from("Unit not found");
        throw error;
      },
      resetBridgePairingImpl() {
        resetCalls += 1;
        return { hadState: true };
      },
    });

    assert.equal(stopCalls, 1);
    assert.equal(resetCalls, 1);
    assert.equal(result.hadState, true);
    assert.equal(readPairingSession(), null);
    assert.equal(readBridgeStatus(), null);
  });
});

test("getLinuxBridgeServiceStatus reports systemd metadata together with bridge runtime state", () => {
  withTempDaemonEnv(({ rootDir }) => {
    writeDaemonConfig({ relayUrl: "ws://127.0.0.1:9000/relay" });
    writePairingSession({ sessionId: "session-status" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected", pid: 77 });

    const unitPath = path.join(rootDir, ".config", "systemd", "user", "com.dotbrains.agnt.bridge.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "ignored");

    const status = getLinuxBridgeServiceStatus({
      platform: "linux",
      env: {
        HOME: rootDir,
        AGNT_DEVICE_STATE_DIR: rootDir,
        XDG_CONFIG_HOME: path.join(rootDir, ".config"),
      },
      execFileSyncImpl() {
        return "LoadState=loaded\nActiveState=active\nMainPID=77\n";
      },
    });

    assert.equal(status.installed, true);
    assert.equal(status.systemdLoaded, true);
    assert.equal(status.systemdActive, true);
    assert.equal(status.systemdPid, 77);
    assert.equal(status.daemonConfig?.relayUrl, "ws://127.0.0.1:9000/relay");
    assert.equal(status.bridgeStatus?.connectionStatus, "connected");
    assert.equal(status.pairingSession?.pairingPayload?.sessionId, "session-status");
  });
});

test("stopLinuxBridgeService SIGTERMs an orphan agnt run-service recorded in bridge-status.json", () => {
  withTempDaemonEnv(() => {
    writeBridgeStatus({ state: "running", connectionStatus: "connected", pid: 9999 });

    const killed = [];
    stopLinuxBridgeService({
      platform: "linux",
      execFileSyncImpl(command, args) {
        if (command === "ps") {
          assert.deepEqual(args, ["-p", "9999", "-o", "command="]);
          return "node /usr/local/bin/agnt run-service";
        }
        return "";
      },
      processImpl: {
        pid: process.pid,
        kill(pid, signal) {
          killed.push([pid, signal]);
        },
      },
    });

    assert.deepEqual(killed, [[9999, "SIGTERM"]]);
    assert.equal(readBridgeStatus(), null);
  });
});

test("stopLinuxBridgeService refuses to run on macOS", () => {
  assert.throws(
    () => stopLinuxBridgeService({
      platform: "darwin",
      execFileSyncImpl() { return ""; },
    }),
    /not available on macOS/
  );
});

function withTempDaemonEnv(run) {
  const restore = setupTempDaemonEnv();
  try {
    return run({ rootDir: restore.rootDir });
  } finally {
    restore.cleanup();
  }
}

async function withTempDaemonEnvAsync(run) {
  const restore = setupTempDaemonEnv();
  try {
    return await run({ rootDir: restore.rootDir });
  } finally {
    restore.cleanup();
  }
}

function setupTempDaemonEnv() {
  const previousDir = process.env.AGNT_DEVICE_STATE_DIR;
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-systemd-agent-"));
  process.env.AGNT_DEVICE_STATE_DIR = rootDir;
  process.env.HOME = rootDir;
  process.env.XDG_CONFIG_HOME = path.join(rootDir, ".config");

  return {
    rootDir,
    cleanup() {
      if (previousDir === undefined) {
        delete process.env.AGNT_DEVICE_STATE_DIR;
      } else {
        process.env.AGNT_DEVICE_STATE_DIR = previousDir;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg;
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
