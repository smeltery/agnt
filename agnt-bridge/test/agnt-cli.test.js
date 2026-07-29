// FILE: agnt-cli.test.js
// Purpose: Verifies the public CLI exposes version, service control, and machine-readable status output.
// Layer: Integration-lite test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, child_process, path, ../package.json, ../bin/agnt

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");
const { version } = require("../package.json");
const { main, runCli } = require("../bin/agnt");

test("agnt --version prints the package version", () => {
  const cliPath = path.join(__dirname, "..", "bin", "agnt.js");
  const output = execFileSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf8",
  }).trim();

  assert.equal(output, version);
});

test("agnt restart reuses the macOS service start flow", async () => {
  const calls = [];
  const messages = [];

  await main({
    argv: ["node", "agnt", "restart"],
    platform: "darwin",
    consoleImpl: {
      log(message) {
        messages.push(message);
      },
      error(message) {
        messages.push(message);
      },
    },
    exitImpl(code) {
      throw new Error(`unexpected exit ${code}`);
    },
    deps: {
      readBridgeConfig() {
        calls.push("read-config");
      },
      async startMacOSBridgeService(options) {
        calls.push(["start-service", options]);
        return {
          plistPath: "/tmp/agnt.plist",
          pairingSession: { relay: "ws://127.0.0.1:9000/relay" },
        };
      },
    },
  });

  assert.deepEqual(calls, [
    "read-config",
    ["start-service", { waitForPairing: false, providerId: "" }],
  ]);
  assert.deepEqual(messages, [
    "[agnt] macOS bridge service restarted.",
  ]);
});

test("agnt up shows a startup indicator while waiting for the pairing QR", async () => {
  const calls = [];
  const messages = [];

  await main({
    argv: ["node", "agnt", "up"],
    platform: "darwin",
    consoleImpl: {
      log(message) {
        messages.push(message);
      },
      error(message) {
        messages.push(message);
      },
    },
    exitImpl(code) {
      throw new Error(`unexpected exit ${code}`);
    },
    deps: {
      async startMacOSBridgeService(options) {
        calls.push(["start-service", options]);
        return {
          pairingSession: { pairingPayload: { sessionId: "session-up" } },
        };
      },
      printMacOSBridgePairingQr(options) {
        calls.push(["print-qr", options]);
      },
    },
  });

  assert.deepEqual(messages, [
    "[agnt] Starting bridge and pairing QR...",
  ]);
  assert.deepEqual(calls, [
    ["start-service", { waitForPairing: true, providerId: "" }],
    ["print-qr", { pairingSession: { pairingPayload: { sessionId: "session-up" } } }],
  ]);
});

test("agnt status --json redacts live pairing metadata for companion apps", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await main({
      argv: ["node", "agnt", "status", "--json"],
      platform: "darwin",
      consoleImpl: {
        log() {},
        error(message) {
          throw new Error(`unexpected error: ${message}`);
        },
      },
      exitImpl(code) {
        throw new Error(`unexpected exit ${code}`);
      },
      deps: {
        getMacOSBridgeServiceStatus() {
          return {
            daemonConfig: {
              relayUrl: "ws://127.0.0.1:9000/relay",
              pushServiceUrl: "https://push.local",
              keepMacAwake: true,
            },
            bridgeStatus: {
              connectionStatus: "connected",
              pid: 77,
            },
            pairingSession: {
              pairingPayload: {
                relay: "ws://127.0.0.1:9000/relay",
                sessionId: "session-json",
                macIdentityPublicKey: "pubkey-json",
                displayName: "Nick's Mac",
              },
            },
          };
        },
        printMacOSBridgeServiceStatus() {
          throw new Error("status printer should not run for --json");
        },
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(writes.join("").trim());
  assert.equal(payload.currentVersion, version);
  assert.equal(payload.daemonConfig?.relayUrl, undefined);
  assert.equal(payload.daemonConfig?.pushServiceUrl, undefined);
  assert.equal(payload.daemonConfig?.relayConfigured, true);
  assert.equal(payload.daemonConfig?.pushServiceConfigured, true);
  assert.equal(payload.daemonConfig?.keepMacAwake, true);
  assert.equal(payload.bridgeStatus?.connectionStatus, "connected");
  assert.equal(payload.pairingSession?.pairingPayload?.relay, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.sessionId, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.macIdentityPublicKey, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.hasRelay, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasSessionId, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasMacIdentityPublicKey, true);
  assert.equal(payload.pairingSession?.pairingPayload?.displayName, "Nick's Mac");
});

test("agnt qr refreshes a service pairing session and prints the QR", async () => {
  const calls = [];
  const messages = [];
  const pairingSession = {
    pairingPayload: { sessionId: "session-qr" },
  };

  await main({
    argv: ["node", "agnt", "qr"],
    platform: "linux",
    consoleImpl: {
      log(message) { messages.push(message); },
      error(message) { throw new Error(`unexpected error: ${message}`); },
    },
    exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
    deps: {
      async startLinuxBridgeService(options) {
        calls.push(["start-service", options]);
        return { unitPath: "/tmp/agnt.service", pairingSession };
      },
      printLinuxBridgePairingQr(options) {
        calls.push(["print-qr", options]);
      },
    },
  });

  assert.deepEqual(messages, ["[agnt] Refreshing bridge pairing QR..."]);
  assert.deepEqual(calls, [
    ["start-service", { waitForPairing: true, providerId: "" }],
    ["print-qr", { pairingSession }],
  ]);
});

test("agnt connect starts a service pairing session and prints the QR", async () => {
  const calls = [];
  const messages = [];
  const pairingSession = {
    pairingPayload: { sessionId: "session-connect" },
  };

  await main({
    argv: ["node", "agnt", "connect", "--provider", "cursor"],
    platform: "darwin",
    consoleImpl: {
      log(message) { messages.push(message); },
      error(message) { throw new Error(`unexpected error: ${message}`); },
    },
    exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
    deps: {
      async startMacOSBridgeService(options) {
        calls.push(["start-service", options]);
        return { plistPath: "/tmp/agnt.plist", pairingSession };
      },
      printMacOSBridgePairingQr(options) {
        calls.push(["print-qr", options]);
      },
    },
  });

  assert.deepEqual(messages, ["[agnt] Connecting this machine with a fresh pairing QR..."]);
  assert.deepEqual(calls, [
    ["start-service", { waitForPairing: true, providerId: "cursor" }],
    ["print-qr", { pairingSession }],
  ]);
});

test("agnt pair --json redacts the live pairing session", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await main({
      argv: ["node", "agnt", "pair", "--json", "--provider=codex"],
      platform: "darwin",
      consoleImpl: {
        log() {},
        error(message) { throw new Error(`unexpected error: ${message}`); },
      },
      exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
      deps: {
        async startMacOSBridgeService(options) {
          assert.deepEqual(options, { waitForPairing: true, providerId: "codex" });
          return {
            plistPath: "/tmp/agnt.plist",
            pairingSession: {
              createdAt: "2026-07-09T12:00:00.000Z",
              pairingCode: "ABCDEFGHJK",
              pairingPayload: {
                v: 1,
                relay: "ws://127.0.0.1:9000/relay",
                sessionId: "session-secret",
                macIdentityPublicKey: "pubkey-secret",
                expiresAt: "2026-07-09T12:05:00.000Z",
                displayName: "Nick's Mac",
              },
            },
          };
        },
        printMacOSBridgePairingQr() {
          throw new Error("QR printer should not run for --json");
        },
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(writes.join("").trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.plistPath, "/tmp/agnt.plist");
  assert.equal(payload.pairingSession?.pairingPayload?.relay, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.sessionId, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.macIdentityPublicKey, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.hasRelay, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasSessionId, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasMacIdentityPublicKey, true);
});

test("agnt connect --json redacts the live pairing session", async () => {
  const writes = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };

  try {
    await main({
      argv: ["node", "agnt", "connect", "--json"],
      platform: "linux",
      consoleImpl: {
        log() {},
        error(message) { throw new Error(`unexpected error: ${message}`); },
      },
      exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
      deps: {
        async startLinuxBridgeService(options) {
          assert.deepEqual(options, { waitForPairing: true, providerId: "" });
          return {
            unitPath: "/tmp/agnt.service",
            pairingSession: {
              createdAt: "2026-07-09T12:00:00.000Z",
              pairingCode: "ABCDEFGHJK",
              pairingPayload: {
                v: 2,
                relay: "ws://127.0.0.1:9000/relay",
                sessionId: "session-secret",
                macIdentityPublicKey: "pubkey-secret",
                expiresAt: "2026-07-09T12:05:00.000Z",
                displayName: "Nick's Linux",
              },
            },
          };
        },
        printLinuxBridgePairingQr() {
          throw new Error("QR printer should not run for --json");
        },
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const payload = JSON.parse(writes.join("").trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.unitPath, "/tmp/agnt.service");
  assert.equal(payload.pairingSession?.pairingCode, "ABCDEFGHJK");
  assert.equal(payload.pairingSession?.pairingPayload?.relay, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.sessionId, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.macIdentityPublicKey, undefined);
  assert.equal(payload.pairingSession?.pairingPayload?.hasRelay, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasSessionId, true);
  assert.equal(payload.pairingSession?.pairingPayload?.hasMacIdentityPublicKey, true);
  assert.equal(payload.pairingSession?.pairingPayload?.displayName, "Nick's Linux");
});

test("runCli reports uncaught CLI failures with the agnt prefix", async () => {
  const errors = [];
  const exits = [];

  await runCli({
    async mainImpl() {
      throw new Error("boom");
    },
    consoleImpl: {
      error(message) { errors.push(message); },
    },
    exitImpl(code) { exits.push(code); },
  });

  assert.deepEqual(errors, ["[agnt] boom"]);
  assert.deepEqual(exits, [1]);
});

test("agnt start --provider claude forwards the override to the service installer", async () => {
  const calls = [];

  await main({
    argv: ["node", "agnt", "start", "--provider", "claude"],
    platform: "darwin",
    consoleImpl: { log() {}, error() {} },
    exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
    deps: {
      readBridgeConfig() {},
      async startMacOSBridgeService(options) {
        calls.push(["start-service", options]);
        return { plistPath: "/tmp/agnt.plist" };
      },
    },
  });

  assert.deepEqual(calls, [
    ["start-service", { waitForPairing: false, providerId: "claude" }],
  ]);
});

test("agnt start --provider opencode forwards the override on Linux", async () => {
  const calls = [];

  await main({
    argv: ["node", "agnt", "start", "--provider", "opencode"],
    platform: "linux",
    consoleImpl: { log() {}, error() {} },
    exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
    deps: {
      readBridgeConfig() {},
      async startLinuxBridgeService(options) {
        calls.push(["start-service", options]);
        return { unitPath: "/tmp/agnt.service" };
      },
    },
  });

  assert.deepEqual(calls, [
    ["start-service", { waitForPairing: false, providerId: "opencode" }],
  ]);
});

test("agnt reset-pairing falls back to file-only reset only when the Linux unit is not installed", async () => {
  const calls = [];

  await main({
    argv: ["node", "agnt", "reset-pairing"],
    platform: "linux",
    consoleImpl: { log() {}, error() {} },
    exitImpl(code) { throw new Error(`unexpected exit ${code}`); },
    deps: {
      resetLinuxBridgePairing() {
        const error = new Error("Unit com.dotbrains.agnt.bridge.service not loaded.");
        error.stderr = Buffer.from("Unit com.dotbrains.agnt.bridge.service not loaded.");
        throw error;
      },
      resetBridgePairing() {
        calls.push("reset-file-only");
        return { hadState: true };
      },
    },
  });

  assert.deepEqual(calls, ["reset-file-only"]);
});

test("agnt reset-pairing surfaces unexpected Linux service errors instead of reporting success", async () => {
  const calls = [];
  const errors = [];

  await main({
    argv: ["node", "agnt", "reset-pairing"],
    platform: "linux",
    consoleImpl: {
      log() {},
      error(message) { errors.push(message); },
    },
    exitImpl(code) { calls.push(["exit", code]); },
    deps: {
      resetLinuxBridgePairing() {
        // A real systemd error that is NOT a "service not installed" marker should propagate.
        const error = new Error("Failed to connect to bus: Permission denied");
        throw error;
      },
      resetBridgePairing() {
        calls.push("reset-file-only");
      },
    },
  });

  // Must not have silently fallen back to the file-only reset.
  assert.deepEqual(calls.filter((entry) => entry === "reset-file-only"), []);
  assert.deepEqual(calls.filter((entry) => Array.isArray(entry) && entry[0] === "exit"), [["exit", 1]]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Permission denied/);
});
