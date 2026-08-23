# CLAUDE.md (Local-First, Multi-Provider)

Keep this file and `AGENTS.md` aligned.

This repo is local-first and multi-provider. Do not reintroduce hosted-service assumptions, remote deployment runbooks, hardcoded production domains, or single-provider couplings.

## Core guardrails

- Prefer local Mac/Linux runtime, local bridge, QR pairing, and daemon workflows. Codex provider stays macOS-only (it depends on `Codex.app`); Claude Code, opencode, and Cursor work on both macOS and Linux.
- Be a proactive agent: inspect local code, protocol/schema, and official sources to confirm facts before replying; do not stop to ask for confirmation when the next verification step is safe and obvious.
- Keep repo isolation by thread/project metadata and local `cwd`.
- Do not reintroduce filtering by selected repo in sidebar/content.
- Keep cross-repo open/create flow with automatic local context switch.
- Preserve single responsibility: shared logic belongs in services/coordinators, not duplicated in views.
- Treat this repo as source-available: avoid junk code, placeholder hacks, noisy one-off workarounds, and low-signal docs.
- If you touch docs, keep them local-only and remove stale hosted-service notes instead of adding compatibility layers.
- Do not create one-off report markdown files in the repo root unless the user explicitly asks for a file. Keep ad-hoc analysis in the chat.
- For source-available/self-hosted safety, do not log live relay `sessionId` values or other bearer-like pairing identifiers in server logs; redact or hash them instead.
- Keep user-facing answers compact by default unless the user explicitly asks for more detail.

## Provider plugin guardrails

- agnt brokers between three clients (the iOS app under `AgntMobile/`, the Android app under `AgntAndroid/`, and the browser client under `agnt-web/`) — plus an optional desktop supervisor (`agnt-host/`, Tauri) for users who'd rather not keep `agnt up` in a terminal — and any supported coding-agent CLI (Codex, Claude Code, opencode, Cursor, ...). All three clients speak the same E2EE-wrapped JSON-RPC protocol; provider modules don't know or care which client is connected. New providers go under `agnt-bridge/src/providers/<id>/index.js` and are registered in `agnt-bridge/src/providers/index.js`.
- Provider modules must conform to the contract in `agnt-bridge/src/providers/types.js` (`defineProvider`). Required: `id`, `displayName`, `createTransport`, `homeDir`, `sessionsDir`, `capabilities`. Optional: `bootstrap`, `createDesktopRefresher`, `parseRolloutLine`, `isInstalled`, `createTranslator`.
- If the agent CLI does not speak Codex JSON-RPC natively (Claude stream-json, opencode REST/SSE, Cursor stream-json, …), the protocol shim lives in `providers/<id>/translate.js` and is wired via `createTranslator(ctx)`. The shim can `ctx.injectInbound(line)` to synthesize JSON-RPC responses without round-tripping the CLI — use this for `thread/start`, `thread/read`, `thread/turns/list`, and any other Codex-only methods the upstream CLI does not implement.
- Per-turn provider flags (model, effort, plan mode) flow through `transport.setTurnArgs(args)`. Translators publish them from `turn/start.params`. The Claude transport restarts the CLI when the arg list changes and uses `--resume <session_id>` (published via `setResumeSessionId`) to keep history. Don't read `params.model` directly in transports — keep that mapping inside `translate.js` so the spawn/REST layer stays mechanical.
- Codex-only RPCs (`account/status/read`, `getAuthStatus`, `account/login/*`, `account/logout`, `account/login/openOnMac`, `voice/transcribe`, `voice/resolveAuth`, and the structured-JSON `thread/generateTitle` path in `git-handler.js`) are gated on `activeProvider.id === "codex"` in `bridge.js`. Non-Codex providers either get a synthetic "managed externally" response or fall through to the active provider's translator. Don't add new ChatGPT-token-bearing calls without that gate.
- The `thread/turns/list` JSONL fallback (`maybeBuildJsonlThreadTurnsListFallback`) is also Codex-only — it reconstructs a small page from `~/.codex/sessions/**.jsonl` via `providers/codex/session-jsonl-history.js` when the upstream returns empty. Other providers' translators already synthesize their own `thread/turns/list` from their session files, so the fallback short-circuits before any IO when `activeProvider.id !== "codex"`. Don't try to generalize the Codex rollout parser to other providers — their schemas differ.
- Reject overlapping turns. The Claude, opencode, and Cursor shims all reject a second `turn/start` while one is in flight with JSON-RPC error code `-32003`. iOS UI usually disables Send during a turn but this is a backstop against reconnect races.
- Approval flow (opencode): the SSE `permission.asked` event becomes an `item/commandExecution/requestApproval` (or `item/fileChange/requestApproval` for edit/write/patch) JSON-RPC request to iOS. The iOS app replies with `{decision: "accept"|"decline"}`; the shim maps that to opencode's `response: "once"|"reject"` and POSTs to `/session/{id}/permissions/{permissionID}`. Claude has no equivalent runtime approval channel — its shim defaults `--permission-mode acceptEdits` so file edits flow without blocking; iOS can override per turn via `params.permissionMode`. Cursor also has no runtime approval channel — its shim hard-codes `--force` (auto-approve) for headless mode.
- Cursor is spawn-per-turn, not long-lived. `cursor-agent` only accepts the prompt as a CLI argument (no stdin frame mode), so each `turn/start` shuts down any previous child and spawns a fresh `cursor-agent -p <prompt> --output-format stream-json --force [--model X] [--resume <session_id>]`. Conversation continuity comes from `--resume`, populated via `transport.setResumeSessionId()` from the `session_id` echoed on every cursor frame. Don't try to repurpose the Claude long-lived-stdin pattern here.
- `thread/initialized` is emitted after `thread/started` so iOS can render available skills/agents/slash-commands. Claude pulls this from `system.init`; opencode emits a default tool list (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `task`, `todowrite`, `webfetch`, `websearch`); Cursor emits a default tool list (`read`, `write`, `edit`, `shell`, `grep`, `glob`, `ls`) since `cursor-agent`'s init frame doesn't advertise its actual toolset.
- `system/notice` is emitted on opencode `tui.toast.show` SSE events so MCP-auth warnings and similar surface in the iOS UI instead of being silently dropped.
- `rolloutMirror: true` is a Codex-only capability — it gates the **desktop-companion mirror** that tails the macOS Codex desktop app's rollout file so iOS can mirror the user's terminal-side chat live. Claude/opencode/Cursor have no equivalent companion app, so they keep `rolloutMirror: false`. This is not the same as resume-mid-turn replay (which would be a separate cross-provider feature).
- Bridge core must stay agent-agnostic. Do not reintroduce direct imports of `codex-transport`, `CodexDesktopRefresher`, or other provider-specific modules from `bridge.js` — go through `resolveActiveProvider()`.
- When a capability is absent (e.g. `desktopRefresher`, `rolloutMirror`), gate the codepath on `provider.capabilities.<flag>` and degrade gracefully (no-op refresher, skip mirror watcher) instead of crashing.
- Provider selection precedence: `--provider <id>` CLI flag, then `AGNT_PROVIDER` env, then persisted daemon-state, then `isInstalled()` auto-detect, then first registered.

## Bridge architecture map

`agnt-bridge/src/bridge/bridge.js` is intentionally lean — it wires the bridge together but delegates almost every concern to a named module. Before adding logic to `bridge.js`, check whether the abstraction already exists. Adding to an existing module beats growing the bridge.

Inbound + outbound dispatch:

- `bridge/application-message-router.js` — decrypted relay payloads fan out through an ordered list of stages (handshake, account, voice, thread-context, workspace, project, pet, notifications, desktop, git, turns-list). First truthy stage claims the message; fallback forwards to the active provider. Add new handlers as a stage; do not grow the if-ladder inline.
- `bridge/relay-outbound-pipeline.js` — codex → relay direction. Phases: short-circuit (bridge-managed responses) → observers (auth, handshake, desktop refresh, push tracking, thread tracking) → sanitize (image redaction etc.) → forward. Observer-only stages return false; sanitize returning null drops the message.
- `bridge/relay-socket-loop.js` — owns the WebSocket lifecycle and reconnect policy. Bridge passes callbacks (`onStatus`, `onOpen`, `onTeardown`, `onShutdown`, `handleIncomingWireMessage`, `onApplicationMessage`). Close-code policy: codes 4000 / 4001 trigger `onShutdown`; everything else reconnects via `reconnectScheduler`.

Shared translator helpers (used by claude / opencode / cursor shims):

- `providers/_shared/translator-utils.js` — pure helpers and frame envelopes. Includes `createFrameEmitter`, `createTurnLifecycleEmitter` (`turn/started`/`turn/completed`/`turn/failed` shapes), `buildTurnOverlapError` (the `-32003` reject), `emitAssistantItemStarted`, `deriveTitleFromSeed`, `generateThreadId`/`generateTurnId`/`generateItemId`. Frame envelopes must stay byte-identical across providers — change here, never inline a copy.
- `providers/_shared/thread-jsonl-reconstructor.js` — `reconstructThreadFromJsonl` rebuilds a thread snapshot from a single rollout JSONL file. Used by claude (`~/.claude/projects/<encoded>/<session>.jsonl`) and cursor (`~/.cursor/chats/<id>.jsonl`). Each translator passes its own resolved file path; the parser doesn't know where on disk to look.

Shared handler infrastructure:

- `handlers/handler-utils.js` — `createJsonRpcRequestHandler({ match, dispatch, defaultErrorCode, defaultErrorMessage, onError? })` owns the JSON-RPC envelope: parse, match-or-pass-through, dispatch, wrap success as `{id, result}` or error as `{id, error:{code:-32000, message, data:{errorCode}}}`. Used by workspace, desktop, pet, project, voice, notifications, terminal. New handlers should use this factory rather than re-implementing the skeleton.

Bridge-spawned local PTY (web-only):

- `handlers/terminal-handler.js` — owns `terminal/open|write|resize|clear|close|snapshot` JSON-RPC RPCs and the `terminal/output` / `terminal/exited` notifications. The web client uses these because browsers can't open raw SSH from JS; the iOS/Android clients run an on-device SSH terminal instead and don't touch this surface. Two layers of opt-in: (1) the `enableWebTerminal` bridge preference (default off) gates the entire surface — when off, every `terminal/*` request returns `terminal_disabled`. (2) Even after the user opts in, the very first `terminal/open` per bridge process must carry `acknowledgeFirstUse: true` (typed error `terminal_first_use_unacknowledged`); the web UI catches this and shows a confirm dialog. Both gates exist because a raw shell bypasses the per-command approval flow opencode/Cursor enforce.
- Capability flag is split: `hostCapabilities.terminal: true` (unchanged — iOS/Android on-device SSH); `hostCapabilities.terminalLocal: <bool>` (new — bridge-spawned local PTY for web, mirrors the `enableWebTerminal` preference). The iOS settings panel writes `enableWebTerminal` via the existing `desktop/preferences/update` RPC alongside `keepMacAwake`.

Contract tests for the abstractions:

- `test/contracts/cross-translator-contract.test.js` — parameterized over claude / opencode / cursor. Pins the shared wire contract: `thread/start` envelope, `turn/start` ack + `turn/started`, `-32003` overlap rejection, `turn/interrupt` finalization. Adding a fourth provider: add an adapter to the `PROVIDERS` array and the existing invariants are covered automatically.
- `test/contracts/application-message-router.test.js`, `test/contracts/relay-outbound-pipeline.test.js`, `test/contracts/relay-socket-loop.test.js`, `test/contracts/handler-utils.test.js` — lock the dispatch / lifecycle / envelope guarantees the bridge depends on.

## iOS runtime + timeline guardrails

- `turn/started` may not include a usable `turnId`: keep the per-thread running fallback.
- If Stop is tapped and `activeTurnIdByThread` is missing, resolve via `thread/read` before interrupting.
- On reconnect/background recover, rehydrate active turn state so Stop remains visible.
- Suppress benign background disconnect noise (`NWError.posix(.ECONNABORTED)`) and retry on foreground.
- Keep assistant rows item-scoped to avoid timeline flattening/reordering.
- Merge late reasoning deltas into existing rows; do not spawn fake extra "Thinking..." rows.
- Ignore late turn-less activity events when the turn is already inactive.
- Preserve item-aware history reconciliation instead of falling back to `turnId`-only matching.

## Local connection guardrails

- Prefer saved relay pairing and local connection state as the source of truth.
- Avoid hardcoded remote domains; default to local values or explicit user config.
- Keep pairing/auth UX stable: do not clear saved relay info too early during reconnect flows.
- Preserve reconnect behavior across relaunch when the local host session is still valid.
- Preserve the QR/local-relay pairing path: do not regress the scanner -> saved pairing -> connect flow by letting onboarding/auto-reconnect race manual scan control.
- For local relay recovery, keep resumed desktop-thread live mirroring and rollout fallback logic intact so reopened/running threads still recover state even when the rollout file is older than the recent-candidate window.

## Env var guardrails

- All env names use the `AGNT_*` prefix. Do not introduce alias prefixes or fallbacks to other product names.
- Keep env reads going through `readFirstDefinedEnv([...names])` so adding a future legitimate alias (e.g. an `AGNT_*` rename) stays a one-line edit.

## Build guardrails

- Do not run Xcode tests unless the user explicitly asks. Do not decide to run them on your own.
- Markdown files inside Xcode-synced groups can still produce harmless warnings.
- For small iOS/mobile fixes, prefer inspection and targeted edits over simulator runs by default.

## Web client guardrails (`agnt-web/`)

- `agnt-web` is a second client for the same relay+bridge stack — it is **not** a hosted service. Treat its README and deployment notes as self-host guidance only; do not introduce a hardcoded production origin.
- The browser secure-transport port must stay byte-for-byte aligned with `agnt-bridge/src/secure-transport.js`. Any change to transcript framing, nonce layout, or HKDF info must land in both modules in the same PR, with the parity vitest suite updated.
- Browsers can't set custom WebSocket headers; the relay accepts `?role=iphone` as a fallback. Do not remove that fallback. Mac bridges still set `x-role: mac` via headers — do not start trusting query-string roles for the Mac side.
- Long-running parity work tracked in `agnt-web/PARITY.md` and `agnt-web/ROADMAP.md`. Update both whenever a surface lands or its scope changes.
- Static-only build. Do not introduce a Node runtime in `agnt-web/`; the browser is the runtime.

## Android client guardrails (`AgntAndroid/`)

- `AgntAndroid` is a third client for the same relay+bridge stack — it is **not** a hosted service. Apache-2.0 attribution lives in `AgntAndroid/NOTICE`; modifications relative to upstream must be reflected there if they affect copyright/attribution.
- The Android secure-transport (`AgntAndroid/app/src/main/kotlin/com/smeltery/agnt/mobile/core/model/SecureTransportModels.kt` + `core/crypto/SecureEnvelopeCipher.kt`) must stay byte-for-byte aligned with `agnt-bridge/src/secure-transport.js` and `agnt-web/src/crypto/transcript.ts`. Any change to transcript framing, nonce layout, or HKDF info must land in all three modules in the same PR.
- Android can't set custom WebSocket headers reliably either; it uses `?role=iphone` like the browser. Don't start trusting query-string roles for the Mac side.
- The package is `com.smeltery.agnt.mobile`. Upstream identifiers (`com.remodex.mobile`, `remodex-e2ee-v1`, `remodex-trusted-session-resolve-*-v1`, `refs/remodex/checkpoints`, `PHODEX_DEFAULT_RELAY_URL`) must not be reintroduced — they break the agnt protocol contract.
- The upstream Android client was Codex-only. Codex-only RPCs (see the Provider plugin guardrails section above) must be either hidden when `activeProvider.id != "codex"` or tolerated as "managed externally" responses; UI affordances need an active-provider gate. Tracked in `AgntAndroid/ROADMAP.md` (P1).
- The `CodexService*` class names and `CODEX_*` constants are upstream holdovers — the class hierarchy is protocol-agnostic in practice. Don't add Codex-specific assumptions inside them; the rename is deferred (ROADMAP P3) but the contract is provider-agnostic now.
- Long-running parity work tracked in `AgntAndroid/PARITY.md` and `AgntAndroid/ROADMAP.md`. Update both whenever a surface lands or its scope changes.
- Do not run Android emulator/device tests unless the user explicitly asks. Prefer `./gradlew :app:testDebugUnitTest` and inspection over emulator runs.

## Desktop host guardrails (`agnt-host/`)

- `agnt-host` is a Tauri 2 desktop app (Rust + React 19 + Vite) that supervises the local `agnt-bridge` and `relay` processes and presents a system-tray + popup UI for pairing. See `agnt-host/README.md` for the identifier/branding table.
- `agnt-host/src-tauri/bundled/` is generated at build time by `copy-bundled.mjs`, which snapshots `../agnt-bridge` and `../relay`. Do not commit `bundled/`; it's gitignored. Do not edit files inside it — change the source dirs instead.
- The Tauri updater is preconfigured with placeholder pubkey + endpoint. Before publishing a release: generate a minisign keypair, replace the `pubkey` in `src-tauri/tauri.conf.json`, and verify the `endpoints` URL points at the smeltery/agnt release manifest. Never commit the private key.
- The bundled bridge entry point is `agnt-bridge/bin/agnt.js` and the bundle manifest is `agnt-bundle.json`. Env-var prefix for the host is `AGNT_HOST_*` (e.g. `AGNT_HOST_UPDATE_TAG`); env-vars consumed by the spawned bridge follow the `AGNT_*` convention (e.g. `AGNT_RELAY`, `AGNT_PRINT_PAIRING_JSON`).
- The animated relay companion (`agnt-host/public/pets/relay/`) is opt-in cosmetic UI. `agnt-host/run-pet/` is the asset-generation toolchain — historical inputs, not loaded at runtime. Keep both, but they're optional to maintain.
- Inherited app icons in `agnt-host/src-tauri/icons/` must be replaced with agnt-branded artwork before public release.

## Local quick runbook

```bash
cd agnt-bridge
npm start
# or, with explicit provider:
node ./bin/agnt.js up --provider codex
```

The repo ships a [Flox](https://flox.dev) environment (`.flox/`) that pins the
Node 20 / Bun 1.3.11 / JDK 17 / Rust toolchain CI uses. `flox activate` from the
repo root gives you that toolchain; `flox activate --start-services` boots the
relay + bridge services. CI installs Flox via `flox/install-flox-action` and runs
each step with `flox activate -d "$GITHUB_WORKSPACE" -- <cmd>`, so the toolchain
is byte-identical locally and in GitHub Actions. The agent CLIs and Xcode are not
managed by Flox; the Android SDK is still provisioned by Gradle/AGP.
