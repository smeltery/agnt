// FILE: index.js
// Purpose: Small entrypoint wrapper for bridge lifecycle commands.
// Layer: CLI entry
// Exports: bridge lifecycle, pairing reset, thread resume/watch, and per-platform service helpers.
// Depends on: ./bridge, ./secure-device-state, ./session-state, ./rollout-watch, ./macos-launch-agent, ./linux-systemd-agent

const { startBridge } = require("./bridge/bridge");
const { readBridgeDeviceState, resetBridgeDeviceState } = require("./transport/secure-device-state");
const { openLastActiveThread } = require("./bridge/session-state");
const { watchThreadRollout } = require("./desktop/rollout-watch");
const { readBridgeConfig } = require("./bridge/bridge-config");
const {
  getMacOSBridgeServiceStatus,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  resetMacOSBridgePairing,
  runMacOSBridgeService,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
} = require("./platform/macos-launch-agent");
const {
  getLinuxBridgeServiceStatus,
  isLinuxBridgeServiceNotInstalledError,
  printLinuxBridgePairingQr,
  printLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  runLinuxBridgeService,
  startLinuxBridgeService,
  stopLinuxBridgeService,
} = require("./platform/linux-systemd-agent");

module.exports = {
  getMacOSBridgeServiceStatus,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  readBridgeConfig,
  readBridgeDeviceState,
  resetMacOSBridgePairing,
  startBridge,
  runMacOSBridgeService,
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
  resetBridgePairing: resetBridgeDeviceState,
  openLastActiveThread,
  watchThreadRollout,
};
