#!/usr/bin/env node
// FILE: bootstrap-provider.js
// Purpose: Generic postinstall hook. Routes to the active provider's bootstrap()
//          so adding a new provider doesn't require editing the npm scripts.
// Layer: CLI helper
// Exports: none
// Depends on: ./providers, ./secure-device-state, ./ios-app-compatibility

const { resolveActiveProvider } = require("./providers/index");
const { version: bridgePackageVersion = "" } = require("../package.json");
const { readBridgeDeviceState } = require("./transport/secure-device-state");
const { buildCachedIOSAppCompatibilityWarning } = require("./bridge/ios-app-compatibility");

const installLocation = String(process.env.npm_config_location || "").trim().toLowerCase();
const isGlobalInstall = process.env.npm_config_global === "true" || installLocation === "global";

const skip = String(process.env.AGNT_SKIP_BOOTSTRAP || "")
  .trim()
  .toLowerCase();
const shouldSkip = skip === "1" || skip === "true" || skip === "yes";

(async () => {
  // Local installs (e.g. inside this repo's own node_modules) skip provider bootstrap.
  if (!isGlobalInstall && !shouldSkip) {
    process.exit(0);
  }

  if (shouldSkip) {
    process.exit(0);
  }

  const { provider } = resolveActiveProvider({ env: process.env });
  if (provider && typeof provider.bootstrap === "function") {
    try {
      await provider.bootstrap({
        env: process.env,
        logger: console,
        shouldUpdate: true,
      });
    } catch (error) {
      console.warn(`[agnt] Provider bootstrap (${provider.id}) failed: ${(error && error.message) || error}`);
    }
  }

  logCachedIOSAppCompatibilityWarning();
})();

function logCachedIOSAppCompatibilityWarning() {
  try {
    const deviceState = readBridgeDeviceState();
    const warning = buildCachedIOSAppCompatibilityWarning({
      bridgeVersion: bridgePackageVersion,
      iosAppVersion: deviceState?.lastSeenPhoneAppVersion,
    });
    if (warning) {
      console.warn(warning);
    }
  } catch {
    // Keep postinstall non-blocking even if the cached pairing state is unavailable.
  }
}
