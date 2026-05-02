// FILE: providers/index.js
// Purpose: Provider registry. Adds new agent CLIs by importing their module here.
// Layer: provider plugin registry
// Exports: getProvider, listProviders, resolveActiveProvider
// Depends on: ./codex, ./claude, ./opencode, ./types

const codex = require("./codex");
const claude = require("./claude");
const opencode = require("./opencode");
const { validateProviderModule } = require("./types");

// Order matters: first entry wins as default fallback when none configured.
const PROVIDERS = [codex, claude, opencode].map(validateProviderModule);
const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function listProviders() {
  return PROVIDERS.slice();
}

function getProvider(id) {
  if (!id) return null;
  return PROVIDERS_BY_ID.get(String(id).toLowerCase()) || null;
}

/**
 * Resolve the active provider given an explicit choice, env, and persisted config.
 * Resolution order:
 *   1. explicit `id` argument (CLI flag --provider)
 *   2. AGNT_PROVIDER env var
 *   3. persisted daemon config (caller passes via `persistedId`)
 *   4. first registered provider whose `isInstalled?()` returns true (when defined)
 *   5. first registered provider
 */
function resolveActiveProvider({
  id = "",
  env = process.env,
  persistedId = "",
} = {}) {
  const candidates = [
    id,
    env.AGNT_PROVIDER,
    persistedId,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = getProvider(candidate);
    if (match) {
      return { provider: match, source: "explicit" };
    }
  }

  for (const provider of PROVIDERS) {
    if (typeof provider.isInstalled === "function") {
      try {
        if (provider.isInstalled({ env })) {
          return { provider, source: "auto-detect" };
        }
      } catch {
        // ignore detection errors
      }
    }
  }

  return { provider: PROVIDERS[0] || null, source: "default" };
}

module.exports = {
  PROVIDERS,
  getProvider,
  listProviders,
  resolveActiveProvider,
};
