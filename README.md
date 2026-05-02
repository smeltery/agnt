# agnt

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Control coding-agent CLIs from your iPhone — **Codex**, **Claude Code**, **opencode**, and any other agent you plug in. **agnt** is a local-first, open-source bridge + iOS app that keeps the agent runtime on your Mac and lets your phone connect through a paired secure session.

> agnt is a fork of [Remodex](https://github.com/Emanuele-web04/remodex) (Apache-2.0). The original tool brokers iOS ↔ Codex; agnt generalises the transport behind a provider plugin contract so other agents can be added without touching bridge core.

> **Status: early.**

## Provider matrix

| Provider | Detect | Transport | Protocol shim | Ready for paired phone? |
|---|---|---|---|---|
| **Codex** | ✓ | ✓ spawn `codex app-server` | n/a (native) | ✓ feature-parity with Remodex |
| **Claude Code** | ✓ via `which`/npm-global/Homebrew | ✓ spawn `claude --output-format stream-json --input-format stream-json --verbose` | ✗ pending — bridge speaks Codex JSON-RPC, Claude speaks stream-json | ✗ events plumb but iOS app can't decode them yet |
| **opencode** | ✓ via `which`/Homebrew/`~/.bun` | ✓ spawn `opencode serve` + SSE consume on `/event` | ✗ pending (REST-shaped API; outbound `send` throws) | ✗ inbound only |

The protocol shim is the next major piece. The provider plugin already exposes optional `translate.outbound(line)` and `translate.inbound(line)` hooks (see `agnt-bridge/src/providers/types.js`); a future PR fills these in for Claude and opencode.

## Why a fork

The Remodex bridge is well-built but assumes one agent: Codex. agnt:

- Defines a provider plugin contract (`agnt-bridge/src/providers/types.js`) with optional `translate` hooks for protocol shimming.
- Routes the bridge's transport, desktop refresher, rollout watcher, and bootstrap through the active provider.
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
│       │   ├── types.js          # Contract + capability flags
│       │   ├── index.js          # Registry + resolveActiveProvider()
│       │   ├── codex/            # Codex provider (full)
│       │   ├── claude/           # Claude Code provider (stub)
│       │   └── opencode/         # opencode provider (stub)
│       ├── bridge.js             # Provider-agnostic bridge core
│       ├── codex-*.js            # Codex helpers (consumed via providers/codex)
│       └── ...
├── AgntMobile/                  # Xcode project root (iOS app)
├── relay/                        # Optional local relay server
└── run-local-agnt.sh             # Spin up local relay + foreground bridge
```

## Prerequisites

- **Node.js** v18+
- At least one supported agent CLI in PATH:
  - **[Codex CLI](https://github.com/openai/codex)** — fully integrated
  - **[Claude Code](https://docs.claude.com/en/docs/claude-code)** — transport ready, protocol shim pending
  - **[opencode](https://opencode.ai)** — transport scaffolded, protocol shim pending
- **A signed agnt iOS build** installed on your iPhone or iPad before scanning the pairing QR
- **macOS** (for desktop refresh features — the core bridge works on any OS)
- **Xcode 16+** (only if building the iOS app from source)

## Quickstart (local-only, no relay)

```bash
git clone https://github.com/dotbrains/agnt.git
cd agnt
./run-local-agnt.sh          # boots local relay + foreground bridge with Codex
```

Force a specific provider:

```bash
cd agnt-bridge
node ./bin/agnt.js up --provider codex
node ./bin/agnt.js up --provider claude    # stub — transport throws until implemented
```

## Adding a provider

1. Create `agnt-bridge/src/providers/<id>/index.js`.
2. Export `module.exports = defineProvider({...})` from `../types`.
3. Implement at minimum: `id`, `displayName`, `capabilities`, `homeDir()`, `sessionsDir()`, `createTransport(opts)`.
4. Optional: `bootstrap(opts)`, `createDesktopRefresher(opts)`, `parseRolloutLine(line)`, `isInstalled({env})`, `translate.outbound(line)` / `translate.inbound(line)` for protocol shimming.
5. Register the module in `agnt-bridge/src/providers/index.js`.
6. The bridge picks it up. Capability flags (e.g. `desktopRefresher: false`) gate the codepaths that don't apply. Translate hooks default to identity (pass-through).

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
