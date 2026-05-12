// FILE: bridge-preferences.js
// Purpose: Read + update the small set of bridge-side toggles the iOS app
//          surfaces in its bridge settings panel. Currently a single key:
//          `keepMacAwake` (the wake assertion). New toggles go here.
// Layer: bridge utility — owns config persistence + the wake-assertion link.
// Exports: createBridgePreferences, persistBridgePreferences
//
// Why a module: `readBridgePreferences` and `updateBridgePreferences` used to
// be closure-bound helpers inside `startBridge`, with their persistence helper
// (`persistBridgePreferences`) at module scope further down the file. The
// pair only needs `config` (to keep the in-memory snapshot consistent) and
// the `bridgeWakeAssertion` controller; collecting both into a single factory
// removes ~30 lines from bridge.js and keeps the preference-translation logic
// near the persistence helper.

const { readDaemonConfig, writeDaemonConfig } = require("./daemon-state");

/**
 * @param {object} deps
 * @param {object} deps.config — the bridge config object held by startBridge;
 *   mutated in-place so subsequent reads observe the new value before the
 *   next daemon-state load.
 * @param {{ active: boolean, setEnabled?: (v: boolean) => unknown }} deps.bridgeWakeAssertion
 *   — the wake-assertion controller. Required so `update` can flip the live
 *     state in lock-step with the persisted preference.
 */
function createBridgePreferences({ config, bridgeWakeAssertion }) {
  function read() {
    return {
      success: true,
      preferences: {
        keepMacAwake: config.keepMacAwakeEnabled !== false,
      },
      applied: bridgeWakeAssertion.active,
    };
  }

  function update(preferences = {}) {
    const nextKeepMacAwakeEnabled = preferences.keepMacAwake !== false;
    config.keepMacAwakeEnabled = nextKeepMacAwakeEnabled;
    bridgeWakeAssertion.setEnabled?.(nextKeepMacAwakeEnabled);

    try {
      persistBridgePreferences({
        keepMacAwakeEnabled: nextKeepMacAwakeEnabled,
      });
    } catch (error) {
      const nextError = new Error("Could not save the bridge preference on this Mac.");
      nextError.errorCode = "bridge_preferences_persist_failed";
      nextError.userMessage = nextError.message;
      nextError.cause = error;
      throw nextError;
    }

    return read();
  }

  return { read, update };
}

// Module-scope so the existing bridge.test.js suite can import it directly to
// pin the daemon-config write contract.
function persistBridgePreferences(
  { keepMacAwakeEnabled },
  {
    readDaemonConfigImpl = readDaemonConfig,
    writeDaemonConfigImpl = writeDaemonConfig,
  } = {}
) {
  writeDaemonConfigImpl({
    ...(readDaemonConfigImpl() || {}),
    keepMacAwakeEnabled,
  });
}

module.exports = {
  createBridgePreferences,
  persistBridgePreferences,
};
