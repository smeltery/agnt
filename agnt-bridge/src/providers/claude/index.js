// FILE: providers/claude/index.js
// Purpose: Claude Code provider — wraps the Claude CLI behind the provider
//          plugin contract.
// Layer: provider plugin
// Exports: claude provider
// Depends on: ../types, ./transport, ./detect, ./translate, os, path

const path = require("path");
const os = require("os");
const { defineProvider } = require("../types");
const { createClaudeTransport } = require("./transport");
const { detectClaudeBinary, isClaudeInstalled } = require("./detect");
const { createClaudeTranslator } = require("./translate");

function resolveClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

module.exports = defineProvider({
  id: "claude",
  displayName: "Claude Code",
  binCandidates: ["claude"],
  capabilities: {
    plan: true,
    fastMode: false,
    subagents: true,
    steerActiveTurn: false,
    queueFollowup: false,
    reasoningDeltas: true,
    desktopRefresher: false,
    // Codex's rollout-live-mirror only knows how to parse Codex's rollout
    // schema. Until a normalized cross-provider parseRolloutLine consumer
    // lands, claude declares this off rather than triggering the mirror
    // watcher against `~/.claude/projects/**.jsonl` files it can't read.
    rolloutMirror: false,
  },
  homeDir: resolveClaudeHome,
  sessionsDir() {
    return path.join(resolveClaudeHome(), "projects");
  },
  isInstalled({ env = process.env } = {}) {
    return isClaudeInstalled({ env });
  },
  createTransport(opts = {}) {
    return createClaudeTransport(opts);
  },
  createTranslator(ctx) {
    return createClaudeTranslator(ctx);
  },
  async bootstrap({ env = process.env, logger = console } = {}) {
    if (detectClaudeBinary({ env })) {
      return { status: "found" };
    }
    logger.warn?.(
      "[agnt] claude provider: `claude` CLI not found on PATH. "
      + "Install with `npm install -g @anthropic-ai/claude-code` to enable this provider."
    );
    return { status: "missing" };
  },
});
