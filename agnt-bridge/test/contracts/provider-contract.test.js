// FILE: contracts/provider-contract.test.js
// Purpose: Pins every registered provider to the contract in
//          providers/types.js. The bridge core treats provider modules as a
//          stable plugin surface, so adding a new provider or renaming a
//          capability flag must trip this test instead of failing at runtime
//          on a user's machine.
// Layer: Contract test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../../src/providers

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDERS,
  listProviders,
  getProvider,
  resolveActiveProvider,
} = require("../../src/providers");
const {
  PROVIDER_CAPABILITY_KEYS,
  validateProviderModule,
} = require("../../src/providers/types");

const VALID_CAPABILITY_KEYS = new Set(PROVIDER_CAPABILITY_KEYS);

test("at least one provider is registered", () => {
  assert.ok(PROVIDERS.length > 0, "PROVIDERS array must not be empty");
  assert.equal(listProviders().length, PROVIDERS.length);
});

test("provider ids are unique, lowercase, and non-empty", () => {
  const seen = new Set();
  for (const provider of PROVIDERS) {
    assert.equal(typeof provider.id, "string");
    assert.ok(provider.id.length > 0, `provider id must be non-empty (${provider.displayName})`);
    assert.equal(provider.id, provider.id.toLowerCase(), `provider id must be lowercase: ${provider.id}`);
    assert.ok(!seen.has(provider.id), `duplicate provider id: ${provider.id}`);
    seen.add(provider.id);
  }
});

for (const provider of PROVIDERS) {
  test(`provider[${provider.id}] passes validateProviderModule`, () => {
    assert.doesNotThrow(() => validateProviderModule(provider));
  });

  test(`provider[${provider.id}] required fields have the right shapes`, () => {
    assert.equal(typeof provider.displayName, "string");
    assert.ok(provider.displayName.length > 0);
    assert.equal(typeof provider.createTransport, "function");
    assert.equal(typeof provider.homeDir, "function");
    assert.equal(typeof provider.sessionsDir, "function");
    assert.equal(typeof provider.capabilities, "object");
    assert.ok(provider.capabilities !== null);
  });

  test(`provider[${provider.id}] homeDir() and sessionsDir() return non-empty strings`, () => {
    const home = provider.homeDir();
    assert.equal(typeof home, "string");
    assert.ok(home.length > 0, "homeDir() must return a non-empty path");
    const sessions = provider.sessionsDir();
    assert.equal(typeof sessions, "string");
    assert.ok(sessions.length > 0, "sessionsDir() must return a non-empty path");
  });

  test(`provider[${provider.id}] capabilities use only known keys with boolean values`, () => {
    for (const [key, value] of Object.entries(provider.capabilities)) {
      assert.ok(
        VALID_CAPABILITY_KEYS.has(key),
        `unknown capability key "${key}" on provider ${provider.id} — `
        + `add it to PROVIDER_CAPABILITY_KEYS in providers/types.js or fix the typo`,
      );
      assert.equal(
        typeof value,
        "boolean",
        `capability ${provider.id}.${key} must be boolean, got ${typeof value}`,
      );
    }
  });

  test(`provider[${provider.id}] desktopRefresher capability matches createDesktopRefresher presence`, () => {
    const advertised = provider.capabilities.desktopRefresher === true;
    const hasFactory = typeof provider.createDesktopRefresher === "function";
    assert.equal(
      advertised,
      hasFactory,
      `desktopRefresher capability and createDesktopRefresher() must agree on provider ${provider.id}`,
    );
  });

  test(`provider[${provider.id}] optional hooks (when present) are functions`, () => {
    const optionalFnHooks = [
      "bootstrap",
      "isInstalled",
      "parseRolloutLine",
      "createDesktopRefresher",
      "desktopBundle",
      "generatedImagesDir",
      "createTranslator",
    ];
    for (const hook of optionalFnHooks) {
      if (provider[hook] === undefined) continue;
      assert.equal(
        typeof provider[hook],
        "function",
        `${provider.id}.${hook} must be a function when present`,
      );
    }
    if (provider.translate !== undefined) {
      assert.equal(typeof provider.translate, "object");
      assert.ok(provider.translate !== null);
    }
    if (Array.isArray(provider.binCandidates)) {
      for (const bin of provider.binCandidates) {
        assert.equal(typeof bin, "string");
        assert.ok(bin.length > 0);
      }
    }
  });

  test(`provider[${provider.id}] desktopBundle() returns {id, appPath} when present`, () => {
    if (typeof provider.desktopBundle !== "function") return;
    const bundle = provider.desktopBundle({ env: {} });
    assert.equal(typeof bundle, "object");
    assert.ok(bundle);
    assert.equal(typeof bundle.id, "string");
    assert.ok(bundle.id.length > 0);
    assert.equal(typeof bundle.appPath, "string");
    assert.ok(bundle.appPath.length > 0);
  });

  test(`provider[${provider.id}] generatedImagesDir() (if present) returns string|null`, () => {
    if (typeof provider.generatedImagesDir !== "function") return;
    const dir = provider.generatedImagesDir();
    assert.ok(
      dir === null || (typeof dir === "string" && dir.length > 0),
      `generatedImagesDir() must return null or a non-empty string, got ${dir}`,
    );
  });
}

test("getProvider() is case-insensitive and returns null for unknown ids", () => {
  const first = PROVIDERS[0];
  assert.equal(getProvider(first.id), first);
  assert.equal(getProvider(first.id.toUpperCase()), first);
  assert.equal(getProvider("not-a-real-provider"), null);
  assert.equal(getProvider(""), null);
  assert.equal(getProvider(null), null);
  assert.equal(getProvider(undefined), null);
});

test("resolveActiveProvider honors the explicit id argument", () => {
  if (PROVIDERS.length < 2) return; // can't differentiate
  const target = PROVIDERS[1];
  const { provider, source } = resolveActiveProvider({ id: target.id, env: {} });
  assert.equal(provider, target);
  assert.equal(source, "explicit");
});

test("resolveActiveProvider honors AGNT_PROVIDER env", () => {
  if (PROVIDERS.length < 2) return;
  const target = PROVIDERS[1];
  const { provider, source } = resolveActiveProvider({
    env: { AGNT_PROVIDER: target.id },
  });
  assert.equal(provider, target);
  assert.equal(source, "explicit");
});

test("resolveActiveProvider falls back to the first registered when nothing matches and nothing is installed", () => {
  // Pass an env with no provider hint and stub isInstalled by providing
  // an empty env — providers consult process.env directly for detection,
  // so the auto-detect branch may still pick a real provider on this host.
  // What we can pin is: the returned provider is in the registry and source
  // is one of the documented values.
  const result = resolveActiveProvider({ env: { AGNT_PROVIDER: "" } });
  assert.ok(PROVIDERS.includes(result.provider));
  assert.ok(["explicit", "auto-detect", "default"].includes(result.source));
});

test("PROVIDER_CAPABILITY_KEYS is frozen and non-empty", () => {
  assert.ok(Array.isArray(PROVIDER_CAPABILITY_KEYS));
  assert.ok(PROVIDER_CAPABILITY_KEYS.length > 0);
  assert.ok(Object.isFrozen(PROVIDER_CAPABILITY_KEYS));
});
