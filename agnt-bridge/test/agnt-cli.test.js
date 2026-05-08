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
const { main } = require("../bin/agnt");

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

test("agnt status --json exposes daemon metadata for companion apps", async () => {
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
            },
            bridgeStatus: {
              connectionStatus: "connected",
              pid: 77,
            },
            pairingSession: {
              pairingPayload: {
                relay: "ws://127.0.0.1:9000/relay",
                sessionId: "session-json",
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
  assert.equal(payload.daemonConfig?.relayUrl, "ws://127.0.0.1:9000/relay");
  assert.equal(payload.bridgeStatus?.connectionStatus, "connected");
  assert.equal(payload.pairingSession?.pairingPayload?.sessionId, "session-json");
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
