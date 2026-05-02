// FILE: providers/types.js
// Purpose: JSDoc shape + helpers for the provider plugin contract. Each agent CLI
//          (Codex, Claude Code, opencode, ...) implements this interface so the
//          bridge core can stay agent-agnostic.
// Layer: provider contract
// Exports: PROVIDER_CAPABILITY_KEYS, validateProviderModule, defineProvider

const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "plan",            // structured plan-mode supported
  "fastMode",        // low-latency turn variant
  "subagents",       // /subagents command
  "steerActiveTurn", // mid-turn steering
  "queueFollowup",   // queue prompt while turn active
  "reasoningDeltas", // emits reasoning deltas
  "desktopRefresher",// has companion desktop app to nudge
  "rolloutMirror",   // exposes on-disk session/rollout files
]);

/**
 * @typedef {Object} ProviderTransport
 * @property {"spawn"|"websocket"|"http"} mode
 * @property {() => string} describe
 * @property {(message: string) => void} send
 * @property {(handler: (line: string) => void) => void} onMessage
 * @property {(handler: (info: object) => void) => void} onClose
 * @property {(handler: (err: Error) => void) => void} onError
 * @property {(handler: () => void) => void} onStarted
 * @property {() => void} shutdown
 */

/**
 * @typedef {Object} ProviderTranslate
 * @property {(line: string) => string|string[]|null} [outbound]
 *   — translate a bridge-side line (Codex JSON-RPC) into provider-native frames
 *     before send(). Return `null` to drop, a string to forward as one frame,
 *     or an array to split into multiple frames. Omit for identity pass-through.
 * @property {(line: string) => string|string[]|null} [inbound]
 *   — translate a provider-native line (e.g. Claude stream-json, opencode SSE)
 *     into bridge-side lines (Codex JSON-RPC) before bridge handling. Same
 *     return semantics as outbound.
 */

/**
 * @typedef {Object} ProviderModule
 * @property {string} id            — short stable id, e.g. "codex"
 * @property {string} displayName   — human label, e.g. "Codex"
 * @property {string[]} binCandidates — names/paths to look up the agent CLI
 * @property {(opts: object) => ProviderTransport} createTransport
 * @property {() => string} homeDir       — `~/.codex`, `~/.claude`, ...
 * @property {() => string} sessionsDir   — where session/rollout files live
 * @property {(line: string) => object|null} [parseRolloutLine]  — provider-specific JSONL parsing
 * @property {() => Promise<void>} [bootstrap] — postinstall hook
 * @property {(opts: object) => object} [createDesktopRefresher]
 * @property {ProviderTranslate} [translate] — optional protocol shim (identity if absent)
 * @property {Partial<Record<typeof PROVIDER_CAPABILITY_KEYS[number], boolean>>} capabilities
 */

/**
 * Wraps a raw provider transport with the provider's optional translate hooks.
 * If neither hook is set, returns the original transport unchanged.
 * @param {ProviderTransport} transport
 * @param {ProviderModule} provider
 * @returns {ProviderTransport}
 */
function withTranslator(transport, provider) {
  const outbound = provider?.translate?.outbound;
  const inbound = provider?.translate?.inbound;
  if (typeof outbound !== "function" && typeof inbound !== "function") {
    return transport;
  }

  return {
    mode: transport.mode,
    describe: () => transport.describe(),
    send(message) {
      if (typeof outbound !== "function") {
        transport.send(message);
        return;
      }
      const translated = outbound(message);
      if (translated == null) return;
      const frames = Array.isArray(translated) ? translated : [translated];
      for (const frame of frames) {
        if (typeof frame === "string" && frame.length > 0) {
          transport.send(frame);
        }
      }
    },
    onMessage(handler) {
      if (typeof inbound !== "function") {
        transport.onMessage(handler);
        return;
      }
      transport.onMessage((line) => {
        const translated = inbound(line);
        if (translated == null) return;
        const frames = Array.isArray(translated) ? translated : [translated];
        for (const frame of frames) {
          if (typeof frame === "string" && frame.length > 0) {
            handler(frame);
          }
        }
      });
    },
    onClose(handler) { transport.onClose(handler); },
    onError(handler) { transport.onError(handler); },
    onStarted(handler) { transport.onStarted(handler); },
    shutdown() { transport.shutdown(); },
  };
}

function validateProviderModule(mod) {
  if (!mod || typeof mod !== "object") {
    throw new Error("Provider module must be an object.");
  }
  const requiredString = ["id", "displayName"];
  for (const key of requiredString) {
    if (typeof mod[key] !== "string" || mod[key].length === 0) {
      throw new Error(`Provider missing required string field "${key}".`);
    }
  }
  if (typeof mod.createTransport !== "function") {
    throw new Error(`Provider "${mod.id}" missing createTransport(opts).`);
  }
  if (typeof mod.homeDir !== "function") {
    throw new Error(`Provider "${mod.id}" missing homeDir().`);
  }
  if (typeof mod.sessionsDir !== "function") {
    throw new Error(`Provider "${mod.id}" missing sessionsDir().`);
  }
  if (!mod.capabilities || typeof mod.capabilities !== "object") {
    throw new Error(`Provider "${mod.id}" missing capabilities object.`);
  }
  return mod;
}

function defineProvider(mod) {
  return validateProviderModule(mod);
}

module.exports = {
  PROVIDER_CAPABILITY_KEYS,
  validateProviderModule,
  defineProvider,
  withTranslator,
};
