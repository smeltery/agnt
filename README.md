# agnt

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Control coding-agent CLIs from your iPhone — **Codex**, **Claude Code**, **opencode**, and any other agent you plug in. **agnt** is a local-first, open-source bridge + iOS app that keeps the agent runtime on your Mac and lets your phone connect through a paired secure session.

> agnt is a fork of [Remodex](https://github.com/Emanuele-web04/remodex) (Apache-2.0). The original tool brokers iOS ↔ Codex; agnt generalises the transport behind a provider plugin contract so other agents can be added without touching bridge core.

> **Status: early.**

## Provider matrix

| Provider | Detect | Transport | Protocol shim | Ready for paired phone? |
|---|---|---|---|---|
| **Codex** | ✓ | ✓ spawn `codex app-server` | n/a (native) | ✓ feature-parity with Remodex |
| **Claude Code** | ✓ via `which`/npm-global/Homebrew | ✓ spawn `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --verbose` | ✓ stream-json ↔ Codex JSON-RPC (`providers/claude/translate.js`) | ✓ chat, tools, interrupts, model/effort/plan, approvals via `--permission-mode` |
| **opencode** | ✓ via `which`/Homebrew/`~/.bun` | ✓ spawn `opencode serve` + SSE on `/event` + REST POSTs | ✓ REST/SSE ↔ Codex JSON-RPC (`providers/opencode/translate.js`) | ✓ chat, tools, runtime approvals, compact, fork, MCP-auth notices |

Each shim is a stateful translator instantiated per bridge connection via `provider.createTranslator(ctx)`. The shim can synthesize Codex JSON-RPC responses (e.g. `thread/start`, `thread/read`, `thread/turns/list`) without round-tripping the CLI by calling `ctx.injectInbound(line)`. See `agnt-bridge/src/providers/types.js` for the contract and `providers/{claude,opencode}/translate.js` for working implementations.

## Why a fork

The Remodex bridge is well-built but assumes one agent: Codex. agnt:

- Defines a provider plugin contract (`agnt-bridge/src/providers/types.js`) with `createTranslator(ctx)` for protocol shimming and `ctx.injectInbound(line)` for synthesizing JSON-RPC responses locally.
- Ships full Codex-JSON-RPC ↔ Claude-stream-json and Codex-JSON-RPC ↔ opencode-REST/SSE translators, including model/effort/plan flag mapping, soft turn interrupt with auto-respawn, mid-session cwd switching, runtime approval round-trips, and concurrent-turn safety.
- Routes the bridge's transport, desktop refresher, rollout watcher, and bootstrap through the active provider; gates Codex-only RPCs (ChatGPT auth, voice transcribe, structured-JSON title drafting) on `activeProvider.id === "codex"` so non-Codex providers degrade cleanly instead of hanging.
- Selects the active provider via `--provider <id>`, `AGNT_PROVIDER` env, persisted daemon-state, `isInstalled()` auto-detect, then first registered.
- Uses `AGNT_*` for every env name. No alias prefixes.

## Architecture

```
┌──────────────┐       Paired session   ┌───────────────┐       provider transport ┌─────────────┐
│  agnt iOS    │ ◄────────────────────► │ agnt (Mac)    │ ◄──────────────────────► │  agent CLI  │
│  app         │    WebSocket bridge    │ bridge        │   stdio JSON-RPC / WS    │ (codex,     │
└──────────────┘                        └───────────────┘                          │  claude,    │
                                               │                                   │  opencode)  │
                                               │  optional desktop refresher       └─────────────┘
                                               ▼
                                        ┌─────────────┐
                                        │ Provider's  │
                                        │ desktop app │
                                        │ (optional)  │
                                        └─────────────┘
```

1. Run `agnt up` on your Mac (optionally `--provider <id>` to force one).
2. On macOS, agnt installs/starts a background bridge service via `launchd` and prints a QR for first-time pairing or recovery.
3. Scan the QR once with the agnt iOS app to trust that Mac.
4. After the first handshake, the iPhone resolves the Mac's live session through the configured relay and reconnects automatically.
5. The bridge speaks to the chosen agent through that provider's transport, and proxies events back to the phone.
6. Git actions and local session persistence run on your Mac.

## Repository layout

```
├── agnt-bridge/                  # Node.js bridge package (`@dotbrains/agnt`)
│   ├── bin/agnt.js               # CLI entrypoint
│   └── src/
│       ├── providers/            # Provider plugins
│       │   ├── types.js          # Contract + capability flags + withTranslator
│       │   ├── index.js          # Registry + resolveActiveProvider()
│       │   ├── codex/            # Codex provider (native JSON-RPC)
│       │   │   ├── transport.js          # spawn/WebSocket transport
│       │   │   ├── desktop-refresher.js  # macOS Codex.app companion mirror
│       │   │   ├── cli-bootstrap.js
│       │   │   └── home.js
│       │   ├── claude/           # Claude Code provider
│       │   │   ├── transport.js          # spawn `claude --print` w/ soft interrupt
│       │   │   ├── translate.js          # stream-json ↔ Codex JSON-RPC shim
│       │   │   └── detect.js
│       │   └── opencode/         # opencode provider
│       │       ├── transport.js          # spawn `opencode serve` + http client
│       │       ├── translate.js          # REST/SSE ↔ Codex JSON-RPC shim
│       │       └── detect.js
│       ├── bridge.js             # Provider-agnostic bridge core
│       ├── secure-transport.js   # E2E-encrypted relay framing
│       ├── git-handler.js        # Local git ops + thread title drafting
│       └── ...
├── AgntMobile/                   # Xcode project root (iOS app)
├── relay/                        # Optional local relay server
└── run-local-agnt.sh             # Spin up local relay + foreground bridge
```

## Prerequisites

- **Node.js** v18+
- At least one supported agent CLI in PATH:
  - **[Codex CLI](https://github.com/openai/codex)** — native, full feature parity with Remodex
  - **[Claude Code](https://docs.claude.com/en/docs/claude-code)** — full chat, tools, interrupt, approvals
  - **[opencode](https://opencode.ai)** — full chat, tools, runtime approvals, compact, fork
- **A signed agnt iOS build** installed on your iPhone or iPad before scanning the pairing QR
- **macOS** (for desktop refresh features — the core bridge works on any OS)
- **Xcode 16+** (only if building the iOS app from source)

## Quickstart (local-only, no public relay)

```bash
git clone https://github.com/dotbrains/agnt.git
cd agnt
./run-local-agnt.sh                          # auto-detects an installed agent CLI
./run-local-agnt.sh --provider claude        # force Claude Code
./run-local-agnt.sh --provider opencode      # force opencode
```

Or run the bridge directly without the local-relay launcher:

```bash
cd agnt-bridge
AGNT_RELAY="ws://localhost:9000/relay" node ./bin/agnt.js up --provider codex
AGNT_RELAY="ws://localhost:9000/relay" node ./bin/agnt.js up --provider claude
AGNT_RELAY="ws://localhost:9000/relay" node ./bin/agnt.js up --provider opencode
```

Provider resolution order: `--provider <id>` flag → `AGNT_PROVIDER` env → persisted daemon state → first registered provider whose `isInstalled()` returns true → first registered provider (Codex).

## Adding a provider

1. Create `agnt-bridge/src/providers/<id>/index.js`.
2. Export `module.exports = defineProvider({...})` from `../types`.
3. Implement at minimum: `id`, `displayName`, `capabilities`, `homeDir()`, `sessionsDir()`, `createTransport(opts)`.
4. Optional: `bootstrap(opts)`, `createDesktopRefresher(opts)`, `parseRolloutLine(line)`, `isInstalled({env})`.
5. If the agent CLI doesn't speak Codex JSON-RPC natively, add `createTranslator(ctx)` returning `{outbound, inbound, handleStarted?, handleClose?}`. Use `ctx.injectInbound(line)` to synthesize JSON-RPC responses for methods the upstream CLI doesn't implement (`thread/start`, `thread/read`, `thread/turns/list`, etc.). The Claude and opencode shims in `providers/{claude,opencode}/translate.js` are working references.
6. Register the module in `agnt-bridge/src/providers/index.js`.
7. The bridge picks it up. Capability flags (e.g. `desktopRefresher: false`, `rolloutMirror: false`) gate the codepaths that don't apply.

## Configuration

All env names use the `AGNT_*` prefix.

| Env | Purpose |
|---|---|
| `AGNT_PROVIDER` | Force provider id (`codex`, `claude`, `opencode`, ...) |
| `AGNT_RELAY` | WebSocket relay URL (e.g. `ws://host:9000/relay`) |
| `AGNT_DEVICE_STATE_DIR` | Override local pairing-state directory |
| `AGNT_REFRESH_ENABLED` | Toggle desktop refresher (per-provider capability dependent) |
| `AGNT_REFRESH_DEBOUNCE_MS` | Desktop refresher debounce |
| `AGNT_KEEP_MAC_AWAKE` | Keep Mac awake while bridge is running |
| `AGNT_PUSH_SERVICE_URL` | Push notification service URL |
| `AGNT_DESKTOP_IPC_SOCKET` | Override desktop IPC socket path |
| `AGNT_SKIP_BOOTSTRAP` | Skip provider postinstall hook |
| `AGNT_SKIP_CODEX_BOOTSTRAP` | Skip Codex CLI bootstrap specifically |

## Self-hosting

See [SELF_HOSTING_MODEL.md](SELF_HOSTING_MODEL.md). The transport layer is inspectable; nothing in the iOS app source embeds a hosted endpoint.

## License

Apache-2.0. See [LICENSE](LICENSE). Upstream attribution: [Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex).
