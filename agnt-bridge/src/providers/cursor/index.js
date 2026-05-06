// FILE: providers/cursor/index.js
// Purpose: Cursor provider — wraps the `cursor-agent` CLI behind the provider
//          plugin contract.
// Layer: provider plugin
// Exports: cursor provider
// Depends on: ../types, ./transport, ./detect, ./translate, os, path

const path = require("path");
const os = require("os");
const { defineProvider } = require("../types");
const { createCursorTransport } = require("./transport");
const { detectCursorBinary, isCursorInstalled } = require("./detect");
const { createCursorTranslator } = require("./translate");

function resolveCursorHome() {
  return process.env.CURSOR_HOME || path.join(os.homedir(), ".cursor");
}

module.exports = defineProvider({
  id: "cursor",
  displayName: "Cursor",
  binCandidates: ["cursor-agent", "agent"],
  capabilities: {
    plan: false,
    fastMode: false,
    subagents: false,
    steerActiveTurn: false,
    queueFollowup: false,
    // cursor-agent stream-json does not surface separate "thinking" deltas;
    // assistant text frames are the only authoritative content stream.
    reasoningDeltas: false,
    desktopRefresher: false,
    // No companion app to mirror; sessions live in ~/.cursor/chats/*.jsonl.
    rolloutMirror: false,
  },
  homeDir: resolveCursorHome,
  sessionsDir() {
    return path.join(resolveCursorHome(), "chats");
  },
  isInstalled({ env = process.env } = {}) {
    return isCursorInstalled({ env });
  },
  createTransport(opts = {}) {
    return createCursorTransport(opts);
  },
  createTranslator(ctx) {
    return createCursorTranslator(ctx);
  },
  async bootstrap({ env = process.env, logger = console } = {}) {
    if (detectCursorBinary({ env })) {
      return { status: "found" };
    }
    logger.warn?.(
      "[agnt] cursor provider: `cursor-agent` CLI not found on PATH. "
      + "Install via `curl https://cursor.com/install -fsS | bash` to enable this provider."
    );
    return { status: "missing" };
  },
});
