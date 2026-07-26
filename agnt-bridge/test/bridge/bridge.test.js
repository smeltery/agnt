// FILE: bridge.test.js
// Purpose: Verifies relay watchdog helpers used to recover from stale sleep/wake sockets.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/bridge/bridge, ../../src/platform/wake-assertion

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  annotateTurnStateProbeWithMirrorActiveTurn,
  buildHeartbeatBridgeStatus,
  disableUnsupportedReasoningSummaryForTurnStart,
  hasRelayConnectionGoneStale,
  persistBridgePreferences,
} = require("../../src/bridge/bridge");
const { createMacOSBridgeWakeAssertion } = require("../../src/platform/wake-assertion");

test("disableUnsupportedReasoningSummaryForTurnStart disables summaries for Codex Spark", () => {
  const raw = JSON.stringify({
    id: "req-turn-start",
    method: "turn/start",
    params: {
      threadId: "thread-1",
      model: "gpt-5.3-codex-spark",
      effort: "medium",
      input: [{ type: "text", text: "Ship it" }],
    },
  });

  const normalized = JSON.parse(disableUnsupportedReasoningSummaryForTurnStart(raw));

  assert.equal(normalized.params.model, "gpt-5.3-codex-spark");
  assert.equal(normalized.params.summary, "none");
});

test("disableUnsupportedReasoningSummaryForTurnStart detects plan-mode Codex Spark model", () => {
  const raw = JSON.stringify({
    id: "req-turn-start-plan",
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan it" }],
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex-spark",
          reasoning_effort: "medium",
        },
      },
    },
  });

  const normalized = JSON.parse(disableUnsupportedReasoningSummaryForTurnStart(raw));

  assert.equal(normalized.params.summary, "none");
  assert.equal(normalized.params.collaborationMode.settings.model, "gpt-5.3-codex-spark");
});

test("disableUnsupportedReasoningSummaryForTurnStart leaves other models untouched", () => {
  const raw = JSON.stringify({
    id: "req-turn-start-gpt55",
    method: "turn/start",
    params: {
      threadId: "thread-1",
      model: "gpt-5.5",
      input: [{ type: "text", text: "Ship it" }],
    },
  });

  assert.equal(disableUnsupportedReasoningSummaryForTurnStart(raw), raw);
});

test("turn-state probe responses carry mirror active turn without mutating cached pages", () => {
  const request = {
    id: "req-probe",
    method: "thread/turns/list",
    params: { threadId: "thread-mirrored", agntTurnStateOnly: true },
  };
  const cachedResponse = {
    id: "req-probe",
    result: { data: [{ id: "turn-old", status: "completed" }], nextCursor: null },
  };

  const annotated = annotateTurnStateProbeWithMirrorActiveTurn(
    request,
    cachedResponse,
    (threadId) => (threadId === "thread-mirrored" ? "turn-live" : null)
  );

  assert.equal(annotated.result.agntMirrorActiveTurnId, "turn-live");
  assert.equal(annotated.result.data[0].id, "turn-old");
  assert.equal(cachedResponse.result.agntMirrorActiveTurnId, undefined);
  assert.equal(
    annotateTurnStateProbeWithMirrorActiveTurn(request, cachedResponse, () => null),
    cachedResponse
  );
  const historyRequest = { ...request, params: { threadId: "thread-mirrored", limit: 5 } };
  assert.equal(
    annotateTurnStateProbeWithMirrorActiveTurn(historyRequest, cachedResponse, () => "turn-live"),
    cachedResponse
  );
});

test("hasRelayConnectionGoneStale returns true once the relay silence crosses the timeout", () => {
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 26_000,
      staleAfterMs: 25_000,
    }),
    true
  );
});

test("hasRelayConnectionGoneStale returns false for fresh or missing activity timestamps", () => {
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 25_999,
      staleAfterMs: 25_000,
    }),
    false
  );
  assert.equal(hasRelayConnectionGoneStale(Number.NaN), false);
});

test("hasRelayConnectionGoneStale default threshold waits 25 seconds", () => {
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 25_999,
    }),
    false
  );
  assert.equal(
    hasRelayConnectionGoneStale(1_000, {
      now: 26_000,
    }),
    true
  );
});

test("buildHeartbeatBridgeStatus downgrades stale connected snapshots", () => {
  assert.deepEqual(
    buildHeartbeatBridgeStatus(
      {
        state: "running",
        connectionStatus: "connected",
        pid: 123,
        lastError: "",
      },
      1_000,
      {
        now: 26_500,
        staleAfterMs: 25_000,
        staleMessage: "Relay heartbeat stalled; reconnect pending.",
      }
    ),
    {
      state: "running",
      connectionStatus: "disconnected",
      pid: 123,
      lastError: "Relay heartbeat stalled; reconnect pending.",
    }
  );
});

test("buildHeartbeatBridgeStatus leaves fresh or already-disconnected snapshots unchanged", () => {
  const freshStatus = {
    state: "running",
    connectionStatus: "connected",
    pid: 123,
    lastError: "",
  };
  assert.deepEqual(
    buildHeartbeatBridgeStatus(freshStatus, 1_000, {
      now: 20_000,
      staleAfterMs: 25_000,
    }),
    freshStatus
  );

  const disconnectedStatus = {
    state: "running",
    connectionStatus: "disconnected",
    pid: 123,
    lastError: "",
  };
  assert.deepEqual(buildHeartbeatBridgeStatus(disconnectedStatus, 1_000), disconnectedStatus);
});

test("createMacOSBridgeWakeAssertion spawns a macOS caffeinate idle-sleep assertion tied to the bridge pid", () => {
  const spawnCalls = [];
  const fakeChild = {
    killed: false,
    on() {},
    unref() {},
    kill() {
      this.killed = true;
    },
  };

  const assertion = createMacOSBridgeWakeAssertion({
    platform: "darwin",
    pid: 4242,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return fakeChild;
    },
  });

  assert.equal(assertion.active, true);
  assert.deepEqual(spawnCalls, [{
    command: "/usr/bin/caffeinate",
    args: ["-i", "-w", "4242"],
    options: { stdio: "ignore" },
  }]);

  assertion.stop();
  assert.equal(fakeChild.killed, true);
});

test("createMacOSBridgeWakeAssertion can toggle the caffeinate assertion on and off live", () => {
  const spawnCalls = [];
  const children = [];

  const assertion = createMacOSBridgeWakeAssertion({
    platform: "darwin",
    pid: 9001,
    enabled: false,
    spawnImpl(command, args, options) {
      const child = {
        killed: false,
        on() {},
        unref() {},
        kill() {
          this.killed = true;
        },
      };
      children.push(child);
      spawnCalls.push({ command, args, options });
      return child;
    },
  });

  assert.equal(assertion.active, false);
  assert.equal(assertion.enabled, false);
  assert.deepEqual(spawnCalls, []);

  assertion.setEnabled(true);
  assert.equal(assertion.enabled, true);
  assert.equal(assertion.active, true);
  assert.equal(spawnCalls.length, 1);

  assertion.setEnabled(false);
  assert.equal(assertion.enabled, false);
  assert.equal(assertion.active, false);
  assert.equal(children[0].killed, true);
});

test("createMacOSBridgeWakeAssertion is a no-op when no inhibitor is available", () => {
  let didSpawn = false;
  const assertion = createMacOSBridgeWakeAssertion({
    platform: "linux",
    envImpl: {},
    spawnImpl() {
      didSpawn = true;
      throw new Error("should not spawn");
    },
  });

  assert.equal(assertion.active, false);
  assertion.stop();
  assert.equal(didSpawn, false);
});

test("createMacOSBridgeWakeAssertion spawns systemd-inhibit on Linux when available", () => {
  // Use this test file's directory as a fake PATH segment that contains a "systemd-inhibit"
  // sibling we create on the fly, so the PATH probe finds an executable without touching real bins.
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-systemd-inhibit-"));
  const inhibitPath = path.join(tmpDir, "systemd-inhibit");
  fs.writeFileSync(inhibitPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const spawnCalls = [];
    const fakeChild = {
      killed: false,
      on() {},
      unref() {},
      kill() { this.killed = true; },
    };

    const assertion = createMacOSBridgeWakeAssertion({
      platform: "linux",
      pid: 1234,
      envImpl: {
        PATH: tmpDir,
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      spawnImpl(command, args, options) {
        spawnCalls.push({ command, args, options });
        return fakeChild;
      },
    });

    assert.equal(assertion.active, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "systemd-inhibit");
    assert.deepEqual(spawnCalls[0].args.slice(0, 4), [
      "--what=idle:sleep",
      "--who=agnt",
      "--why=agnt bridge keeps the host reachable while paired",
      "--mode=block",
    ]);
    assert.deepEqual(spawnCalls[0].args.slice(4), ["sleep", "infinity"]);

    assertion.stop();
    assert.equal(fakeChild.killed, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("persistBridgePreferences only saves the daemon preference field", () => {
  const writes = [];

  persistBridgePreferences(
    { keepMacAwakeEnabled: false },
    {
      readDaemonConfigImpl() {
        return {
          relayUrl: "ws://127.0.0.1:9000/relay",
          refreshEnabled: true,
        };
      },
      writeDaemonConfigImpl(config) {
        writes.push(config);
      },
    }
  );

  assert.deepEqual(writes, [{
    relayUrl: "ws://127.0.0.1:9000/relay",
    refreshEnabled: true,
    keepMacAwakeEnabled: false,
  }]);
});
