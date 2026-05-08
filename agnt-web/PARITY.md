# agnt-web parity ledger

This file is the canonical inventory of every iOS surface and its TypeScript port
status. Update it as part of every session that touches `agnt-web/`.

| Status | Meaning |
| --- | --- |
| ✅ ported | functionally equivalent to iOS |
| 🟡 partial | basic version exists, edge cases / polish missing |
| 🔲 stub | typed but no real behavior; UI shows placeholder |
| ⛔ unported | not yet in agnt-web at all |

## Wire protocol

| Surface | Status | Notes |
| --- | --- | --- |
| Pairing payload validator (`QRScannerPairingValidator.swift`) | ✅ | `src/protocol/pairing.ts`, parser parity test in `test/pairing.test.ts` |
| Secure-transport handshake (`CodexService+SecureTransport.swift`) | ✅ | `src/protocol/secure-channel.ts` + `src/crypto/*`. Cross-checked against bridge's `nonceForDirection`. |
| Encrypted envelope crypto (`secure-transport.js` Node side) | ✅ | `src/crypto/envelope.ts` with vitest cross-check |
| Replay protection (`bridgeOutboundSeq`, `lastInboundCounter`) | ✅ | both directions enforced |
| Trusted-session HTTP resolver (`/v1/trusted/session/resolve`) | ✅ | `src/protocol/trusted-session.ts` |
| Manual pairing-code resolver (`/v1/pairing/code/resolve`) | ✅ | `src/protocol/pairing-code.ts` (Session 5); pairing screen has a dedicated short-code tab |
| Push notification registration | ⛔ | browsers can't receive APNs; web push is a future option |
| JSON-RPC framing | ✅ | `src/protocol/jsonrpc-client.ts` |

## CodexService method surface

| iOS file (`CodexService+…`) | Status | Session |
| --- | --- | --- |
| `Connection` | ✅ | 1 |
| `SecureTransport` | ✅ | 1 |
| `Transport` | ✅ | 1 |
| `Messages` | ✅ | 2 (item-scoped reconciliation, late-replay deltas, block-replay dedup) |
| `Incoming` | ✅ | 2 (item/agentMessage/delta, item/reasoning/textDelta, item/*/outputDelta, item/started, item/completed, turn lifecycle, thread/tokenUsage/updated) |
| `IncomingAssistant` | ✅ | 2 |
| `IncomingPlanMode` | ✅ | 3 (turn/plan/updated, item/plan/delta, presentation transitions) |
| `IncomingSupport` | ✅ | 3 + 9 (context-window + approvals + system/notice + thread/status/changed + turn/diff/updated) |
| `ThreadsTurns` | ✅ | 2 + 4 + 9 (thread/list, turns/list, turn/start/interrupt, fork, name/set, archive, unarchive, generateTitle, contextWindow/read) |
| `ThreadHistoryPagination` | ✅ | 2 |
| `ThreadFork` + `ThreadForkCompatibility` | ✅ | 4 (no per-target-project routing yet) |
| `ThreadProjectRouting` | ✅ | 9 (cwd surfaced in header + project picker drives `thread/start.cwd`) |
| `Sync` | ✅ | 2 (initialize, model/list, thread/list active+archived) |
| `Status` | 🟡 | 1 (status pill only) |
| `Account` | 🟡 | 5 (read-only `account/status/read` + `getAuthStatus` fallback; full OAuth flow deferred) |
| `RuntimeCompatibility` + `RuntimeConfig` | 🟡 | 2 (initialize round-trip + capability gate; full version negotiation in later sessions) |
| `History` | ✅ | 2 (history events replayed through the same reducer) |
| `Voice` + `VoiceCompatibility` | ✅ | 6 (MediaRecorder + Web Audio resample → 24 kHz mono WAV → voice/transcribe; Codex-only at the bridge) |
| `Notifications` | ⛔ | future (web-push when we tackle it) |
| `Pets` | ⛔ dropped | iOS-specific UX (animations / haptics / Live Activities). Use the iOS app for pets. |
| `Review` | ⛔ | future (`review/start` UI; bridge supports the RPC, no clear web surface yet) |
| `AIChangeSets` | ⛔ deferred | per-turn `RevertSheet` (Session 10) covers the practical "undo what this turn did" workflow; finer-grained per-message patch revert needs reducer to track forward patches captured during streaming |
| `WorkspaceCheckpoints` | ✅ | 10 (preview + apply per turn; checkpointDiff + Copy not yet wired in UI but bridge-ready) |
| `WorkspaceImages` | ⛔ | future (needs image attachment composer first) |
| `ProjectFolders` | ✅ | 9 (project/quickLocations + listDirectory + searchDirectories + folder picker UI) |
| `TrustedPairPresentation` | ✅ | 5 (Settings shows current Mac fingerprint + per-Mac forget; no inline sidebar badge) |
| `Helpers` | n/a | utility — port functions on demand |
| `AssistantReplayDeduper` | ✅ | 2 |
| `CodexMessagePersistence` | ✅ | 2 (IndexedDB-backed, debounced per thread) |
| `AIChangeSetPersistence` | ⛔ | 4 (deferred with AI change sets) |
| `Coordination/*` | ⛔ | 4 |
| `Payments` (StoreKit) | ⛔ n/a | StoreKit is iOS-only; agnt-web is self-hosted and doesn't sell anything to the user |
| `DesktopHandoffService` | ⛔ | not applicable |
| `GPTVoiceTranscriptionManager` | n/a | bridge owns the auth context + ChatGPT call; web client just sends the wav bytes |

## Models

The iOS `Models/` folder maps to TypeScript in two places: protocol-level types
(`src/protocol/types.ts`) and feature-state types (per `state/*-store.ts`).

| iOS model | Status | Where |
| --- | --- | --- |
| `RPCMessage` | ✅ | `src/protocol/types.ts` |
| `JSONValue` | n/a | TS uses `unknown` |
| `CodexThread` | ✅ | `models/thread.ts` (with snake_case aliases) |
| `CodexMessage` | ✅ | `models/message.ts` (full kind/role/deliveryState surface) |
| `CodexMessageOrderCounter` | ✅ | `models/order-counter.ts` |
| `ContextWindowUsage` | ✅ | `models/context-window.ts` |
| `CommandExecutionDetails` | ✅ | `models/message.ts` (with `appendCommandOutput` trimmer) |
| `CodexImageAttachment` | ✅ | 11 (`models/message.ts:ImageAttachment` — payload + thumbnail data URLs, optional fileName + byteLength) |
| `CodexSkillMetadata` | ⛔ bridge-blocked | bridge translators don't expose `skills/list` |
| `CodexModelOption` | ✅ | 2 (inline as `state/sync.ts:ModelOption`) |
| `CodexCollaboration` | ⛔ | future |
| `CodexAccessMode` | ✅ | 3 (as `state/threads-store.ts:PermissionMode`) |
| `CodexReasoningEffortOption` | ✅ | 3 (per-turn flag) |
| `CodexFuzzyFileMatch` | ⛔ bridge-blocked | bridge translators don't expose `fuzzyFileSearch` |
| `CodexRateLimitStatus` | ⛔ bridge-blocked | bridge translators don't expose `account/rateLimits` |
| `CodexServiceTier` | ⛔ | future |
| `GitActionModels` | 🟡 | sync/diff/commit/push/branches/checkout/createBranch/createWorktree (Sessions 4 + 8 + 11); managed-worktree handoff + stacked actions still deferred |
| `AIChangeSetModels` | ⛔ | future |
| `PetCompanionModels` | ⛔ | future |
| `AppFont` | n/a | use system fonts |

## Views

iOS `Views/` mirrors `agnt-web/src/components/`.

| iOS area | Web component | Status |
| --- | --- | --- |
| Onboarding / pairing | `components/pairing/{PairingScreen,CameraQRScanner}.tsx` | ✅ (paste, short code w/ relay round-trip, camera scan via BarcodeDetector) |
| Sidebar | `components/sidebar/Sidebar.tsx` | ✅ (live/archived tabs, cwd hint, selection, "+ New" button, running indicator) |
| Project picker | `components/project/ProjectPicker.tsx` + `state/project-store.ts` + `protocol/project.ts` | ✅ (quick locations, browse, search, ascend, select cwd) |
| New chat modal | `components/chat/NewChatModal.tsx` | ✅ (prompt + project selector + flag-aware turn/start) |
| Home (chat) | `components/chat/{ChatView,Composer,MarkdownContent}.tsx` + `rows/*.tsx` | ✅ (kind-aware rendering: assistant/user/reasoning/command/file-change/tool) |
| Markdown | `components/chat/MarkdownContent.tsx` + `markdown-blocks.ts` + `syntax-highlight.ts` | ✅ (fenced code w/ Prism, inline code, bold/italic, headings 1–6, ordered/bullet lists, tables w/ column alignment, links + images w/ scheme allowlist) |
| Composer history | `components/chat/Composer.tsx` | ✅ (Session 16; up-arrow recalls past prompts at empty draft, down-arrow steps forward, Esc restores in-progress draft, manual edit drops out of recall) |
| Lightbox sibling navigation | `components/shared/Lightbox.tsx` + `state/lightbox-store.ts` | ✅ (Session 16; left/right arrow keys + on-screen ‹ › buttons cycle through a row's attachments; counter `1 / N`) |
| Approvals modal | `components/approvals/ApprovalModal.tsx` + `state/approvals-store.ts` | ✅ (command + file change, accept / decline / acceptForSession) |
| System-notice toasts | `components/shared/NoticeStack.tsx` + `state/notices-store.ts` | ✅ (auto-dismiss, severity-aware) |
| Plan-mode rendering | `components/chat/rows/PlanRow.tsx` | ✅ (steps + streaming text + presentation transitions) |
| Per-turn flag bar | `components/chat/TurnFlagBar.tsx` | ✅ (model, reasoning effort, plan mode, permission mode) |
| Voice composer button | `components/chat/VoiceButton.tsx` + `state/voice-store.ts` + `lib/audio-encode.ts` | ✅ (record → resample → WAV → voice/transcribe; final transcript drops into composer draft) |
| Settings | `components/settings/SettingsModal.tsx` + `state/account-store.ts` | ✅ (connection info, account status, trusted-Mac mgmt with forget) |
| About | `components/settings/AboutModal.tsx` | ✅ (version, source link, license) |
| Chat header (title + cwd + provider) | `components/chat/ChatHeader.tsx` | ✅ |
| Sidebar context menu (rename / fork / archive) | `components/sidebar/ThreadContextMenu.tsx` | ✅ |
| Git panel (status / diff / branches / commit / push / pull / checkout / create-branch / create-worktree) | `components/git/GitPanel.tsx` | ✅ (Sessions 4 + 8 + 11; managed-worktree handoff + stacked actions deferred) |
| Structured user-input prompts | `components/structured-input/StructuredInputModal.tsx` | ✅ (free text, secret, single-/multi-select) |
| Pet | ⛔ dropped | iOS-specific UX |
| Payments | ⛔ n/a | StoreKit doesn't apply to self-hosted web |
| Turn detail (`Views/Turn/*`) | ✅ | rendered inline by `components/chat/rows/*.tsx`; no separate detail view needed |
| Shared (modals, badges, toasts) | `components/shared/` | ✅ (loading, status pill, notice toasts) |
| Sidebar search + j/k navigation | `components/sidebar/Sidebar.tsx` + `state/thread-filter.ts` + `lib/keyboard.ts` | ✅ |
| Copy-to-clipboard on assistant rows | `components/chat/rows/AssistantRow.tsx` + `lib/clipboard.ts` | ✅ (Async Clipboard API + execCommand fallback for non-secure dev origins) |
| `/` to focus composer · `Esc` closes overlays | `components/workspace/Workspace.tsx` | ✅ |
| Per-turn revert (workspace checkpoints) | `components/checkpoints/RevertSheet.tsx` + `state/checkpoints-store.ts` + `protocol/workspace-checkpoints.ts` | ✅ (preview shows affected/staged/untracked, apply requires confirmDestructiveRestore) |
| Image attachments (composer + user-row thumbs) | `components/chat/Composer.tsx` + `lib/image-attach.ts` + `models/message.ts:ImageAttachment` | ✅ (file picker, paste, drag-drop, canvas-downscaled thumbnails, sent as `params.input[].image`) |
| Branch + worktree creation | `components/git/GitPanel.tsx` + `state/git-store.ts:createBranch/createWorktree` | ✅ (basic flow; managed-worktree handoff + stacked actions still deferred) |
| Service worker (offline app shell) | `public/sw.js` | ✅ (production-only registration; cache-first hashed assets, network-first navigations, never caches relay/WS) |
| Theme picker (Auto / Light / Dark) | `state/theme-store.ts` + `storage/prefs-store.ts:applyThemeToDocument` + Settings segmented control | ✅ (Session 13; persisted to IndexedDB, respects `prefers-color-scheme` in Auto, Prism token colors recoloured for light) |
| Export thread to Markdown | `lib/thread-export.ts` + sidebar context menu | ✅ (Session 13; renders user / assistant / reasoning / command / file change / plan / failed-turn rows) |
| Lazy-load Prism language packs | `components/chat/syntax-highlight.ts` | ✅ (Session 13; per-language Vite chunks fetched on first use, ~5 KB gzip off the main bundle) |
| Text-file ingest in composer | `lib/text-attach.ts` + `components/chat/Composer.tsx` | ✅ (Session 14; drag-drop / paste / picker; auto-fenced with language hint inferred from extension; backtick-run-aware fence escape) |
| Per-fence Copy button | `components/chat/MarkdownContent.tsx:CodeBlock` | ✅ (Session 14; hover-reveal, two-second "Copied" feedback) |
| Keyboard-shortcut help overlay | `components/shared/HelpModal.tsx` | ✅ (Session 14; `?` opens, lists nav / composer / sidebar shortcuts) |
| Sidebar prefs persistence (tab + query) | `storage/prefs-store.ts:loadSidebar/saveSidebar` | ✅ (Session 14; survives reload via IndexedDB) |
| Sticky-follow scroll + Jump-to-bottom | `lib/sticky-scroll.ts` + `components/chat/ChatView.tsx` | ✅ (Session 15; doesn't yank scroll while user reads history; floating Latest button surfaces when offset is significant) |
| In-thread search | `components/chat/ThreadSearchBar.tsx` | ✅ (Session 15; `f` and ⌘/Ctrl+F open it; Enter / shift-Enter cycles matches; scrolls into view + highlights row) |
| Image lightbox | `components/shared/Lightbox.tsx` + `state/lightbox-store.ts` | ✅ (Session 15; click any user-row attachment; Esc / backdrop-click closes) |
| Context-window warning | `components/chat/ChatView.tsx` | ✅ (Session 15; bar turns warn-amber + inline banner when usage ≥ 80% suggesting compact) |
| Inline failed-turn rows | `components/chat/rows/index.tsx` (`role: "system"` + `deliveryState: "failed"`) | ✅ (Session 12; replaces the global error banner for turn failures) |
| Reconnect banner | `components/shared/ReconnectBanner.tsx` | ✅ (Session 12; visible during `connecting` / `handshaking` after first successful pair) |
| Stop button in chat header | `components/chat/ChatHeader.tsx` | ✅ (Session 12; mirrors composer Stop so it's reachable while scrolled up) |
| Per-message timestamps | row hover via `title={new Date(message.createdAt).toLocaleString()}` | ✅ (Session 12; lightweight, no extra layout) |
| `thread/compact/start` | `state/threads-store.ts:compactThread` + sidebar context menu | ✅ (Session 12; bridge supports across all providers) |

## Storage

| iOS Keychain key | Web equivalent | Status |
| --- | --- | --- |
| `phoneIdentityState` | `idb["phoneIdentity"]` | ✅ |
| `relaySessionId` + relay metadata | `idb["relayPairing"]` | ✅ |
| `trustedMacRegistry` | `idb["trustedMacRegistry"]` | ✅ |
| `lastTrustedMacDeviceId` | inside trusted registry | ✅ |
| `relayLastAppliedBridgeOutboundSeq` | inside relay pairing | ✅ |
