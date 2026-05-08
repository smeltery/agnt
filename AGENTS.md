# AGENTS.md (Local-First, Multi-Provider)

Keep this file and `CLAUDE.md` aligned.

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

- agnt brokers between an iOS app and any supported coding-agent CLI (Codex, Claude Code, opencode, Cursor, ...). New providers go under `agnt-bridge/src/providers/<id>/index.js` and are registered in `agnt-bridge/src/providers/index.js`.
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

## Local quick runbook

```bash
cd agnt-bridge
npm start
# or, with explicit provider:
node ./bin/agnt.js up --provider codex
```
