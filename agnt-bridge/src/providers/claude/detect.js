// FILE: providers/claude/detect.js
// Purpose: Locate the Claude Code CLI binary on PATH or via env override.
// Layer: provider plugin (claude)
// Exports: detectClaudeBinary, isClaudeInstalled
// Depends on: child_process, fs, path

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function detectClaudeBinary({ env = process.env } = {}) {
  const explicit = String(env.CLAUDE_CLI_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    "claude",
    path.join(env.HOME || "", ".npm-global", "bin", "claude"),
    path.join(env.HOME || "", ".volta", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH lookup via `which`.
  try {
    const result = spawnSync("which", ["claude"], { env, encoding: "utf8" });
    const found = (result.stdout || "").trim().split("\n")[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Ignore — caller handles the missing-binary case.
  }

  return "";
}

function isClaudeInstalled({ env = process.env } = {}) {
  return Boolean(detectClaudeBinary({ env }));
}

module.exports = {
  detectClaudeBinary,
  isClaudeInstalled,
};
