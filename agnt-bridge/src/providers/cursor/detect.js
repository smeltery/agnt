// FILE: providers/cursor/detect.js
// Purpose: Locate the Cursor CLI binary on PATH or via env override. The
//          installer drops `cursor-agent` (and a sibling `agent` symlink) at
//          `~/.local/bin/`; older builds shipped `agent` only.
// Layer: provider plugin (cursor)
// Exports: detectCursorBinary, isCursorInstalled
// Depends on: child_process, fs, path

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BIN_NAMES = ["cursor-agent", "agent"];

function detectCursorBinary({ env = process.env } = {}) {
  const explicit = String(env.CURSOR_CLI_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const home = env.HOME || "";
  const absoluteCandidates = [];
  for (const name of BIN_NAMES) {
    if (home) {
      absoluteCandidates.push(path.join(home, ".local", "bin", name));
      absoluteCandidates.push(path.join(home, ".cursor", "bin", name));
    }
    absoluteCandidates.push(`/opt/homebrew/bin/${name}`);
    absoluteCandidates.push(`/usr/local/bin/${name}`);
  }

  for (const candidate of absoluteCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH lookup via `which`. Try each name in order.
  for (const name of BIN_NAMES) {
    try {
      const result = spawnSync("which", [name], { env, encoding: "utf8" });
      const found = (result.stdout || "").trim().split("\n")[0];
      if (found && fs.existsSync(found)) {
        return found;
      }
    } catch {
      // Ignore — caller handles the missing-binary case.
    }
  }

  return "";
}

function isCursorInstalled({ env = process.env } = {}) {
  return Boolean(detectCursorBinary({ env }));
}

module.exports = {
  detectCursorBinary,
  isCursorInstalled,
};
