// FILE: providers/opencode/detect.js
// Purpose: Locate the opencode CLI binary on PATH or via env override.
// Layer: provider plugin (opencode)
// Exports: detectOpencodeBinary, isOpencodeInstalled
// Depends on: child_process, fs, path

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function detectOpencodeBinary({ env = process.env } = {}) {
  const explicit = String(env.OPENCODE_CLI_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    path.join(env.HOME || "", ".bun", "bin", "opencode"),
    path.join(env.HOME || "", ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const result = spawnSync("which", ["opencode"], { env, encoding: "utf8" });
    const found = (result.stdout || "").trim().split("\n")[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Ignore — caller handles the missing-binary case.
  }

  return "";
}

function isOpencodeInstalled({ env = process.env } = {}) {
  return Boolean(detectOpencodeBinary({ env }));
}

module.exports = {
  detectOpencodeBinary,
  isOpencodeInstalled,
};
