// FILE: providers/claude/index.js
// Purpose: Claude Code provider — wraps the Claude CLI behind the provider
//          plugin contract.
// Layer: provider plugin
// Exports: claude provider
// Depends on: ../types, ./transport, ./detect, os, path
//
// Status: transport plumbs stdio between bridge and `claude --output-format
// stream-json --input-format stream-json --verbose`. **Bridge<->Claude
// schema translation is NOT implemented yet** — the bridge speaks Codex
// JSON-RPC, Claude speaks stream-json. iOS clients won't get usable events
// until a translation shim is added. See providers/claude/transport.js.

const path = require("path");
const os = require("os");
const { defineProvider } = require("../types");
const { createClaudeTransport } = require("./transport");
const { detectClaudeBinary, isClaudeInstalled } = require("./detect");

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
    rolloutMirror: true,
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
  // TODO: parseRolloutLine for ~/.claude/projects/.../*.jsonl event normalization.
});
