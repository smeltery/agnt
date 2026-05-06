// FILE: providers/opencode/index.js
// Purpose: opencode provider — wraps `opencode serve` behind the provider
//          plugin contract.
// Layer: provider plugin
// Exports: opencode provider
// Depends on: ../types, ./transport, ./detect, ./translate, os, path

const path = require("path");
const os = require("os");
const { defineProvider } = require("../types");
const { createOpencodeTransport } = require("./transport");
const { detectOpencodeBinary, isOpencodeInstalled } = require("./detect");
const { createOpencodeTranslator } = require("./translate");

function resolveOpencodeHome() {
  return (
    process.env.OPENCODE_HOME
    || (process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode") : "")
    || path.join(os.homedir(), ".local", "share", "opencode")
  );
}

module.exports = defineProvider({
  id: "opencode",
  displayName: "opencode",
  binCandidates: ["opencode"],
  capabilities: {
    plan: false,
    fastMode: false,
    subagents: false,
    steerActiveTurn: false,
    queueFollowup: false,
    reasoningDeltas: true,
    desktopRefresher: false,
    rolloutMirror: false,
  },
  homeDir: resolveOpencodeHome,
  sessionsDir() {
    return path.join(resolveOpencodeHome(), "sessions");
  },
  isInstalled({ env = process.env } = {}) {
    return isOpencodeInstalled({ env });
  },
  createTransport(opts = {}) {
    return createOpencodeTransport(opts);
  },
  createTranslator(ctx) {
    return createOpencodeTranslator(ctx);
  },
  async bootstrap({ env = process.env, logger = console } = {}) {
    if (detectOpencodeBinary({ env })) {
      return { status: "found" };
    }
    logger.warn?.(
      "[agnt] opencode provider: `opencode` CLI not found on PATH. "
      + "Install from https://opencode.ai to enable this provider."
    );
    return { status: "missing" };
  },
});
