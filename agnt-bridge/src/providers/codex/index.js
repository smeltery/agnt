// FILE: providers/codex/index.js
// Purpose: Codex provider module — wraps existing codex-* helpers behind the
//          provider plugin contract so the bridge core can stay agent-agnostic.
// Layer: provider plugin
// Exports: codex provider (defineProvider result)
// Depends on: ../types, ./transport, ./home, ./desktop-refresher, ./cli-bootstrap

const { defineProvider } = require("../types");
const { createCodexTransport } = require("./transport");
const { resolveCodexHome, resolveCodexGeneratedImagesRoot } = require("./home");
const { CodexDesktopRefresher } = require("./desktop-refresher");
const { ensureCodexCLI, shouldSkipCodexBootstrap } = require("./cli-bootstrap");
const { isCodexInstalled } = require("./detect");
const path = require("path");

module.exports = defineProvider({
  id: "codex",
  displayName: "Codex",
  binCandidates: ["codex"],
  capabilities: {
    plan: true,
    fastMode: true,
    subagents: true,
    steerActiveTurn: true,
    queueFollowup: true,
    reasoningDeltas: true,
    desktopRefresher: true,
    rolloutMirror: true,
  },
  homeDir: resolveCodexHome,
  sessionsDir() {
    return path.join(resolveCodexHome(), "sessions");
  },
  generatedImagesDir: resolveCodexGeneratedImagesRoot,
  // Without this hook the auto-detect step in resolveActiveProvider falls
  // through to the "first registered" branch (Codex) on Linux boxes that
  // have only Claude / opencode / Cursor installed, leading to an `ENOENT`
  // when bridge.js tries to spawn `codex`.
  isInstalled({ env = process.env, platform = process.platform } = {}) {
    return isCodexInstalled({ env, platform });
  },
  createTransport(opts) {
    return createCodexTransport(opts);
  },
  createDesktopRefresher(opts) {
    return new CodexDesktopRefresher(opts);
  },
  async bootstrap({ env = process.env, logger = console, shouldUpdate = true } = {}) {
    if (shouldSkipCodexBootstrap(env)) {
      return;
    }
    await ensureCodexCLI({ env, logger, shouldUpdate });
  },
});
