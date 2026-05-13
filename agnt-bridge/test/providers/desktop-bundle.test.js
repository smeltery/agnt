// FILE: provider-desktop-bundle.test.js
// Purpose: Verifies the Codex provider exposes desktop bundle metadata, and that
//          other providers correctly omit it so bridge.js degrades gracefully.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/providers

const test = require("node:test");
const assert = require("node:assert/strict");
const codex = require("../../src/providers/codex/index");
const claude = require("../../src/providers/claude/index");
const opencode = require("../../src/providers/opencode/index");
const cursor = require("../../src/providers/cursor/index");

test("codex provider exposes desktopBundle with the Codex.app metadata by default", () => {
  const bundle = codex.desktopBundle({ env: {} });
  assert.equal(bundle.id, "com.openai.codex");
  assert.equal(bundle.appPath, "/Applications/Codex.app");
});

test("codex desktopBundle honors AGNT_CODEX_BUNDLE_ID override", () => {
  const bundle = codex.desktopBundle({ env: { AGNT_CODEX_BUNDLE_ID: "com.openai.codex.dev" } });
  assert.equal(bundle.id, "com.openai.codex.dev");
  assert.equal(bundle.appPath, "/Applications/Codex.app");
});

test("codex desktopBundle falls back to the default when override is empty/whitespace", () => {
  const bundle = codex.desktopBundle({ env: { AGNT_CODEX_BUNDLE_ID: "   " } });
  assert.equal(bundle.id, "com.openai.codex");
});

test("non-codex providers do not expose desktopBundle", () => {
  // Bridge.js gates the desktop bundle metadata on `typeof activeProvider.desktopBundle === "function"`,
  // so the contract is: optional hook, absent means "no desktop companion app".
  for (const provider of [claude, opencode, cursor]) {
    assert.equal(typeof provider.desktopBundle, "undefined", `${provider.id} should not expose desktopBundle`);
  }
});

test("codex provider still exposes generatedImagesDir (now plumbed through workspace-handler)", () => {
  // generatedImagesDir was already in the contract; this test pins the
  // expectation that Codex returns a non-empty string so bridge.js's
  // generatedImagesDir thunk has something to forward.
  assert.equal(typeof codex.generatedImagesDir, "function");
  const dir = codex.generatedImagesDir();
  assert.equal(typeof dir, "string");
  assert.ok(dir.length > 0);
});

test("non-codex providers omit generatedImagesDir (workspace-handler treats absence as null)", () => {
  for (const provider of [claude, opencode, cursor]) {
    assert.equal(typeof provider.generatedImagesDir, "undefined", `${provider.id} should not expose generatedImagesDir`);
  }
});
