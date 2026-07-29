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
| `IncomingSupport` | ✅ | 3 + 9 + desktop mirror (context-window + approvals + system/notice + thread/status/changed + turn/diff/updated + turnless `codex/event/agent_message` completions) |
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
| `Notifications` | 🟡 | 21 (browser desktop notifications via `Notification` API on `turn/completed`/`turn/failed` when tab is hidden; auto/on/off pref; per-thread coalescing tag. Web-push for fully-closed-tab delivery still future.) |
| `Terminal` (bridge-PTY) | 🟡 | 32 (different shape from iOS — browser cannot open raw SSH; instead the bridge spawns its login shell via `node-pty` and proxies bytes over `terminal/*` JSON-RPC + `terminal/output` notifications. xterm.js + addon-fit on the front-end. Off by default; opt-in via `enableWebTerminal` bridge preference. Single session, single PTY for now — multi-tab sessions UI deferred.) |
| `Pets` | ⛔ dropped | iOS-specific UX (animations / haptics / Live Activities). Use the iOS app for pets. |
| `LiveActivity` / Dynamic Island | ⛔ dropped | iOS-only — done on iOS (`AgntMobile/AgntWidget`; Live Activity + Dynamic Island surface an in-flight turn on the Lock Screen, driven by local ActivityKit updates). No browser equivalent (no Lock Screen / Dynamic Island host). Use the iOS app. |
| `Review` | 🟡 | `/review` starts inline `review/start` for uncommitted changes; `/review <base-branch>` starts an inline base-branch review. Visual target picker still future. |
| `AIChangeSets` | ⛔ deferred | per-turn `RevertSheet` (Session 10) covers the practical "undo what this turn did" workflow; finer-grained per-message patch revert needs reducer to track forward patches captured during streaming |
| `WorkspaceCheckpoints` | ✅ | 10 + checkpoint diff (preview + apply per turn; Revert sheet can load/render/copy the checkpoint diff before restore) |
| `WorkspaceImages` | ✅ | 18 + 30 (workspace/readImage wrapper + cache; MarkdownContent resolves non-http image refs against thread cwd; click any inline image to open in the shared Lightbox) |
| Workspace SVG preview (hardened) | ✅ | `components/chat/WorkspaceSvgPreview.tsx` renders workspace `.svg` artifacts and SVG data URLs in a sandboxed iframe with an offline CSP document, while `lib/workspace-svg-preview.ts` strips external `href`/`xlink:href`/`src` references before render. Covered by `workspace-svg-preview.test.ts` + `markdown-inline.test.tsx`. |
| Syntax-highlighted code preview | ✅ | `MarkdownContent` routes workspace-local text links through `workspace/readFile`; `WorkspaceTextFilePreview` renders the read-only sheet with Prism highlighting, selectable text, copy, and line numbers by default. Covered by `workspace-text-preview.test.ts` + `markdown-inline.test.tsx`. |
| `ProjectFolders` | ✅ | 9 (project/quickLocations + listDirectory + searchDirectories + folder picker UI) |
| `TrustedPairPresentation` | ✅ | 5 + multi-Mac (Settings lists trusted Macs with per-Mac forget; sidebar `MacSwitcher` row surfaces the active Mac + lets the user switch between paired Macs via `useConnectionStore.switchMac` → `pairingStore.setLastTrustedMac` → `resolveTrustedSession` → reconnect. Threads stay shared across Macs by design.) |
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
| `CodexServiceTier` | ✅ | Fast Mode toggle decodes model speed metadata, persists `serviceTier: "fast"`, and sends it only when the selected/default model supports it. |
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
| Markdown | `components/chat/MarkdownContent.tsx` + `markdown-blocks.ts` + `syntax-highlight.ts` | ✅ (fenced code w/ Prism, inline code, bold/italic, headings 1–6, ordered/bullet/task lists, tables w/ column alignment, links + images w/ scheme allowlist, autolinks, blockquotes, horizontal rules, and streaming inline marker auto-close for assistant rows) |
| Composer slash commands | `components/chat/Composer.tsx` + `state/slash-commands.ts` | ✅ (Session 17 + review slice; `/review`, `/compact`, `/fork`, `/archive`, `/unarchive`, `/stop`; ↑/↓ navigate, Enter runs, Tab autocompletes, Esc dismisses) |
| Composer draft autosave | `storage/drafts-store.ts` + `components/chat/Composer.tsx` | ✅ (Session 19; per-thread draft persisted to IndexedDB with 400 ms debounce; hydrates on thread switch and beforeunload, clears on send) |
| Pinned threads | `storage/prefs-store.ts:loadPinnedThreadIds` + `state/threads-store.ts:togglePinThread` + sidebar | ✅ (Session 19; pinned threads sort to top of the live tab, ★ glyph in the row, Pin/Unpin in the context menu) |
| Power-user keyboard shortcuts | `components/workspace/Workspace.tsx` | ✅ (Session 19 + 21; `e` exports, `r` reverts last turn, `n` opens New Chat, `p` toggles pin, ⌘/Ctrl+K opens cross-thread palette) |
| Cross-thread search palette | `components/shared/CommandPalette.tsx` | ✅ (Session 21; ⌘/Ctrl+K opens; walks every cached thread's messages with `searchableText`; ↑/↓/Enter/Esc; capped at 80 hits) |
| Browser desktop notifications | `lib/notifications.ts` + `storage/prefs-store.ts:loadNotifications` + `state/threads-store.ts:notifyTurnFinished` + Settings | ✅ (Session 21; gated on tab-hidden + permission + auto/on/off pref; per-thread coalescing tag; opt-in only — never auto-prompts) |
| Responsive narrow-viewport layout | `components/workspace/Workspace.tsx` + sidebar drawer styles | ✅ (Session 22; below 768 px the sidebar becomes an overlay drawer with a hamburger toggle; selection or backdrop-tap closes; wide viewports unchanged) |
| Multi-select bulk thread actions | `components/sidebar/Sidebar.tsx` + `lib/thread-export.ts:exportThreadsToMarkdown` | ✅ (Session 22; checkbox mode for batch Archive / Unarchive / Export-to-Markdown; one concatenated `.md` per multi-export) |
| Streaming throughput indicator | `state/streaming-stats-store.ts` + `components/chat/ChatHeader.tsx:ThroughputPill` | ✅ (Session 22; per-thread char-counter seeded on turn/started, cleared on turn/completed/failed; ticks every 500 ms while streaming) |
| Retry failed turn | `components/chat/rows/SystemErrorRow.tsx` + `state/threads-store.ts:retryFailedTurn` | ✅ (Session 23; inline Retry button on failed-turn rows re-issues turn/start with the original user input + attachments) |
| Per-thread unread indicator | `state/threads-store.ts:isThreadUnread` + `storage/prefs-store.ts:loadLastVisited` + sidebar row dot | ✅ (Session 23; reload-stable comparison of thread.updatedAt against persisted lastVisitedAt; clears on selectThread) |
| User-defined slash commands | `state/custom-slash-commands-store.ts` + `storage/prefs-store.ts:loadCustomSlashCommands` + Settings section | ✅ (Session 23; persisted name/body snippets surface alongside built-ins in the composer's slash menu; expand into the draft instead of running a side effect; built-ins always win on name collision) |
| Inline file diff viewer | `components/git/GitPanel.tsx` + `components/git/DiffView.tsx` + `lib/git-diff-parser.ts` | ✅ (Session 24; per-file slices of the unified patch render inline with `+/-/@@` coloring; lazy fetch on first expand) |
| Drag-reorder pinned threads | `state/threads-store.ts:reorderPinnedThreads` + `state/thread-grouping.ts` (walks pin Set iteration order) + sidebar HTML5 drag/drop | ✅ (Session 24; manual ordering survives reload; non-pinned ids in the input array are filtered out) |
| Composer draft stats footer | `lib/draft-stats.ts` + `components/chat/Composer.tsx:DraftStatsFooter` | ✅ (Session 24; chars + words + ~tokens (chars/4 heuristic, marked with `~`); hidden when draft is empty) |
| Per-message bookmarks | `state/bookmarks-store.ts` + `components/chat/rows/BookmarkButton.tsx` + `ThreadSearchBar` star filter + `storage/prefs-store.ts:loadBookmarks` | ✅ (Session 25; star icon on assistant + user rows; "Show starred only" toggle filters the timeline; persisted across reloads) |
| Mark thread as unread | `state/threads-store.ts:markThreadUnread` + sidebar context menu | ✅ (Session 25; drops the lastVisitedAt entry so the Session 23 unread dot reappears) |
| Composer find/replace | `lib/draft-find-replace.ts` + `components/chat/ComposerFindReplace.tsx` | ✅ (Session 25; ⌘/Ctrl+Shift+F (textarea-scoped) opens Find/Replace with Next/Prev/Replace/All; case-insensitive, non-overlapping matches) |
| @file mention picker in composer | `lib/mention-detector.ts` + `lib/file-mention.ts` + `components/chat/Composer.tsx` | ✅ (Session 26; caret-aware `@` token opens an inline file picker rooted at the active thread's cwd via `project/searchDirectories`; rejects email-style false positives; selecting splices the cwd-relative path) |
| Composer auto-resize textarea | `components/chat/Composer.tsx:useLayoutEffect` | ✅ (Session 26; grows up to ~10 visual rows, then scrolls internally; replaces the old `rows={3}` hard-cap) |
| Conversation export to JSON | `lib/thread-export.ts:exportThreadToJson` + sidebar context menu | ✅ (Session 26; stable `schemaVersion: 1` payload alongside the Markdown export; image attachments by reference, no payload data URLs) |
| Per-row Reply / quote | `components/chat/rows/AssistantRow.tsx` + `state/composer-inbox-store.ts` + `lib/quote.ts` | ✅ (Session 27; ⤴ Reply prepends `> quoted text` into the composer draft; cross-thread Reply queues until the originating thread is selected) |
| Custom slash command variables | `lib/slash-variables.ts` + `state/slash-commands.ts:buildCustomSlashCommand` | ✅ (Session 27; user-defined snippet bodies expand `{cwd}` / `{thread}` / `{selection}` / `{date}` / `{time}` / `{datetime}` at run time) |
| Cross-thread bookmark filter in palette | `components/shared/CommandPalette.tsx` | ✅ (Session 27; "★ all / ☆ N" toggle filters cross-thread search to bookmarked messages; empty-query star-list view works) |
| Chat nav between user messages | `components/chat/ChatView.tsx` | ✅ (Session 28; `[` / `]` jump prev/next user row anchored on the closest-to-viewport-midline) |
| URL hash deep-linking + per-row Copy link | `lib/hash-routing.ts` + `state/chat-focus-store.ts` + `components/chat/rows/RowLinkButton.tsx` | ✅ (Session 28; `#thread/<id>` and `#thread/<id>/message/<id>` restore on boot; `history.replaceState` keeps the bar in sync; 🔗 row action copies a permalink) |
| Approvals batch Accept-all / Decline-all | `state/approvals-store.ts:decideAllOfKind` + `components/approvals/ApprovalModal.tsx` | ✅ (Session 28; only surfaced when >1 approval of the same kind is queued; scoped to that kind so different kinds can't ride along) |
| Workspace file browser side-panel | `components/files/FileBrowser.tsx` + `state/file-browser-store.ts` | ✅ (Session 29; tree-view rooted at active thread cwd via `project/listDirectory`; lazy-fetched children; clicking a file inserts an `@path` mention via the composer inbox) |
| Per-thread color tag | `state/threads-store.ts:setThreadColor` + `storage/prefs-store.ts:THREAD_COLOR_VALUES` + sidebar context menu + chat header | ✅ (Session 29; 6-color palette persisted; sidebar 3 px bar + chat header dot) |
| Connection latency indicator | `state/latency-store.ts` + `protocol/jsonrpc-client.ts` (`onLatencySample`) + `components/shared/StatusPill.tsx` | ✅ (Session 29; passive RPC RTT median over a 16-sample rolling window; <100 ok, <500 warn, >=500 slow tiers; hidden when stale or idle) |
| Document title reflects active thread | `lib/document-title.ts` + `components/workspace/Workspace.tsx` | ✅ (Session 20; `[name] · agnt`) |
| Sidebar grouped by recency | `state/thread-grouping.ts` + `components/sidebar/Sidebar.tsx` | ✅ (Sessions 20 + 30; Pinned / Today / Yesterday / This week / Earlier; archived stays flat; Session 30 makes group headers click-collapsible (persisted via `prefs.sidebar.collapsedGroups`) and j/k skips collapsed groups) |
| Sidebar density toggle | `components/sidebar/Sidebar.tsx` + `storage/prefs-store.ts:SidebarDensity` | ✅ (Session 30; ☰/≡ button in the sidebar header swaps `comfortable` ↔ `compact` row padding/font; persisted) |
| Title flash on hidden-tab turn completion | `lib/document-title.ts:flashTitle` + threads-store `turn/completed`/`turn/failed` handlers | ✅ (Session 20; cycles "(Turn done) [name] · agnt" against neutral; auto-stops on visibility) |
| Composer history | `components/chat/Composer.tsx` | ✅ (Session 16; up-arrow recalls past prompts at empty draft, down-arrow steps forward, Esc restores in-progress draft, manual edit drops out of recall) |
| Lightbox sibling navigation | `components/shared/Lightbox.tsx` + `state/lightbox-store.ts` | ✅ (Session 16; left/right arrow keys + on-screen ‹ › buttons cycle through a row's attachments; counter `1 / N`) |
| Approvals modal | `components/approvals/ApprovalModal.tsx` + `state/approvals-store.ts` | ✅ (command + file change, accept / decline / acceptForSession) |
| System-notice toasts | `components/shared/NoticeStack.tsx` + `state/notices-store.ts` | ✅ (auto-dismiss, severity-aware) |
| Plan-mode rendering | `components/chat/rows/PlanRow.tsx` | ✅ (steps + streaming text + presentation transitions) |
| Per-turn flag bar | `components/chat/TurnFlagBar.tsx` | ✅ (model, reasoning effort, plan mode, permission mode) |
| Voice composer button | `components/chat/VoiceButton.tsx` + `state/voice-store.ts` + `lib/audio-encode.ts` | ✅ (record → resample → WAV → voice/transcribe; final transcript drops into composer draft) |
| Settings | `components/settings/SettingsModal.tsx` + `state/account-store.ts` | ✅ (connection info, account status, trusted-Mac mgmt with forget; Session 31 adds a search-as-you-type filter; Session 32 adds Turn-completion webhook + Diagnostic report sections) |
| Long-thread virtualization | `components/chat/ChatView.tsx` + `agnt-msg-cv` CSS | ✅ (Session 32; CSS `content-visibility: auto` on each row wrapper skips off-screen layout + paint; `MessageRow` wrapped in `React.memo` so a parent re-render doesn't cascade) |
| Undo destructive actions | `state/undo-store.ts` + `components/shared/UndoToast.tsx` | ✅ (Session 32; archive / unarchive / rename publish a 5-second reverse callback; UndoToast surfaces it bottom-center) |
| Word-level intra-line diff | `lib/diff-word-tokens.ts` + `components/git/DiffView.tsx` | ✅ (Session 32; LCS over per-line tokens highlights only the differing tokens for adjacent `-` / `+` line pairs) |
| Copy patch per file | `components/git/GitPanel.tsx:CopyPatchButton` | ✅ (Session 32; copies the active file's unified-diff slice for paste into `git apply` / PR comments) |
| Diagnostic report export | `lib/diagnostic-report.ts` + Settings "Diagnostic report" section | ✅ (Session 32; JSON snapshot of connection / latency / notices / IDB key counts / browser info; thread contents excluded; pairing ids hashed via `shortHash`) |
| Turn-completion webhook | `lib/turn-webhook.ts` + `storage/prefs-store.ts:loadTurnWebhook` + Settings section | ✅ (Session 32; fire-and-forget POST on `turn/completed` / `turn/failed`; http(s) URLs only; payload excludes message text) |
| State backup / restore | `lib/state-backup.ts` + `storage/idb.ts:keys` + Settings "Backup & restore" section | ✅ (Session 30; exports `prefs.*` + `messages:*` keys to a versioned JSON file; identity + pairing keys hard-blocklisted; import overwrites matching keys + prompts a reload) |
| Per-turn timing chip | `state/turn-timing-store.ts` + `components/chat/rows/AssistantRow.tsx` | ✅ (Session 30; records start/end ms by turnId; `⏱ N.Ns` chip on completed assistant rows; memory-only, retention capped at 200 turns/thread) |
| About | `components/settings/AboutModal.tsx` | ✅ (version, source link, license) |
| Chat header (title + cwd + provider) | `components/chat/ChatHeader.tsx` | ✅ |
| Sidebar context menu (rename / fork / archive) | `components/sidebar/ThreadContextMenu.tsx` | ✅ (Session 31 adds Duplicate… via `state/new-chat-prefill-store.ts`, plus inline rename via double-click on the thread row) |
| Sidebar inline rename | `components/sidebar/Sidebar.tsx:SidebarRow` + `state/threads-store.ts:renameThread` | ✅ (Session 31; double-click the title to swap into an input; Enter commits, Esc/blur reverts) |
| Provider color badge | `components/chat/ChatHeader.tsx:providerSlug` + `agnt-provider-*` CSS | ✅ (Session 31; tints the existing tag for codex / claude / opencode / cursor; light + dark theme tones) |
| Vim-style chat jump (`gg` / `G`) | `components/chat/ChatView.tsx` | ✅ (Session 31; double-press `g` within 600ms scrolls to top; `G` jumps to latest) |
| Slow-response toast (15s without output) | `state/slow-response-watcher.ts` | ✅ (Session 31; armed on `turn/started`, cancelled on terminal frames; surfaces as an info notice via `notices-store`) |
| Disconnect drafts-saved toast | `state/connection-store.ts:onStatus` | ✅ (Session 31; one-shot warn notice on `open → closed/error` so users know their drafts persist locally even though the link dropped) |
| Composer markdown preview | `components/chat/Composer.tsx` + `MarkdownContent` | ✅ (Session 31; toggle button in the actions row swaps the editor into a side-by-side preview; stacked layout below 768px) |
| Composer prompt history dropdown | `components/chat/Composer.tsx:PromptHistoryDropdown` | ✅ (Session 31; ↺ button reveals the active thread's recent user prompts; clicking drops the full text into the draft) |
| Git panel (status / diff / branches / commit / push / pull / stash / stashPop / checkout / create-branch / create-worktree) | `components/git/GitPanel.tsx` | ✅ (Sessions 4 + 8 + 11 + 30 + 31; Session 31 adds quick `Stash` / `Stash pop` buttons (gated on dirty/clean tree respectively) plus per-hunk collapse in `DiffView` via `lib/diff-hunk-grouper.ts`; managed-worktree handoff + stacked actions deferred) |
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
| Theme picker (Auto / Light / Dark) | `state/theme-store.ts` + `storage/prefs-store.ts:applyThemeToDocument` + Settings segmented control | ✅ (Session 13; persisted to IndexedDB, respects `prefers-color-scheme` in Auto, Prism token colors recoloured for light; Session 33 retunes the underlying palette to UIKit semantic colors so the web client visually reads as a continuation of AgntMobile) |
| Visual fidelity to AgntMobile | `styles/global.css` (CSS variable palette + radius scale + SF Pro typography) + `components/shared/Icon.tsx` + `components/shared/Sheet.tsx` | 🟡 (Sessions 33 + 34; iOS UIKit colors + radius scale + body type, hand-traced SF-Symbols-style SVG icon set replacing all unicode glyphs, iOS-style sheet presentation with drag-to-dismiss for `NewChatModal` + `ProjectPicker`. Still out of scope: proprietary SF Symbols font, haptics, pixel-identical UIKit transition curves) |
| Bottom-sheet modal presentation | `components/shared/Sheet.tsx` + `lib/sheet-drag.ts` | ✅ (Sessions 34 + 35 + 36; slide-up animation, grabber handle, pointer-driven drag-to-dismiss past 120px or 600 px/s flick velocity; Session 35 adds `presentation: "sheet"` / `"alert"` modes + `closable` prop; ApprovalModal / RevertSheet use alert mode with closable=false for safety; Session 36 migrates HelpModal + CommandPalette to Sheet) |
| Multi-window thread links | `components/sidebar/Sidebar.tsx:SidebarRow` (⌘/Ctrl-click + middle-click) | ✅ (Session 36; opens the thread's hash deep-link in a new tab so multi-tab workflows preserve context) |
| Saved searches in CommandPalette | `components/shared/CommandPalette.tsx` + `storage/prefs-store.ts:loadSaveSavedSearches` | ✅ (Session 36; persists up to 8 named queries; chip strip apply / × forget) |
| Fuzzy command-palette search + recent MRU | `lib/fuzzy-match.ts` + `storage/prefs-store.ts:loadSaveRecentSearches` | ✅ (Session 37; LCS-style subsequence matcher with prefix / word-start / consecutive scoring; recent searches surfaced on empty input, capped at 8) |
| Per-thread overrides | `storage/prefs-store.ts:ThreadOverride` + `state/threads-store.ts:setThreadOverride` + `components/sidebar/ThreadOverridesSheet.tsx` | ✅ (Session 37; per-thread system prompt + model + reasoning effort override the global picks at send time) |
| Per-turn changes summary | `components/chat/rows/AssistantRow.tsx` (turnChanges chip) | ✅ (Session 37 lite + Session 38 full; `+N −M` chip aggregates `fileChange` rows sharing the turnId, click scrolls to changes; per-file revert button on each FileChangeRow via the bridge's existing `workspace/revertPatchApply` RPC) |
| Per-turn token usage / cost | `lib/token-usage.ts` + `state/turn-token-usage-store.ts` + `components/chat/rows/AssistantRow.tsx` | ✅ (Session 38; chip surfaces input/output/cached + USD cost when the provider reports it. Captured from the bridge's existing `thread/tokenUsage/updated` notification) |
| AI-drafted commit messages | `state/git-store.ts:generateCommitMessage` + `components/git/GitPanel.tsx` Draft button | ✅ (Session 39; calls the bridge's `git/generateCommitMessage` RPC. Codex-only on the bridge; non-Codex providers surface a polite error in the panel) |
| Slash-command argument hints | `lib/slash-variables.ts` (`parseSlashArgs`, `describeBodyArgs`, `{1}`/`{2}`/`$ARGUMENTS` placeholders) + Composer slash menu | ✅ (Session 39; positional + ARGUMENTS placeholders, quoted-arg parsing, argv-shape hints in the slash menu) |
| Retry failed turn with a different model | `state/threads-store.ts:retryFailedTurn(options.modelOverride)` + `SystemErrorRow` picker | ✅ (Session 39; one-shot model swap on retry without disturbing per-thread / global picks) |
| Mobile / phone responsive layout | `styles/global.css` `@media (max-width: 600px)` (dialog viewport-fit, footer stacking, row-action min-tap-targets, ChatHeader horizontal scroll, composer wrap) | ✅ (Session 39; complements the existing 768px sidebar-drawer rules) |
| Branch indicator in ChatHeader | `components/chat/ChatHeader.tsx` (branch pill) + `state/git-store.ts:byThread` | ✅ (Session 40; subscribes to the cached git-status, dirty marker, click opens GitPanel) |
| CommandPalette filter chips | `lib/search-filter.ts` + segmented controls in `components/shared/CommandPalette.tsx` | ✅ (Session 40; role + date-window + model filters AND-combined, browseable with empty query when active) |
| Code-block language pill | `components/chat/MarkdownContent.tsx` (top-left pill mirroring the Copy button) | ✅ (Session 40; canonical language id for Prism-aliased fences) |
| Code-block line numbers | `components/chat/MarkdownContent.tsx` (`#` toggle + aside gutter) | ✅ (Session 41; per-block, hidden on single-line blocks, line-height locked via CSS custom prop) |
| Per-thread notification mute | `state/threads-store.ts:setThreadMuted` + `mutedThreadIds: Set` + `ThreadContextMenu` toggle | ✅ (Session 41; layers on top of global `shouldNotify()` so a muted thread skips alerts even when notifications are globally on) |
| Side-by-side diff view | `lib/diff-split.ts` + `components/chat/rows/FileChangeRow.tsx` Split/Unified toggle | ✅ (Session 41; parses unified-diff hunks with left/right line numbers, zips remove/add runs into 1:1 pairs, pads the shorter side) |
| Relative timestamps in row tooltips | `lib/relative-time.ts` + 8 row callsites | ✅ (Session 42; locale-aware via `Intl.RelativeTimeFormat`, falls back to absolute past 1 week, hover gives both relative + absolute joined by `·`) |
| Modal focus trap | `components/shared/Sheet.tsx` (Tab / Shift+Tab cycle + restore on close) | ✅ (Session 42; closes the keyboard-bleed gap where Tab inside a Sheet escaped to the underlying chat) |
| PWA manifest + Install prompt | `public/manifest.webmanifest` + generated `public/icon-*.png` assets from `assets/agnt-app-icon.png` via `scripts/generate-app-icons.sh` (also refreshes Android/iOS app icons) + `state/install-prompt-store.ts` + Settings Install section | ✅ (Session 42; captures `beforeinstallprompt`, surfaces a button in Settings; standalone-mode users see "already installed" affirmation) |
| Lightbox zoom + pan | `components/shared/Lightbox.tsx` (wheel zoom anchored on cursor, double-click toggle, drag pan, `0` reset) | ✅ (Session 42; sibling nav hides when zoomed so a click-after-pan doesn't accidentally cycle) |
| Sound cue on turn complete | `lib/sound-cue.ts` + Settings → Notifications slider | ✅ (Session 43; WebAudio synth, no asset; off by default; distinguishable major-third vs minor-second tones for completed / failed) |
| High-contrast theme variant | `state/contrast-store.ts` + `:root[data-contrast="high"]` CSS | ✅ (Session 43; orthogonal to theme; follows `prefers-contrast: more` when no explicit pick) |
| NewChatModal starter prompts | `components/chat/NewChatModal.tsx:STARTER_PROMPTS` | ✅ (Session 43; 5 quick-start chips that prefill the textarea, hidden once typing starts) |
| Mermaid diagrams in markdown | `components/chat/MermaidBlock.tsx` + lazy dispatch in `MarkdownContent.tsx:renderFence` | ✅ (Session 43; lazy-loaded; ~400 KB gzip across core+deps when triggered, zero cost otherwise) |
| Model name pill in ChatHeader | `components/chat/ChatHeader.tsx` (`agnt-chat-header-model`) | ✅ (Session 44; resolves override → global flag → thread.model) |
| Cmd / Ctrl + 1..9 thread quick-switch | `components/sidebar/Sidebar.tsx` window keydown handler | ✅ (Session 44; bypasses typing-target gate; uses `event.code` for layout-stable digit detection) |
| Sidebar color tag filter | `components/sidebar/Sidebar.tsx` transient `colorFilter` + swatch strip | ✅ (Session 44; intersects with text filter; not persisted) |
| KaTeX math rendering | `components/chat/MathBlock.tsx` + `markdown-blocks.ts` math block + inline tokenizer in `MarkdownContent.tsx` | ✅ (Session 44; lazy-loaded; ~85 KB gzip JS + 29 KB CSS + on-demand fonts; false-positive guard for prose dollar amounts) |
| Sidebar thread preview snippets | `components/sidebar/Sidebar.tsx:previewByThread` + `.agnt-sidebar-thread-preview` | ✅ (Session 45; computed once at the top-level Sidebar so streaming deltas don't re-render every row) |
| Composer expand-to-fullscreen | `components/chat/Composer.tsx` (`expandedOpen` overlay) | ✅ (Session 45; second textarea bound to the same `draft`; Cmd/Ctrl+Enter sends + dismisses) |
| Reading / focus mode | `components/workspace/Workspace.tsx` `readingMode` + `agnt-workspace-reading` CSS + `z` shortcut | ✅ (Session 45; hides sidebar + composer; chat scroller caps at 880px for document reading) |
| Sidebar group-by-project | `state/thread-grouping.ts:groupThreadsByProject` + `prefs.sidebar.groupBy` | ✅ (Session 45; cwd-bucketed alongside the existing recency grouping; toggle chip in the sidebar header) |
| Help modal search filter | `components/shared/HelpModal.tsx` (token AND-search) | ✅ (Session 46; filters rows by description + keys; "ctrl k" finds the palette) |
| "New since you were last here" divider | `state/threads-store.ts:arrivalVisitedByThread` + ChatView anchor | ✅ (Session 46; anchored on message id so it stays put while reading) |
| Composer attachment drag-reorder | `components/chat/Composer.tsx` (`reorderAttachments`) | ✅ (Session 46; drag-source semi-transparent + drop-target accent outline) |
| TTS / read-aloud assistant messages | `lib/tts.ts` + `components/chat/rows/AssistantRow.tsx` Speak button | ✅ (Session 46; Web Speech API, no dep; `prepareTextForSpeech` strips code/markdown so the reader hears prose) |
| i18n scaffolding | `lib/i18n.ts` + Settings Language section | 🟡 (Session 37; locale picker, `Intl` date/number helpers, ICU-lite placeholders, English baseline. Non-English dictionaries are placeholders awaiting translation) |
| Global ErrorBoundary | `components/shared/ErrorBoundary.tsx` (wraps `App.tsx`) | ✅ (Session 36; render-time crash surfaces a recoverable card with Try-again + Reload actions; inline-styled to survive CSS corruption) |
| Service-worker cache notice | `public/sw.js` + `src/main.tsx` (postMessage listener) | ✅ (Session 36; new worker activation evicts old caches and posts `agnt-cache-evicted`; main.tsx surfaces "agnt-web updated — Reload to apply" via the existing notices-store) |
| Loading skeletons + empty states | `components/shared/Loading.tsx` (`SidebarSkeleton`, `EmptyState`) | ✅ (Session 35; shimmer rows during sidebar hydration, iOS-y centered empty states for sidebar + chat surfaces using Session 34's icon set) |
| Accessibility baseline | `styles/global.css` (`:focus-visible` + `prefers-reduced-motion`) | ✅ (Session 35; keyboard-only focus rings on every interactive surface; full motion suppression under reduced-motion) |
| First-paint bundle weight | `components/workspace/Workspace.tsx` + `components/chat/ChatHeader.tsx` (React.lazy) | ✅ (Session 35; 12 modal/overlay/panel surfaces code-split out of the initial chunk for a -46 KB raw / -12 KB gzip first-paint reduction; main bundle: 379 KB / 123 KB gzip) |
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
