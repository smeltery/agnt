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

## Session 2 — Chat fidelity & sync

- Post-connect sync: model list, skills, archived/active thread split, plugin list
- Item-scoped reconciliation for streamed deltas (no flattening; matches `IncomingAssistant`)
- Reasoning + tool-call rendering with collapse/expand, code-block syntax highlight
- Pagination for long threads (`thread/turns/list` cursor)
- IndexedDB-backed message cache so reconnects render instantly
- `AssistantReplayDeduper` port

## Session 3 — Approvals & plan mode

- `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` UI
- Plan-mode delta rendering (`turn/plan/updated`, `IncomingPlanMode`)
- Per-turn provider flags: model, reasoning effort, plan mode, permission mode
- `system/notice` toast surface

## Session 4 — Workspace & projects

- Project folders + per-thread project routing
- AI change sets (apply / revert / view diff)
- Workspace checkpoints + workspace image fetching
- Thread fork + review mode
- Git actions surface (status / branches / diff / commit)

## Session 5 — Onboarding polish

- In-browser camera QR scanning via `BarcodeDetector` (with `jsQR` fallback)
- Manual pairing-code resolver call (`/v1/pairing/code/resolve`)
- Settings screen, about screen, trusted-Mac management UI
- Account login flow (Codex provider only) with OAuth-style relay redirect

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
