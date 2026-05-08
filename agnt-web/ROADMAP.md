# agnt-web roadmap

The web client is being built across a series of focused sessions. Each session
delivers an end-to-end-usable slice; the foundation never gets restructured by a
later session because the protocol and storage layers are already complete.

## Session 1 — Foundation (this branch)

- Faithful port of secure transport + handshake + JSON-RPC framing
- IndexedDB-backed identity, pairing, and trusted-mac registry
- Pairing screen (paste payload), thread sidebar, basic chat view, send/stop turn
- Relay query-string `role` fallback + CORS for browser support
- Cross-checked vitest suite for crypto and pairing parser
- Deployment notes for VPS / Tailscale / nginx

## Session 2 — Chat fidelity & sync ✅ DONE

- ✅ Post-connect sync: `initialize`, `model/list`, `thread/list` archived split
- ✅ Item-scoped reconciliation (faithful port of iOS `appendAssistantDelta` + `applyLateTerminalAssistantDelta` + `completeAssistantMessage`)
- ✅ Reasoning + tool-call + command-execution + file-change rendering with collapse/expand
- ✅ Pagination for long threads (`thread/turns/list` cursor walker)
- ✅ IndexedDB-backed message cache (debounced, per-thread)
- ✅ `AssistantReplayDeduper` port (exact + block replay)
- 🟡 Code-block syntax highlighting deferred to Session 5 — fenced code renders as monospace, language tag exposed via CSS class so a highlighter can drop in without touching components

## Session 3 — Approvals & plan mode ✅ DONE

- ✅ `item/commandExecution/requestApproval` + `item/fileChange/requestApproval` modal with accept / decline / "allow for session"
- ✅ Plan-mode rendering (`turn/plan/updated` snapshots + `item/plan/delta` streaming + presentation transitions)
- ✅ Per-turn provider flags (model, reasoning effort, plan mode, permission mode) wired into `turn/start.params`
- ✅ `system/notice` toast surface with severity-aware auto-dismiss
- 🟡 `tool/requestUserInput` structured-input prompts deferred to Session 4 (plan-mode + tool-call-input UI is meatier than what this session targeted)

## Session 4 — Workspace & projects ✅ DONE (lean slice)

- ✅ Thread operations: fork, rename, archive/unarchive (sidebar context menu + chat header)
- ✅ Structured user-input prompts (`tool/requestUserInput` + `item/tool/requestUserInput`)
- ✅ Git actions panel: status, diff, commit, push, pull
- ✅ cwd indicator in chat header
- 🟡 AI change sets, workspace checkpoints, workspace images, project switcher UI deferred — these need design work and aren't blocking parity

## Session 4 — Workspace & projects (deferred items)

- Project folders + per-thread project routing
- AI change sets (apply / revert / view diff)
- Workspace checkpoints + workspace image fetching
- Thread fork + review mode
- Git actions surface (status / branches / diff / commit)

## Session 5 — Onboarding polish ✅ DONE

- ✅ In-browser camera QR scanning via `BarcodeDetector` (clear "manual entry only" message on unsupported browsers; intentionally no `jsQR` polyfill — keeps the bundle ~30 KB smaller)
- ✅ Manual pairing-code resolver call (`/v1/pairing/code/resolve`) with `/relay`-prefixed and root-path candidates
- ✅ Settings screen + About screen + trusted-Mac management with forget
- ✅ Code-block syntax highlighting via Prism core + curated language pack (bash/diff/go/json/jsx/python/rust/swift/tsx/typescript/yaml + aliases)
- 🟡 Account login flow (Codex-only) read-only this session — full OAuth-style relay redirect deferred (needs cross-tab handoff design)

## Session 6 — Voice

- Browser audio capture via `MediaRecorder`
- `voice/transcribe` RPC wiring
- Streaming partial transcripts UI

## Session 7 — Pets / payments / nice-to-haves

- Pet companion port (or explicit decision to drop it for web)
- Web-equivalent of the StoreKit-gated screens (likely "open in iOS app" links)

## Session N — Hardening

- Service worker for offline-tolerant reconnect
- Optional WebPush for completion notifications (when we have a self-hostable web-push gateway)
- Wallclock-skew tolerance review
- E2E tests against a local relay + bridge in CI
