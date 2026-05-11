// FILE: providers/codex/detect.js
// Purpose: Locate the Codex CLI binary on PATH or via the macOS Codex.app bundle.
// Layer: provider plugin (codex)
// Exports: detectCodexBinary, isCodexInstalled
// Depends on: child_process, fs, path

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_APP_BUNDLE_PATH = "/Applications/Codex.app";
const APP_BUNDLED_CLI_RELATIVE_PATH = path.join("Contents", "Resources", "codex");

function detectCodexBinary({ env = process.env, platform = process.platform } = {}) {
  const explicit = String(env.CODEX_CLI_PATH || env.AGNT_CODEX_CLI_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = [];

  if (platform === "darwin") {
    // Codex.app ships its own CLI inside the bundle; if the user installed the
    // desktop app, we want that path even when no `codex` is on PATH.
    candidates.push(path.join(DEFAULT_APP_BUNDLE_PATH, APP_BUNDLED_CLI_RELATIVE_PATH));
    candidates.push("/opt/homebrew/bin/codex");
  }

  candidates.push(
    "codex",
    path.join(env.HOME || "", ".npm-global", "bin", "codex"),
    path.join(env.HOME || "", ".volta", "bin", "codex"),
    path.join(env.HOME || "", ".local", "bin", "codex"),
    "/usr/local/bin/codex",
  );

  for (const candidate of candidates) {
    if (candidate && candidate.startsWith("/") && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const lookupCommand = platform === "win32" ? "where" : "which";
    const result = spawnSync(lookupCommand, ["codex"], { env, encoding: "utf8" });
    const found = (result.stdout || "").trim().split("\n")[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Caller handles the missing-binary case.
  }

  return "";
}

function isCodexInstalled({ env = process.env, platform = process.platform } = {}) {
  return Boolean(detectCodexBinary({ env, platform }));
}

module.exports = {
  detectCodexBinary,
  isCodexInstalled,
};
