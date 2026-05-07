# Adding a new provider

This is the playbook for adding support for a new agent CLI. It assumes you've read [`../architecture/provider-contract.md`](../architecture/provider-contract.md) and [`../architecture/translator-shim.md`](../architecture/translator-shim.md).

## When you don't need a new provider

Before scaffolding, sanity-check:

- **Is the CLI a wrapper around an existing one?** Some agent CLIs are forks/wrappers of `claude` or `opencode` and might just need a config tweak instead of a new provider.
- **Does it speak Codex JSON-RPC natively?** If yes, you can probably reuse the Codex transport (`createTransport`) and skip the translator entirely.

If you're sure you need a new provider, continue.

## Pre-flight: research the CLI

Before writing code, answer these about the target CLI:

| Question | Why it matters |
|---|---|
| Is there a non-interactive / streaming mode? | Determines if a translator is even feasible |
| What's the output format? (NDJSON, SSE, custom binary, …) | Determines `inbound()` parsing |
| Does it accept stdin frames or is the prompt CLI-only? | Long-lived (Claude) vs. spawn-per-turn (Cursor) transport |
| Does it persist sessions on disk? Where? Format? | Whether `thread/turns/list` can reconstruct from disk |
| Is there a runtime approval channel? | Whether iOS can prompt for tool approvals (opencode) or it's auto-accept (Claude/Cursor) |
| Does it support `--resume <session_id>`? | Whether mid-conversation transport restarts work |
| What model / effort / plan flags exist? | What `setTurnArgs()` needs to publish |
| Are there any auth requirements beyond installing the CLI? | Whether `bootstrap()` needs to nudge the user |

The cursor research at the top of `docs/recaps/` (and the recap files in general) shows what this looks like in practice.

## Scaffold

Create the directory and four files:

```
agnt-bridge/src/providers/<id>/
├── index.js          # defineProvider({...}) — wire everything together
├── detect.js         # locate the binary on PATH or via env override
├── transport.js      # spawn / connect to the CLI
└── translate.js      # protocol shim (skip if native JSON-RPC)
```

The Cursor provider is the cleanest reference because it's the most recently added — copy `agnt-bridge/src/providers/cursor/` as a starting template if your CLI uses spawn-per-turn, or `agnt-bridge/src/providers/claude/` for long-lived stdin.

## Step 1: `detect.js`

```js
// FILE: providers/<id>/detect.js
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BIN_NAMES = ["<your-cli-binary>"];

function detect<Id>Binary({ env = process.env } = {}) {
  // 1. Explicit override
  const explicit = String(env.<ID>_CLI_PATH || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. Common install paths (Homebrew, npm, custom)
  const candidates = [
    path.join(env.HOME || "", ".local", "bin", BIN_NAMES[0]),
    "/opt/homebrew/bin/" + BIN_NAMES[0],
    "/usr/local/bin/" + BIN_NAMES[0],
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. PATH lookup
  try {
    const result = spawnSync("which", [BIN_NAMES[0]], { env, encoding: "utf8" });
    const found = (result.stdout || "").trim().split("\n")[0];
    if (found && fs.existsSync(found)) return found;
  } catch { /* ignore */ }

  return "";
}

function is<Id>Installed({ env } = {}) {
  return Boolean(detect<Id>Binary({ env }));
}

module.exports = { detect<Id>Binary, is<Id>Installed };
```

## Step 2: `transport.js`

For spawn-per-turn (most common for new providers): copy `cursor/transport.js`. For long-lived stdin: copy `claude/transport.js`.

The transport must:

- Spawn the CLI lazily on first `send()` (or eagerly if the CLI is server-style like opencode).
- Buffer stdout by line, emit each line via `onMessage(line)`.
- Forward stderr to console with a `[agnt][<id>]` prefix.
- Support `interruptTurn()` (SIGINT or equivalent) without crashing.
- Support `setResumeSessionId(id)`, `setTurnArgs(args)`, `setCwd(cwd)` if the translator needs them.
- Surface a `started` event after spawn (or right away if there's no spawn — see Cursor's `setImmediate`).
- Surface `close` only for unexpected exits — silent for soft-interrupt-then-respawn.

## Step 3: `translate.js` (the hard part)

The translator owns per-connection state. Standard skeleton:

```js
// FILE: providers/<id>/translate.js
const crypto = require("crypto");

const PROTO_VERSION = "1.0.0-<id>-shim";

function create<Id>Translator({ injectInbound, transport, env = process.env } = {}) {
  // ── per-connection state ─────────────────────────────────
  let threadId = "";
  let sessionId = "";
  let activeTurnId = "";
  // ...whatever your CLI needs

  return { outbound, inbound, handleStarted, handleClose };

  function outbound(line) {
    const parsed = safeParseJson(line);
    if (!parsed?.method) return null;

    if (parsed.method === "initialize") {
      injectResponse(parsed.id, {
        protocolVersion: PROTO_VERSION,
        serverInfo: { name: "<id>-shim", version: PROTO_VERSION },
        capabilities: {},
      });
      return null;
    }

    if (parsed.method === "thread/start") {
      // Synthesize a thread id and respond locally.
      threadId = `thr_${crypto.randomBytes(12).toString("hex")}`;
      injectResponse(parsed.id, { thread: { id: threadId, ... } });
      injectInbound(JSON.stringify({ method: "thread/started", params: { threadId } }));
      return null;
    }

    if (parsed.method === "turn/start") {
      // Reject overlapping turns
      if (activeTurnId) {
        respondError(parsed.id, -32003, "A turn is already in flight on this thread");
        return null;
      }
      // ...build a provider-native frame from params.input and return it
    }

    // Other methods: thread/read, thread/turns/list, turn/interrupt, ...
  }

  function inbound(line) {
    // Parse provider-native frame, emit JSON-RPC notifications via injectInbound
  }

  function handleStarted() {}
  function handleClose() { /* emit synthetic turn/failed if a turn is mid-flight */ }

  // helpers
  function emitNotification(method, params) { injectInbound(JSON.stringify({ method, params })); }
  function injectResponse(id, result) { injectInbound(JSON.stringify({ id, result })); }
  function respondError(id, code, message) { if (id != null) injectInbound(JSON.stringify({ id, error: { code, message } })); }
}

function safeParseJson(line) { try { return JSON.parse(line); } catch { return null; } }

module.exports = { create<Id>Translator };
```

### Methods every shim should handle

These come up in every iOS session — handle them explicitly even if the answer is just "not supported":

| Method | Min behavior |
|---|---|
| `initialize` / `client/initialize` | respond with protocol version + capabilities |
| `thread/start` | synthesize threadId, respond, emit `thread/started` |
| `turn/start` | translate input → native frame, emit `turn/started`, reject overlaps with `-32003` |
| `turn/interrupt` | call `transport.interruptTurn()`, emit synthetic `turn/failed` + `turn/completed` |
| `turn/steer` | reject with `-32601` if not supported |
| `thread/read` | reconstruct from session files on disk |
| `thread/turns/list` | reconstruct from session files on disk |
| `thread/list` | summaries from session directory |
| `thread/contextWindow/read` | best-effort or null |
| `thread/generateTitle` | local heuristic (truncate first message) |
| `thread/name/set` | ack with `{ok: true}` |
| `thread/compact/start` | ack with `{compacted: false, reason: "..._cli_compact_unsupported"}` if no native compact |

Anything else: respond with `-32601` `"<id> provider does not support method: ..."`.

## Step 4: `index.js`

```js
// FILE: providers/<id>/index.js
const path = require("path");
const os = require("os");
const { defineProvider } = require("../types");
const { create<Id>Transport } = require("./transport");
const { detect<Id>Binary, is<Id>Installed } = require("./detect");
const { create<Id>Translator } = require("./translate");

function resolve<Id>Home() {
  return process.env.<ID>_HOME || path.join(os.homedir(), ".<id>");
}

module.exports = defineProvider({
  id: "<id>",
  displayName: "<DisplayName>",
  binCandidates: ["<bin-name>"],
  capabilities: {
    plan: false,
    fastMode: false,
    subagents: false,
    steerActiveTurn: false,
    queueFollowup: false,
    reasoningDeltas: false,
    desktopRefresher: false,
    rolloutMirror: false,
  },
  homeDir: resolve<Id>Home,
  sessionsDir() { return path.join(resolve<Id>Home(), "sessions"); },
  isInstalled({ env } = {}) { return is<Id>Installed({ env }); },
  createTransport(opts = {}) { return create<Id>Transport(opts); },
  createTranslator(ctx) { return create<Id>Translator(ctx); },
  async bootstrap({ env = process.env, logger = console } = {}) {
    if (detect<Id>Binary({ env })) return { status: "found" };
    logger.warn?.(
      "[agnt] <id> provider: `<bin-name>` CLI not found on PATH. "
      + "Install with `<install-command>` to enable this provider."
    );
    return { status: "missing" };
  },
});
```

**Set capabilities to false until you actually implement them.** `false` is always safe; `true` requires real logic.

## Step 5: register

Edit `agnt-bridge/src/providers/index.js`:

```js
const codex = require("./codex");
const claude = require("./claude");
const opencode = require("./opencode");
const cursor = require("./cursor");
const myProvider = require("./<id>");  // ← add this
const { validateProviderModule } = require("./types");

const PROVIDERS = [codex, claude, opencode, cursor, myProvider]  // ← and here
  .map(validateProviderModule);
```

Position in the array decides the auto-detect priority — earlier wins.

## Step 6: tests

Create `agnt-bridge/test/<id>-translate.test.js`. Cursor's test file (20 tests) is the cleanest template.

Minimum coverage:

- `thread/start` synthesizes a thread + emits `thread/started`
- `turn/start` produces a provider-native frame, acks the request, emits `turn/started`
- Empty input → graceful failure
- Overlapping `turn/start` rejected with `-32003`
- `turn/interrupt` calls `transport.interruptTurn()` AND emits synthetic events
- session_id mirrored to `transport.setResumeSessionId()`
- One full happy-path streaming test (assistant frames → deltas → result → completed)
- Tool-call frame mapping (one per tool kind your CLI emits)
- `thread/turns/list` reconstructs from disk fixture
- `thread/compact` / `thread/name/set` / unsupported-method-rejection

Run: `npm test --prefix agnt-bridge -- ./test/<id>-translate.test.js`.

## Step 7: docs

Add `docs/providers/<id>.md` (use Cursor's as a template) and update:

- `docs/providers/overview.md` — add a row to the matrix
- `README.md` — add to the provider matrix and quickstart
- `AGENTS.md` and `CLAUDE.md` — add any provider-specific guardrails (e.g. "Cursor is spawn-per-turn, don't repurpose Claude's stdin pattern")

## Step 8: smoke test

End-to-end:

```sh
# Force the new provider
./scripts/run-local-agnt.sh --provider <id>
```

- Scan the QR with the iOS app.
- Send a message; verify streaming text + tool calls + final result.
- Tap Stop mid-turn; verify the iOS UI exits the spinner.
- Reopen the app; verify thread history reconstructs.

## Pitfalls to avoid

- **Don't read `params.model` directly in the transport.** Keep model→flag mapping in `translate.js` (`publishTurnArgsForParams`) and let the transport stay mechanical.
- **Don't reintroduce direct provider imports in `bridge.js`.** Always go through `resolveActiveProvider()` and capability flags.
- **Don't claim capabilities you don't have.** Setting `reasoningDeltas: true` without actually emitting reasoning frames will leave iOS rendering empty Thinking bubbles.
- **Don't log `sessionId` values.** They're bearer tokens. Redact them or hash them.
- **Don't generalize the Codex JSONL fallback.** Other providers' rollout schemas don't match Codex's — write provider-specific reconstruction in `translate.js` instead.
