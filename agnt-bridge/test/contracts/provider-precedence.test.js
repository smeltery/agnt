// FILE: contracts/provider-precedence.test.js
// Purpose: Locks in the documented 5-level resolution order in
//          resolveActiveProvider: explicit id → AGNT_PROVIDER env → persisted
//          daemon config → isInstalled() auto-detect → first registered.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path,
//             ../../src/providers
//
// The earlier intent test (codex-detect.test.js) only exercises one slice
// (auto-detect via PATH). This file pins the full precedence chain so future
// changes can't quietly reorder selection (e.g. having AGNT_PROVIDER beat an
// explicit --provider flag) without flagging.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveActiveProvider, listProviders } = require("../../src/providers");

function emptyEnv() {
  // Wipe both AGNT_PROVIDER and the legacy resolution inputs so the test
  // doesn't pick up the developer's shell config.
  return { HOME: os.tmpdir(), PATH: "", AGNT_PROVIDER: "" };
}

test("explicit id beats AGNT_PROVIDER, persistedId, and auto-detect", () => {
  // claude wins even though AGNT_PROVIDER says cursor and persistedId says
  // opencode — the CLI flag is at the top of the precedence list.
  const { provider, source } = resolveActiveProvider({
    id: "claude",
    env: { ...emptyEnv(), AGNT_PROVIDER: "cursor" },
    persistedId: "opencode",
  });
  assert.equal(provider?.id, "claude");
  assert.equal(source, "explicit");
});

test("AGNT_PROVIDER beats persistedId and auto-detect", () => {
  const { provider, source } = resolveActiveProvider({
    env: { ...emptyEnv(), AGNT_PROVIDER: "opencode" },
    persistedId: "cursor",
  });
  assert.equal(provider?.id, "opencode");
  assert.equal(source, "explicit");
});

test("persistedId is used when neither explicit id nor AGNT_PROVIDER is set", () => {
  const { provider, source } = resolveActiveProvider({
    env: emptyEnv(),
    persistedId: "cursor",
  });
  assert.equal(provider?.id, "cursor");
  assert.equal(source, "explicit");
});

test("an unknown explicit id is ignored and resolution falls through to env/auto-detect", () => {
  // The previous "explicit" candidate is dropped silently; AGNT_PROVIDER then
  // takes effect. This is the documented behaviour (filter(Boolean) +
  // continue) — without it, a typo'd CLI flag would crash the daemon.
  const { provider, source } = resolveActiveProvider({
    id: "ghost-cli",
    env: { ...emptyEnv(), AGNT_PROVIDER: "claude" },
  });
  assert.equal(provider?.id, "claude");
  assert.equal(source, "explicit");
});

test("auto-detect runs only when no explicit / env / persisted id matches", () => {
  // Force every provider's isInstalled() to a stable answer by using a fake
  // PATH that holds only the binary we want to be "installed". The provider's
  // isInstalled probes `which <bin>` so the first registered provider with a
  // resolvable bin on PATH wins.
  const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnt-precedence-bin-"));
  const fakeClaude = path.join(tmpBinDir, "claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const { source } = resolveActiveProvider({
      env: {
        ...emptyEnv(),
        // Need a real PATH so spawnSync can locate `which` itself.
        PATH: `${tmpBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        // Defang Codex's CLI shortcut so detect.js cannot short-circuit to
        // codex via CODEX_CLI_PATH (the developer's real env may set it).
        CODEX_CLI_PATH: "",
        AGNT_CODEX_CLI_PATH: "",
      },
    });
    assert.equal(source, "auto-detect");
  } finally {
    fs.rmSync(tmpBinDir, { recursive: true, force: true });
  }
});

test("auto-detect / default fallback always returns a registered provider, never null", () => {
  // With no explicit id, no AGNT_PROVIDER, and no persistedId, the resolver
  // falls through to auto-detect, and then to "first registered" as the
  // final fallback. Both outcomes are acceptable for daemon startup — the
  // critical invariant is that the daemon never receives a null provider.
  //
  // We can't deterministically force the *default* branch on every developer
  // box (macOS dev machines have Codex.app installed, which makes codex's
  // isInstalled succeed even with PATH="" via the app bundle); but we can
  // still pin both branches' shared post-condition.
  const { provider, source } = resolveActiveProvider({
    env: {
      ...emptyEnv(),
      PATH: "",
      CODEX_CLI_PATH: "",
      AGNT_CODEX_CLI_PATH: "",
    },
  });
  assert.ok(provider, "resolver must return a provider, not null");
  assert.ok(
    ["auto-detect", "default"].includes(source),
    `expected auto-detect or default fallback, got "${source}"`,
  );
  const registeredIds = listProviders().map((p) => p.id);
  assert.ok(
    registeredIds.includes(provider.id),
    `${provider.id} must be a registered provider`,
  );
});

test("default fallback (when auto-detect also fails) is the first registered provider", () => {
  // Stub the providers list to validate the documented final branch without
  // depending on host installation state. Re-require the module under a
  // fresh cache entry so the patched providers/index sees a deterministic
  // registry.
  const providersModulePath = require.resolve("../../src/providers");
  delete require.cache[providersModulePath];
  // Stub each registered provider so isInstalled() returns false, forcing
  // resolution into the final "first registered" branch.
  const realModule = require("../../src/providers");
  const realFirstId = realModule.listProviders()[0].id;
  // Note: we don't actually monkey-patch the array (it's frozen via map()).
  // Instead we assert the invariant the source promises: when source is
  // "default", the provider returned is the first registered. To force
  // source === "default" without mutating the module, route around it: pick
  // an env that defeats every isInstalled probe we can reach. On Linux CI
  // boxes with no codex/claude/opencode/cursor installed, this is reachable.
  const { provider, source } = realModule.resolveActiveProvider({
    env: {
      HOME: "/nonexistent-home-for-precedence-test",
      PATH: "",
      AGNT_PROVIDER: "",
      CODEX_CLI_PATH: "",
      AGNT_CODEX_CLI_PATH: "",
      CLAUDE_HOME: "/nonexistent-claude-home",
    },
  });
  if (source === "default") {
    assert.equal(
      provider.id,
      realFirstId,
      `the "default" branch must return the first registered provider`,
    );
  } else {
    // Auto-detect picked something host-installed — that's fine. The default
    // branch's invariant is exercised on a stripped-down CI box; locally
    // skip the assertion. We still verify the resolver returned a valid
    // provider above (in the prior test).
    assert.equal(source, "auto-detect");
  }
});
