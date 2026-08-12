// FILE: desktop-refresher-config.test.js
// Purpose: Verifies bridge config defaults and packaged relay/push overrides for desktop refresh.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../../../src/bridge/bridge-config

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readBridgeConfig } = require("../../../src/bridge/bridge-config");

test("readBridgeConfig keeps safe defaults and explicit overrides", () => {
  const macConfig = readBridgeConfig({
    env: {},
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const persistedKeepAwakeConfig = readBridgeConfig({
    env: {
      AGNT_DEVICE_STATE_DIR: "/tmp/agnt-state",
    },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync(targetPath) {
        return targetPath === "/tmp/agnt-state/daemon-config.json";
      },
      readFileSync(targetPath) {
        if (targetPath === "/tmp/agnt-state/daemon-config.json") {
          return JSON.stringify({ keepMacAwakeEnabled: false });
        }
        throw new Error("unexpected read");
      },
    },
  });
  const persistedRefreshConfig = readBridgeConfig({
    env: {
      AGNT_DEVICE_STATE_DIR: "/tmp/agnt-state",
    },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync(targetPath) {
        return targetPath === "/tmp/agnt-state/daemon-config.json";
      },
      readFileSync(targetPath) {
        if (targetPath === "/tmp/agnt-state/daemon-config.json") {
          return JSON.stringify({ refreshEnabled: true });
        }
        throw new Error("unexpected read");
      },
    },
  });
  const macEndpointConfig = readBridgeConfig({
    env: { AGNT_CODEX_ENDPOINT: "ws://localhost:8080" },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const linuxConfig = readBridgeConfig({
    env: {},
    platform: "linux",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const linuxCommandConfig = readBridgeConfig({
    env: { AGNT_REFRESH_COMMAND: "echo refresh" },
    platform: "linux",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const explicitOnConfig = readBridgeConfig({
    env: {
      AGNT_CODEX_ENDPOINT: "ws://localhost:8080",
      AGNT_REFRESH_ENABLED: "true",
      AGNT_DESKTOP_IPC_SOCKET: "/tmp/agnt-ipc.sock",
      AGNT_DESKTOP_IPC_SNAPSHOT_DEBOUNCE_MS: "42",
    },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const explicitOffConfig = readBridgeConfig({
    env: {
      AGNT_REFRESH_COMMAND: "echo refresh",
      AGNT_REFRESH_ENABLED: "false",
      AGNT_KEEP_MAC_AWAKE: "false",
    },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  const explicitAutoFollowOffConfig = readBridgeConfig({
    env: {
      AGNT_DESKTOP_AUTO_FOLLOW: "false",
    },
    platform: "darwin",
    runtimeRoot: "/tmp/agnt-package",
    fsImpl: {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
    },
  });
  assert.equal(macConfig.refreshEnabled, false);
  assert.equal(macConfig.desktopAutoFollowEnabled, true);
  assert.equal(macEndpointConfig.desktopAutoFollowEnabled, false);
  assert.equal(linuxConfig.desktopAutoFollowEnabled, false);
  assert.equal(explicitOffConfig.desktopAutoFollowEnabled, true);
  assert.equal(explicitAutoFollowOffConfig.desktopAutoFollowEnabled, false);
  assert.equal(macConfig.keepMacAwakeEnabled, false);
  assert.equal(macConfig.relayUrl, "");
  assert.equal(macConfig.pushServiceUrl, "");
  assert.equal(persistedKeepAwakeConfig.keepMacAwakeEnabled, false);
  assert.equal(persistedRefreshConfig.refreshEnabled, true);
  assert.equal(macEndpointConfig.refreshEnabled, false);
  assert.equal(linuxConfig.refreshEnabled, false);
  assert.equal(linuxCommandConfig.refreshEnabled, false);
  assert.equal(explicitOnConfig.refreshEnabled, true);
  assert.equal(explicitOnConfig.desktopIpcSocketPath, "/tmp/agnt-ipc.sock");
  assert.equal(explicitOnConfig.desktopIpcSnapshotDebounceMs, 42);
  assert.equal(macConfig.desktopIpcSnapshotDebounceMs, 75);
  assert.equal(explicitOffConfig.refreshEnabled, false);
  assert.equal(explicitOffConfig.keepMacAwakeEnabled, false);
});

test("readBridgeConfig uses only the packaged relay default outside a source checkout", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-package-"));
  const srcDir = path.join(tempRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "private-defaults.json"),
    JSON.stringify({ relayUrl: "wss://relay.example/relay" }),
    "utf8"
  );

  const config = readBridgeConfig({
    env: {},
    runtimeRoot: tempRoot,
    fsImpl: fs,
  });

  assert.equal(config.relayUrl, "wss://relay.example/relay");
  assert.equal(config.pushServiceUrl, "");
});

test("readBridgeConfig uses a packaged push default only when it is explicitly provided", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-package-"));
  const srcDir = path.join(tempRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "private-defaults.json"),
    JSON.stringify({
      relayUrl: "wss://relay.example/relay",
      pushServiceUrl: "https://relay.example",
    }),
    "utf8"
  );

  const config = readBridgeConfig({
    env: {},
    runtimeRoot: tempRoot,
    fsImpl: fs,
  });

  assert.equal(config.relayUrl, "wss://relay.example/relay");
  assert.equal(config.pushServiceUrl, "https://relay.example");
});

test("readBridgeConfig does not use the hosted fallback inside a source checkout", () => {
  const config = readBridgeConfig({
    env: {},
    runtimeRoot: "/workspace/agnt-bridge",
    fsImpl: {
      existsSync(targetPath) {
        return targetPath === "/workspace/.git";
      },
    },
  });

  assert.equal(config.relayUrl, "");
  assert.equal(config.pushServiceUrl, "");
});

test("readBridgeConfig preserves reverse-proxy subpaths when deriving push URLs", () => {
  const config = readBridgeConfig({
    env: {
      AGNT_PUSH_SERVICE_URL: "https://relay.example/agnt",
    },
    runtimeRoot: "/workspace/agnt-bridge",
    fsImpl: {
      existsSync() {
        return false;
      },
    },
  });

  assert.equal(config.pushServiceUrl, "https://relay.example/agnt");
});

test("readBridgeConfig disables managed push defaults when a self-hosted relay override is set", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-package-"));
  const srcDir = path.join(tempRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "private-defaults.json"),
    JSON.stringify({ relayUrl: "wss://relay.example/agnt/relay" }),
    "utf8"
  );

  const config = readBridgeConfig({
    env: {
      AGNT_RELAY: "wss://self-host.example/relay",
    },
    runtimeRoot: tempRoot,
    fsImpl: fs,
  });

  assert.equal(config.relayUrl, "wss://self-host.example/relay");
  assert.equal(config.pushServiceUrl, "");
});
