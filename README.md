# agnt

[![CI](https://github.com/smeltery/agnt/actions/workflows/ci.yml/badge.svg)](https://github.com/smeltery/agnt/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-PolyForm%20Shield%201.0.0-blue.svg)](LICENSE)
[![Local-first](https://img.shields.io/badge/Local--first-2563EB)](#what-it-is)
[![End-to-end encrypted](https://img.shields.io/badge/End--to--end%20encrypted-15803D)](docs/architecture/overview.md)

[![Swift](https://img.shields.io/badge/Swift-F05138?logo=swift&logoColor=white)](AgntMobile/)
[![Kotlin](https://img.shields.io/badge/Kotlin-7F52FF?logo=kotlin&logoColor=white)](AgntAndroid/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](agnt-web/)
[![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](agnt-web/)
[![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)](agnt-bridge/)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](agnt-host/src-tauri/)
[![Tauri](https://img.shields.io/badge/Tauri-24C8D8?logo=tauri&logoColor=black)](agnt-host/)

**Drive coding-agent CLIs from your iPhone, Android, or any browser.** agnt is a local-first, source-available bridge that keeps the agent runtime on your Mac or Linux box and proxies an end-to-end encrypted session to your iOS app, Android app, or a self-hosted web client. Codex, Claude Code, opencode, and Cursor work today; the provider plugin contract makes it a small change to add another.

## What it is

```mermaid
flowchart LR
    iOS["iOS app"]
    Android["Android app"]
    Web["web app<br/>(browser)"]
    Relay["relay<br/>(opaque transport)"]
    Bridge["bridge<br/>(your Mac)"]
    CLI["agent CLI<br/>(codex / claude /<br/>opencode / cursor)"]

    iOS <-->|"E2E-encrypted<br/>JSON-RPC"| Relay
    Android <-->|"E2E-encrypted<br/>JSON-RPC"| Relay
    Web <-->|"E2E-encrypted<br/>JSON-RPC"| Relay
    Relay <-->|"WebSocket"| Bridge
    Bridge -->|"native protocol<br/>(translator shim)"| CLI
```

- **iOS app**, **Android app**, and **web app** are three clients of the same protocol — Codex JSON-RPC over a paired secure session.
- **Bridge** runs on your Mac or Linux host. It picks a provider, spawns the matching CLI, and translates between JSON-RPC and whatever native protocol the CLI uses (stream-json, REST+SSE, …). The built-in service installer uses launchd on macOS and systemd-user on Linux; on other operating systems `agnt up` runs in the foreground.
- **Relay** routes ciphertext bytes only. Run it locally for LAN use, or self-host it on a VPS / Tailscale for off-network access.

agnt started from a Codex-only transport and generalizes it behind a provider plugin contract so other agents can be added without touching the bridge core.

## Features

- End-to-end encrypted pairing and chats between your client and local host
- One-time QR bootstrap, short pairing codes, and trusted reconnects
- Live streaming while the agent CLI runs on your Mac or Linux machine
- Plan mode, model selection, reasoning controls, and provider-specific turn settings when the active CLI supports them
- Subagents, slash commands, skills, and structured mentions from the chat composer
- Follow-up prompt queueing while a turn is still running
- In-app notifications for finished turns, approvals, and attention-needed states
- Git actions from the client, including branch switching, commit, pull, push, and PR helpers
- File, image, photo, and workspace attachments where the client supports them
- Optional web terminal access through the bridge for browser sessions
- Shared local thread history and Codex desktop live mirroring on macOS when using the Codex provider

## Quickstart

```sh
git clone https://github.com/smeltery/agnt.git
cd agnt
./scripts/run-local-agnt.sh
```

On Windows, use PowerShell 7:

```powershell
.\scripts\run-local-agnt.ps1
```

That spins up a local relay + the bridge in the foreground and prints a QR code, the JSON payload, and a short alphanumeric pairing code. Force a specific provider with `--provider codex|claude|opencode|cursor` (PowerShell: `-Provider claude`).

If the advertised host in the QR is not reachable from your phone, pass the LAN or VPN address explicitly:

```sh
./scripts/run-local-agnt.sh --hostname 192.168.1.254
```

```powershell
.\scripts\run-local-agnt.ps1 -Hostname 192.168.1.254
```

For tunnel or reverse-proxy testing, pass the public relay URL directly:

```sh
./scripts/run-local-agnt.sh --relay-url https://example-tunnel.trycloudflare.com
```

Pair from any client:

- **iOS app** — install [agnt](https://github.com/smeltery/agnt), scan the QR. The phone reconnects automatically afterward.
- **Android app** — build from `AgntAndroid/` (`./gradlew :app:installDebug`), scan the QR. Alpha — see [`AgntAndroid/README.md`](AgntAndroid/README.md) and [`AgntAndroid/PARITY.md`](AgntAndroid/PARITY.md) for status. Apache-2.0 attribution in [`AgntAndroid/NOTICE`](AgntAndroid/NOTICE).
- **Browser** — `cd agnt-web && bun install && bun run dev`, open `http://localhost:5173`, then paste the JSON, type the short code, or scan the QR with your camera. Same E2EE handshake. See [`agnt-web/README.md`](agnt-web/README.md) for static-build deployment (Tailscale, VPS, S3+CloudFront, …).

Scan the QR from inside an agnt client. A generic camera or QR reader may treat the pairing payload as plain text instead of starting the secure pairing flow.

For self-hosting (Tailscale, public VPS, etc.) see [`docs/operations/self-hosting.md`](docs/operations/self-hosting.md).

## Supported providers

| Provider | Status | OS | Notes |
|---|---|---|---|
| **Codex** ([install](https://github.com/openai/codex)) | feature-complete | macOS only | native JSON-RPC; ChatGPT auth + voice + desktop mirror (all bound to `Codex.app`) |
| **Claude Code** ([install](https://docs.claude.com/en/docs/claude-code)) | feature-complete | macOS, Linux | long-lived stdin; plan mode; reasoning deltas; auto-accept edits |
| **opencode** ([install](https://opencode.ai)) | feature-complete | macOS, Linux | runtime tool approvals from your phone; compact + fork |
| **Cursor** ([install](https://cursor.com/docs/cli/installation)) | feature-complete | macOS, Linux | spawn-per-turn; tool calls auto-approved (`--force`) |

Provider deep-dives + capability matrix: [`docs/providers/`](docs/providers/).

## Documentation

The full docset lives in [`docs/`](docs/) with deep technical references and mermaid diagrams.

| Read this if you want to… | Start here |
|---|---|
| understand the architecture | [`docs/architecture/overview.md`](docs/architecture/overview.md) |
| extend agnt with a new provider | [`docs/development/adding-a-provider.md`](docs/development/adding-a-provider.md) |
| self-host on a VPS | [`docs/operations/self-hosting.md`](docs/operations/self-hosting.md) |
| run the browser client | [`agnt-web/README.md`](agnt-web/README.md) |
| diagnose a broken thread | [`docs/operations/debugging.md`](docs/operations/debugging.md) |
| see all `AGNT_*` env vars | [`docs/operations/env-reference.md`](docs/operations/env-reference.md) |

## Configuration

The three you'll actually set:

| Var | Purpose |
|---|---|
| `AGNT_PROVIDER` | force a provider id (`codex` / `claude` / `opencode` / `cursor`) |
| `AGNT_RELAY` | WebSocket relay URL — required when not using `scripts/run-local-agnt.sh` |
| `AGNT_HOME` | override the agnt state directory (default `~/.agnt`) |

The full set (push notifications, APNs, desktop refresher tuning, test overrides) is in [`docs/operations/env-reference.md`](docs/operations/env-reference.md).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Short version: small focused PRs welcome, contributions ship under [PolyForm Shield 1.0.0](LICENSE) (the same license as the rest of the project), and the playbook for adding a new provider is at [`docs/development/adding-a-provider.md`](docs/development/adding-a-provider.md).

The repo ships a [Flox](https://flox.dev) environment ([`.flox/`](.flox/)) that pins the Node, Bun, JDK, and Rust toolchain CI uses — run `flox activate` from the repo root to get it, or `flox activate --start-services` to boot the relay + bridge. See [the Flox toolchain section](CONTRIBUTING.md#flox-toolchain-recommended) in `CONTRIBUTING.md`. For Rust/Tauri compiles in `agnt-host`, use [`mbx`](https://mr-boxington.jdx.dev) when invoking cargo directly (Flox activation installs it if missing).

Bridge tests live under `agnt-bridge/test/` (400 unit tests, run with `(cd agnt-bridge && bun run test)`). The CI badges above run on every push.

### Note for bun users installing the bridge globally

Bun blocks `postinstall` scripts from running on globally-installed packages by default (security model mirrors pnpm). If you install with `bun install -g @smeltery/agnt`, the bin entries (`agnt`, `agnt-jsonl-diagnose`) register correctly, but the bridge's `bootstrap-provider.js` won't run on its own — that's the script that warms the active provider's bootstrap and surfaces the cached iOS-app-compatibility warning.

The bootstrap is non-essential (the bridge tolerates an unbootstrapped install), but to opt in run:

```sh
bun install -g @smeltery/agnt
bun pm trust -g @smeltery/agnt   # one-time; runs the blocked postinstall
```

Or stick with `npm install -g @smeltery/agnt` if you prefer the automatic flow.

## License

[PolyForm Shield 1.0.0](LICENSE) — source-available with a non-compete: you may use, copy, modify, and distribute the software, but not to provide a product or service that competes with agnt or with anything smeltery offers that includes it. Code inherited from the Apache-2.0 project this was forked from retains its original Apache-2.0 grant. See [`legal/TERMS_OF_USE.md`](legal/TERMS_OF_USE.md) for the human-readable summary; `LICENSE` is authoritative.
