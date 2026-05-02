# AGENTS.md (Local-First, Multi-Provider)

Keep this file and `CLAUDE.md` aligned.

This repo is local-first and multi-provider. Do not reintroduce hosted-service assumptions, remote deployment runbooks, hardcoded production domains, or single-provider couplings.

## Core guardrails

- Prefer local Mac runtime, local bridge, QR pairing, and daemon workflows.
- Be a proactive agent: inspect local code, protocol/schema, and official sources to confirm facts before replying; do not stop to ask for confirmation when the next verification step is safe and obvious.
- Keep repo isolation by thread/project metadata and local `cwd`.
- Do not reintroduce filtering by selected repo in sidebar/content.
- Keep cross-repo open/create flow with automatic local context switch.
- Preserve single responsibility: shared logic belongs in services/coordinators, not duplicated in views.
- Treat this repo as open source: avoid junk code, placeholder hacks, noisy one-off workarounds, and low-signal docs.
- If you touch docs, keep them local-only and remove stale hosted-service notes instead of adding compatibility layers.
- Do not create one-off report markdown files in the repo root unless the user explicitly asks for a file. Keep ad-hoc analysis in the chat.
- For open-source/self-hosted safety, do not log live relay `sessionId` values or other bearer-like pairing identifiers in server logs; redact or hash them instead.
- Keep user-facing answers compact by default unless the user explicitly asks for more detail.

## Provider plugin guardrails

- agnt brokers between an iOS app and any supported coding-agent CLI (Codex, Claude Code, opencode, ...). New providers go under `agnt-bridge/src/providers/<id>/index.js` and are registered in `agnt-bridge/src/providers/index.js`.
- Provider modules must conform to the contract in `agnt-bridge/src/providers/types.js` (`defineProvider`). Required: `id`, `displayName`, `createTransport`, `homeDir`, `sessionsDir`, `capabilities`. Optional: `bootstrap`, `createDesktopRefresher`, `parseRolloutLine`, `isInstalled`.
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

## Local quick runbook

```bash
cd agnt-bridge
npm start
# or, with explicit provider:
node ./bin/agnt.js up --provider codex
```
