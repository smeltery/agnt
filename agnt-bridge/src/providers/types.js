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
 * @typedef {Object} ProviderTranslator
 * @property {(line: string) => string|string[]|null} [outbound]
 *   — translate a bridge-side line (Codex JSON-RPC) into provider-native frames
 *     before send(). Return `null` to drop, a string to forward as one frame,
 *     or an array to split into multiple frames. Omit for identity pass-through.
 * @property {(line: string) => string|string[]|null} [inbound]
 *   — translate a provider-native line (e.g. Claude stream-json, opencode SSE)
 *     into bridge-side lines (Codex JSON-RPC) before bridge handling. Same
 *     return semantics as outbound.
 * @property {(info: object) => void} [handleStarted]
 *   — called when the underlying transport reports onStarted (e.g. once the
 *     opencode HTTP server is up and the host/port is known). Use to wire up
 *     deferred state in the translator instance.
 * @property {() => void} [handleClose]
 *   — called when the underlying transport closes; lets the translator clean
 *     up timers, in-flight work, etc.
 */

/**
 * @typedef {Object} TranslatorContext
 * @property {(line: string) => void} injectInbound
 *   — push a synthetic JSON-RPC line into the bridge as if it had arrived from
 *     the provider. Used to answer requests the provider does not handle natively
 *     (e.g. synthesizing a `thread/start` response with a placeholder threadId).
 * @property {ProviderTransport} transport — the raw transport instance.
 * @property {NodeJS.ProcessEnv} env
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
 * @property {(opts: {env: NodeJS.ProcessEnv}) => {id: string, appPath: string}} [desktopBundle]
 *   — macOS bundle metadata for providers that ship a companion desktop app
 *     (handoff, bundled CLI fallback, refresh nudges). Codex returns
 *     `{ id: "com.openai.codex", appPath: "/Applications/Codex.app" }`. Other
 *     providers omit this; desktop RPCs degrade gracefully when absent.
 * @property {() => string|null} [generatedImagesDir]
 *   — optional root directory the provider writes generated images to.
 *     workspace/readImage uses this to allowlist provider-generated previews
 *     beyond the bound repo and the host temp dirs.
 * @property {ProviderTranslator} [translate]
 *   — static translator (no per-connection state). Use createTranslator instead
 *     when state is needed.
 * @property {(ctx: TranslatorContext) => ProviderTranslator} [createTranslator]
 *   — factory invoked once per connection. Lets the shim hold per-connection
 *     state (threadId↔sessionId maps, in-flight turn tracking, ...) and inject
 *     synthetic inbound responses via ctx.injectInbound.
 * @property {Partial<Record<typeof PROVIDER_CAPABILITY_KEYS[number], boolean>>} capabilities
 */

/**
 * Wraps a raw provider transport with the provider's optional translator hooks.
 * If the provider exposes neither `translate` nor `createTranslator`, returns
 * the original transport unchanged.
 *
 * Translation directions:
 *   - outbound: bridge → provider. The translator may emit zero, one, or many
 *     frames per outbound JSON-RPC line, or use `ctx.injectInbound` to answer
 *     locally without ever touching the transport.
 *   - inbound: provider → bridge. The translator turns provider-native frames
 *     (Claude stream-json, opencode SSE, ...) into the Codex JSON-RPC envelopes
 *     the bridge already understands.
 *
 * @param {ProviderTransport} transport
 * @param {ProviderModule} provider
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {ProviderTransport}
 */
function withTranslator(transport, provider, { env = process.env } = {}) {
  const factory = typeof provider?.createTranslator === "function"
    ? provider.createTranslator
    : null;
  const staticTranslator = !factory && provider?.translate ? provider.translate : null;

  if (!factory && !staticTranslator) {
    return transport;
  }

  let inboundHandler = null;

  const injectInbound = (line) => {
    if (typeof line !== "string" || line.length === 0) return;
    if (typeof inboundHandler === "function") {
      try {
        inboundHandler(line);
      } catch (err) {
        console.error(`[agnt][${provider?.id || "?"}] injected inbound handler threw:`, err);
      }
    }
  };

  let translator = staticTranslator;
  if (factory) {
    try {
      translator = factory({ injectInbound, transport, env });
    } catch (err) {
      console.error(`[agnt][${provider?.id || "?"}] createTranslator threw:`, err);
      return transport;
    }
  }

  const outbound = typeof translator?.outbound === "function" ? translator.outbound : null;
  const inbound = typeof translator?.inbound === "function" ? translator.inbound : null;
  const handleStarted = typeof translator?.handleStarted === "function"
    ? translator.handleStarted
    : null;
  const handleClose = typeof translator?.handleClose === "function"
    ? translator.handleClose
    : null;

  return {
    mode: transport.mode,
    describe: () => transport.describe(),
    send(message) {
      if (!outbound) {
        transport.send(message);
        return;
      }
      let translated;
      try {
        translated = outbound(message);
      } catch (err) {
        console.error(`[agnt][${provider.id}] translator.outbound threw:`, err);
        return;
      }
      if (translated == null) return;
      const frames = Array.isArray(translated) ? translated : [translated];
      for (const frame of frames) {
        if (typeof frame === "string" && frame.length > 0) {
          transport.send(frame);
        }
      }
    },
    onMessage(handler) {
      inboundHandler = handler;
      if (!inbound) {
        transport.onMessage(handler);
        return;
      }
      transport.onMessage((line) => {
        let translated;
        try {
          translated = inbound(line);
        } catch (err) {
          console.error(`[agnt][${provider.id}] translator.inbound threw:`, err);
          return;
        }
        if (translated == null) return;
        const frames = Array.isArray(translated) ? translated : [translated];
        for (const frame of frames) {
          if (typeof frame === "string" && frame.length > 0) {
            handler(frame);
          }
        }
      });
    },
    onClose(handler) {
      transport.onClose((info) => {
        if (handleClose) {
          try { handleClose(info); } catch (err) {
            console.error(`[agnt][${provider.id}] translator.handleClose threw:`, err);
          }
        }
        handler?.(info);
      });
    },
    onError(handler) { transport.onError(handler); },
    onStarted(handler) {
      transport.onStarted((info) => {
        if (handleStarted) {
          try { handleStarted(info); } catch (err) {
            console.error(`[agnt][${provider.id}] translator.handleStarted threw:`, err);
          }
        }
        handler?.(info);
      });
    },
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
