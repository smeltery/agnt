// FILE: codex-detect.test.js
// Purpose: Verifies Codex CLI auto-detection across PATH, env override, and Codex.app bundle.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/providers/codex/detect, ../src/providers/index

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { detectCodexBinary, isCodexInstalled } = require("../src/providers/codex/detect");
const { resolveActiveProvider } = require("../src/providers");

test("detectCodexBinary returns the explicit CODEX_CLI_PATH override when it exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-detect-"));
  const fakeBin = path.join(tmpDir, "codex");
  fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    assert.equal(
      detectCodexBinary({
        env: { CODEX_CLI_PATH: fakeBin, PATH: "" },
        platform: "linux",
      }),
      fakeBin
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("detectCodexBinary returns empty when nothing is on PATH or in known locations", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-detect-empty-"));
  const tmpPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-detect-path-"));

  try {
    assert.equal(
      detectCodexBinary({
        env: {
          HOME: tmpHome,
          PATH: tmpPathDir,
          CODEX_CLI_PATH: "",
          AGNT_CODEX_CLI_PATH: "",
        },
        platform: "linux",
      }),
      ""
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpPathDir, { recursive: true, force: true });
  }
});

test("detectCodexBinary finds a binary placed in HOME/.local/bin", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-detect-local-"));
  const localBinDir = path.join(tmpHome, ".local", "bin");
  fs.mkdirSync(localBinDir, { recursive: true });
  const fakeBin = path.join(localBinDir, "codex");
  fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    assert.equal(
      detectCodexBinary({
        env: { HOME: tmpHome, PATH: "" },
        platform: "linux",
      }),
      fakeBin
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("isCodexInstalled returns false when no codex binary is reachable", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-noinstall-"));
  const tmpPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-codex-noinstall-path-"));

  try {
    assert.equal(
      isCodexInstalled({
        env: {
          HOME: tmpHome,
          PATH: tmpPathDir,
          CODEX_CLI_PATH: "",
          AGNT_CODEX_CLI_PATH: "",
        },
        platform: "linux",
      }),
      false
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpPathDir, { recursive: true, force: true });
  }
});

test("resolveActiveProvider skips Codex on Linux when only claude is installed", () => {
  // Build an env where:
  //  - no AGNT_PROVIDER / persistedId
  //  - PATH puts a fake `claude` first, then the system bins so the providers'
  //    `which` fallback can still spawn (PATH=just-fake-bin would make spawnSync
  //    fail to even find /usr/bin/which and short-circuit detection to false).
  //  - CODEX_CLI_PATH is empty so detect.js cannot short-circuit to Codex.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-resolve-home-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-resolve-bin-"));
  const fakeClaude = path.join(fakeBinDir, "claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const { provider, source } = resolveActiveProvider({
      env: {
        HOME: tmpHome,
        PATH: `${fakeBinDir}${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
        AGNT_PROVIDER: "",
        CODEX_CLI_PATH: "",
        AGNT_CODEX_CLI_PATH: "",
      },
    });

    assert.equal(provider?.id, "claude");
    assert.equal(source, "auto-detect");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("resolveActiveProvider still honors explicit AGNT_PROVIDER=codex even when codex is not installed", () => {
  // Explicit override must win regardless of detection — the spawn-time failure
  // is the user's responsibility once they pinned the provider by name.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-resolve-explicit-"));
  const tmpPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-resolve-explicit-path-"));

  try {
    const { provider, source } = resolveActiveProvider({
      env: {
        HOME: tmpHome,
        PATH: tmpPathDir,
        AGNT_PROVIDER: "codex",
        CODEX_CLI_PATH: "",
      },
    });

    assert.equal(provider?.id, "codex");
    assert.equal(source, "explicit");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpPathDir, { recursive: true, force: true });
  }
});
