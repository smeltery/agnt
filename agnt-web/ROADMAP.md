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

## Session 6 — Voice ✅ DONE

- ✅ Browser audio capture via `MediaRecorder` (WebM/Opus, MP4, OGG fallbacks)
- ✅ Web Audio `OfflineAudioContext` resample to 24 kHz mono + manual 16-bit PCM RIFF/WAV packer (no JS DSP libraries)
- ✅ `voice/transcribe` RPC wiring with bridge-side auth (Codex-only — bridge enforces this)
- ✅ Voice button in the composer with idle / recording (live timer + cancel) / transcribing / error states; final transcript appends to the draft
- ⛔ Streaming partial transcripts intentionally not built — `voice/transcribe` is a single request/response at the protocol level. Web Speech API gives live transcripts but uses a different model + bypasses bridge auth, so we keep the bridge path

## Session 7 — Pets / payments / hardening ✅ DONE

- ⛔ Pet companion **dropped from web port** — animations / haptics / Live Activities are iOS-specific UX that don't translate cleanly. iOS app keeps it.
- ⛔ StoreKit-gated screens **n/a** — agnt-web is self-hosted and doesn't sell anything to the user.
- ✅ Service worker for offline-tolerant reload (`public/sw.js`, production-only registration). Cache-first for hashed assets, network-first for navigations, never caches `/relay/*` or `/v1/*`.
- ✅ Sidebar thread search with `j`/`k` keyboard navigation (Linear/Gmail-style)
- ✅ Copy-to-clipboard on completed assistant rows
- ✅ Workspace shortcuts: `/` focuses the composer, `Esc` closes any open overlay

## Session 8 — Markdown polish + git branches ✅ DONE

- ✅ Block-level markdown lexer (`markdown-blocks.ts`): headings 1–6, ordered + bullet lists, tables with column alignment, fenced code (kept the existing Prism path)
- ✅ Git branch picker + checkout in `GitPanel`. Disables checkout when the working tree is dirty, when the target is the current branch, or when it's checked out in another worktree (matches `git/branches.branchesCheckedOutElsewhere`)

## Session 9 — Close critical gaps from the iOS audit ✅ DONE

- ✅ Project folder picker (`project/quickLocations` + `listDirectory` + `searchDirectories`) backing a "New Chat" flow that drives `thread/start.cwd`
- ✅ Sidebar `+ New` entry point + per-thread running indicator from `thread/status/changed`
- ✅ `turn/diff/updated` notification → renders in the existing FileChange row keyed off the turnId
- ✅ Auto-title threads via `thread/generateTitle` after first turn (skips if user already named it)
- ✅ Persist `turnFlags` (model / reasoning / permission / planMode) to IndexedDB so picks survive reload
- ✅ Proactive `thread/contextWindow/read` on thread switch so the token bar paints before the next turn fires the push notification

## Session 15 — Streaming UX + thread search + lightbox ✅ DONE

- ✅ Sticky-follow scroll: a `useStickyScroll` hook in `lib/sticky-scroll.ts` keeps the bottom anchored only when the user is already there; scroll-up disables follow. A floating "↓ Latest" button surfaces when the user is meaningfully offset so they can rejoin without manually scrolling.
- ✅ In-thread search: bare `f` (outside inputs) and ⌘/Ctrl+F open `ThreadSearchBar`; Enter / shift-Enter cycles matches, each match scrolls into view and gets a brief 2 s highlight ring on the row. Search reads `text + command output + diff body + plan steps` so terminal noise and patches are findable.
- ✅ Image lightbox: clicking any user-row attachment opens a full-window viewer; Esc or backdrop click closes. Driven by `state/lightbox-store.ts` so future surfaces (assistant-emitted workspace images, etc.) can drop into the same overlay.
- ✅ Context-window warning: the existing context bar turns warn-amber and an inline banner appears at ≥ 80 % usage, suggesting the Compact thread action.

## Session 14 — Composer + UX polish ✅ DONE

- ✅ Drag-drop / paste / picker now accepts text files alongside images. Recognized files (~80 extensions: source code, markup, config, log) get inlined as fenced code blocks with the right language hint and a backtick-run-aware fence escape; binaries are refused with a friendly message.
- ✅ Per-fence Copy button on every code block (hover-reveal, 2-second "Copied" feedback, uses the same `lib/clipboard.ts` fallback path).
- ✅ Keyboard-shortcut help overlay — `?` opens it, lists nav + composer + sidebar shortcuts; new `?` button in the workspace topbar for discoverability.
- ✅ Sidebar tab choice + search query persist to IndexedDB so a refresh doesn't bounce users back to "Live" with an empty query.

## Session 13 — Theme + export + lazy code-highlight ✅ DONE

- ✅ Light theme via CSS-variable swap with explicit Auto/Light/Dark picker; system pref honored in Auto. Prism token colors recolored for the light palette so code blocks stay legible.
- ✅ Export thread to Markdown from the sidebar context menu — renders user / assistant / reasoning / command / file change / plan / failed-turn rows with sensible delimiters; `<details>` for collapsible reasoning + command output so GitHub renders cleanly.
- ✅ Lazy-load Prism language packs. Replaced 11 static imports with dynamic loaders + an `ensureLanguage` ready hook in `MarkdownContent`. Plain HTML-escaped fallback paints immediately while the chunk fetches. Main bundle: 335 KB JS / 108 KB gzipped (−5 KB gzip vs Session 12; per-language chunks 0.3–3 KB each).

## Session 12 — Polish + doc accuracy ✅ DONE

- ✅ Doc accuracy pass: PARITY.md staleness fixes (manual pairing-code resolver was already shipped, account row deduped, TrustedPairPresentation flipped to ✅, CodexModelOption noted as inline-ported, GitActionModels updated for create-branch + create-worktree, bridge-blocked surfaces explicitly tagged); agnt-web README status line refreshed; top-level README quickstart now walks both clients; AGENTS.md + CLAUDE.md acknowledge the web client in the first guardrail.
- ✅ Inline error rows for failed turns — `applyTurnFailed` always emits a `role:"system" deliveryState:"failed"` marker (even when the bridge didn't supply text); new `SystemErrorRow` styles it distinctly from assistant rows.
- ✅ `thread/compact/start` action wired into the sidebar context menu with a `system/notice` toast on success and a graceful "provider doesn't support this" fallback on `-32601`.
- ✅ Sticky reconnect banner during `connecting` / `handshaking` / `closed` / `error` after the first successful pair (initial connect is still owned by the pairing screen).
- ✅ Stop button mirrored in the chat header so it's reachable while scrolled up.
- ✅ Per-message timestamps on hover via `title={new Date(message.createdAt).toLocaleString()}` on every row component.

## Session 11 — Critical bug fix + image attachments + worktree creation ✅ DONE

- 🔴 **Bug fix:** `turn/start` was sending `params.content: string`, but no bridge translator reads that — every web turn was emitting `"turn/start had no usable text or attachments"` (tests didn't catch it because vitest mocks the RPC). Now sends `params.input: [{type:"text",text}, ...]` matching `AgntMobile/Services/CodexService+ThreadsTurns.swift:makeTurnInputPayload`. `params.content` is kept alongside as a courtesy in case any future provider wants the pre-flattened string.
- ✅ Image attachments end-to-end: composer file picker + paste + drag/drop, base64 + canvas-downscaled thumbnails, persisted on the user row, sent as `{type:"image", url:"data:..."}` items
- ✅ Worktree creation from the git panel: `git/createBranch` + `git/createWorktree` with the current branch as the base

**AI change sets deferred** — the full flow needs the reducer to track per-message forward patches captured during streaming. The bridge doesn't surface those as a clean event today (it's tied to Codex's app-server), and the per-turn `RevertSheet` from Session 10 already covers the practical "undo what this turn did" workflow. Will revisit if a clear need emerges.

## Session 10 — Workspace checkpoints (per-turn revert) ✅ DONE

- ✅ `protocol/workspace-checkpoints.ts` typed wrappers for `workspace/checkpointRestorePreview` + `workspace/checkpointRestoreApply` (capture happens automatically on the bridge)
- ✅ `state/checkpoints-store.ts` per-turn lifecycle (idle → preview → applying → done | error). `apply()` always sends `confirmDestructiveRestore: true` plus `expectedTargetCommit` so a checkpoint that drifts between preview and apply errors out.
- ✅ `RevertSheet` shows affected files + staged-files warning + untracked-files warning before allowing the destructive Restore button
- ✅ Per-row "↶ Revert" affordance on completed assistant rows; gated on `thread.cwd` (without it the bridge errors with `missing_working_directory`)
- ⛔ `turn/steer` skipped this session: 3 of 4 providers explicitly reject it (`-32601`); only Codex's native pass-through might work, and behavior is unverified. Document as provider-limited rather than ship a button that fails for most users.

## Session N — Future hardening (deferred — not blocking)

- WebPush for completion notifications (gated on a self-hostable web-push gateway; meanwhile completions surface via the existing `system/notice` toasts)
- E2E tests against a local relay + bridge in CI (would need a CI runner that can spin up the bridge with a fake provider; high lift, low parity benefit right now)
- Full Codex OAuth flow (cross-tab redirect handoff design)
- Stacked-action git operations + managed-worktree handoff (worktrees are landed in Session 11; only the iOS-style power-user flows around them remain)
- AI change sets (per-message patch revert UI on top of `workspace/revertPatchPreview` + `workspace/revertPatchApply`); the per-turn revert from Session 10 covers the bigger workflow
- `turn/steer` mid-run steering (Codex-only via native pass-through; gate on provider capability)
- `workspace/readImage` viewer for assistant-emitted image references (composer-side image attach is done in Session 11)
