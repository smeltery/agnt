// FILE: bridge-package-updater.test.js
// Purpose: Verifies bridge self-update command execution and delayed service restart scheduling.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, events, ../../src/bridge/bridge-package-updater

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  BRIDGE_PACKAGE_UPDATE_COMMAND,
  createBridgePackageUpdateAndRestart,
  scheduleBridgeServiceRestartAfterUpdate,
} = require("../../src/bridge/bridge-package-updater");

test("bridge package updater runs npm update and schedules delayed restart", async () => {
  const executorCalls = [];
  const timers = [];
  const spawnCalls = [];
  let timerUnrefCalled = false;
  let childUnrefCalled = false;

  const updateBridgePackageAndRestart = createBridgePackageUpdateAndRestart({
    platform: "darwin",
    executor: async (...args) => {
      executorCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    setTimeoutFn(callback, delayMs) {
      timers.push({ callback, delayMs });
      return {
        unref() {
          timerUnrefCalled = true;
        },
      };
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        on() {},
        unref() {
          childUnrefCalled = true;
        },
      };
    },
    execPath: "/usr/local/bin/node",
    cliPath: "/usr/local/lib/node_modules/@smeltery/agnt/bin/agnt.js",
    env: { AGNT_TEST: "1" },
  });

  const result = await updateBridgePackageAndRestart();

  assert.equal(result.success, true);
  assert.equal(result.command, BRIDGE_PACKAGE_UPDATE_COMMAND);
  assert.equal(result.restartScheduled, true);
  assert.equal(result.restartDelayMs, 750);
  assert.equal(timerUnrefCalled, true);
  assert.equal(timers.length, 1);
  assert.deepEqual(executorCalls[0], [
    "/bin/zsh",
    [
      "-lc",
      `export TERM=dumb; source ~/.zshrc >/dev/null 2>/dev/null || true; ${BRIDGE_PACKAGE_UPDATE_COMMAND}`,
    ],
    {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  ]);

  timers[0].callback();

  assert.equal(childUnrefCalled, true);
  assert.deepEqual(spawnCalls, [{
    command: "/usr/local/bin/node",
    args: ["/usr/local/lib/node_modules/@smeltery/agnt/bin/agnt.js", "restart"],
    options: {
      detached: true,
      stdio: "ignore",
      env: { AGNT_TEST: "1" },
    },
  }]);
});

test("bridge package updater reports command failures as typed user errors", async () => {
  const updateBridgePackageAndRestart = createBridgePackageUpdateAndRestart({
    platform: "darwin",
    executor: async () => {
      const error = new Error("failed");
      error.stderr = "npm denied";
      throw error;
    },
  });

  await assert.rejects(updateBridgePackageAndRestart(), {
    errorCode: "bridge_update_failed",
    userMessage: "npm denied",
  });
});

test("bridge package updater is macOS-only", async () => {
  const updateBridgePackageAndRestart = createBridgePackageUpdateAndRestart({
    platform: "linux",
  });

  await assert.rejects(updateBridgePackageAndRestart(), {
    errorCode: "unsupported_platform",
  });
});

test("delayed bridge restart logs spawn errors instead of throwing", () => {
  const warnings = [];
  const child = new EventEmitter();

  scheduleBridgeServiceRestartAfterUpdate({
    setTimeoutFn(callback) {
      callback();
      return { unref() {} };
    },
    spawnImpl() {
      return child;
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  child.emit("error", new Error("spawn failed"));

  assert.deepEqual(warnings, [
    "[agnt] Failed to schedule the post-update bridge restart: spawn failed",
  ]);
});
