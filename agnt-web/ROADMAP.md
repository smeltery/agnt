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

## Session 44 — Model pill + Cmd+1..9 + color filter + KaTeX ✅ DONE

- ✅ **Third clean recon pass.** All four claimed gaps verified missing before coding (file-content greps inline in the proposal: `ChatHeader.tsx` for model state, `lib/keyboard.ts` for digit shortcuts, `Sidebar.tsx` for color filtering, `MarkdownContent.tsx`/`markdown-blocks.ts` for math).
- ✅ **Model name pill in ChatHeader.** New `agnt-chat-header-model` chip resolves the model the *next* turn would use (per-thread override → global flag → thread's last-known) and surfaces the source via the hover title. Sits next to the existing provider chip; hides when no model is resolvable.
- ✅ **Cmd / Ctrl + 1..9 thread quick-switch.** Window-level keydown handler in `Sidebar.tsx` jumps to the Nth visible row. Bypasses the typing-target gate (Cmd+digit is unambiguously a global shortcut) and the select-mode gate (power users hopping mid-bulk-flow). Uses `event.code === "DigitN"` so non-QWERTY layouts still work. Documented in HelpModal.
- ✅ **Sidebar color tag filter.** New transient `colorFilter` state — not persisted (lens, not view config). Strip of swatches renders only when threads have color tags; clicking a swatch narrows to that color, clicking again clears. Color filter intersects with text filter so "blue threads matching 'auth'" works. Hidden swatches drop out when no thread under the current tab has that color so the user can't zero out the list.
- ✅ **KaTeX math rendering.** Block math `$$ … $$` (own-line fences) parsed in `markdown-blocks.ts`; inline `$ … $` and `$$ … $$` (mid-line) tokenized in `MarkdownContent.tsx`. False-positive guard: inline `$…$` requires a math-like character (`\^_{}` ) in the body so prose like `$5 and $10` stays untouched. Lazy-loaded same as Mermaid (~85 KB gzip JS + 29 KB CSS + on-demand fonts). Strict mode + `throwOnError: false` so a malformed formula renders inline-red rather than crashing the row.
- 6 new vitest cases (block-math lexing: capture / multi-line / mid-paragraph rejection / dollar-amount false-positive guard / unterminated-block fallback / paragraph ordering). 507 / 507 pass; tsc clean; main bundle 409 → 411 KB raw, 131.98 → 132.67 KB gzip.

## Session 43 — Sound cue + high-contrast + starter prompts + mermaid ✅ DONE

- ✅ **Second clean recon pass.** All four claimed gaps verified missing before coding (file-content grep against `Notifications` / `MarkdownContent.tsx` / `NewChatModal.tsx` / `playSound|new Audio|prefers-contrast`). Continuing the discipline that finally landed in Session 42.
- ✅ **Sound cue on turn complete.** New `lib/sound-cue.ts` synthesizes two-tone WebAudio beeps (major-third for completed, minor-second for failed) — no audio asset shipped. Off by default (`prefs.soundVolume` defaults to 0); Settings → Notifications → "Sound cue on turn complete" slider. Cue fires independently of desktop notification permission so unmuted-tab users still get the audible signal. Per-thread mute already gates both.
- ✅ **High-contrast theme variant.** New `state/contrast-store.ts` orthogonal to theme — light + high-contrast and dark + high-contrast both work. Follows `prefers-contrast: more` system query when no explicit pick; toggle in Settings → Appearance. CSS layered via `:root[data-contrast="high"]` overrides bumping border weight to 2px, dimming-text → full text, and focus-ring outline to 3px.
- ✅ **NewChatModal starter prompts.** 5 quick-start chips (Explain the codebase / Review my changes / Write tests / Find a bug / Refactor a function) that drop a tested prompt into the textarea. Chips only render when the textarea is empty so they don't get in the way of typing.
- ✅ **Mermaid diagrams.** `mermaid` v11 added as a dep, lazy-loaded via React.lazy + dynamic import so the main bundle stays unchanged. New `MermaidBlock` renders `\`\`\`mermaid` fences as SVG via `mermaid.render` with `securityLevel: "strict"` (assistant-authored source isn't trusted to inject HTML). Errors surface a red panel with the source preserved. **Bundle cost honesty**: my pre-install estimate was ~150 KB gzip. Reality is ~400 KB gzip across `mermaid.core` + `cytoscape` + `wardley` deps — only loads when a diagram fence appears, but it's heavier than I initially claimed.
- 3 new vitest cases (sound cue: silent at volume 0, distinguishable tone shapes for completed / failed). 501 / 501 pass; tsc clean; main bundle 406 → 409 KB raw, 131.07 → 131.98 KB gzip.

## Session 42 — Relative timestamps + Sheet focus trap + PWA manifest + Lightbox zoom ✅ DONE

- ✅ **First clean recon pass.** All four claimed gaps verified missing before coding (sharper grep this time, against actual file contents not just symbol names): no manifest in `public/`, no `beforeinstallprompt` handler, no `formatRelative` / `timeAgo` in `lib/state`, no `focus`/`tabIndex` in `Sheet.tsx`, no `scale`/`wheel`/`pointermove` in `Lightbox.tsx`. Five sessions of recon misses ended with this one — the discipline of grepping the containing file, not just symbol names, paid off.
- ✅ **Relative timestamps.** New `lib/relative-time.ts` with `formatRelativeTime` (locale-aware via `Intl.RelativeTimeFormat`, falls back to absolute past 1 week with year-cross-over) and `formatRelativeWithAbsolute` (combines both for hover tooltips). Replaced 8 chat-row `toLocaleString()` tooltip callsites: AssistantRow, UserRow, ReasoningRow, FileChangeRow, CommandExecutionRow, ToolActivityRow, PlanRow, SystemErrorRow.
- ✅ **Sheet focus trap.** `Sheet.tsx` now intercepts Tab / Shift+Tab to wrap focus inside the dialog (was previously bleeding into the underlying chat), focuses the first focusable element on open, and restores focus to the trigger element on close. Standard focusable-selector list, falls back to focusing the sheet container when there's nothing else focusable inside.
- ✅ **PWA manifest + install prompt.** New `public/manifest.webmanifest` (standalone display, themed colors matching the app shell) + minimal SVG app icon (maskable-safe with the meaningful glyph in the inner 80% safe zone). New `state/install-prompt-store.ts` captures `beforeinstallprompt` from `App.tsx` and exposes a `promptInstall()` action; new Settings → Install section surfaces the button, hides itself in standalone mode, and respects the "appinstalled" lifecycle event.
- ✅ **Lightbox zoom + pan.** Wheel zoom anchored on the cursor (the pixel under the cursor stays put as scale changes — same behavior as native viewers), double-click toggles 1× ↔ 2.5× at the click point, click-drag pans when zoomed in, `0` / Escape reset, sibling-nav buttons hide when zoomed (so a casual click after panning doesn't accidentally cycle). State resets on image change so switching siblings while zoomed doesn't strand the viewer on a random region.
- 9 new vitest cases (relative-time floor / unit transitions / fall-back-to-absolute / year-cross-over). 498 / 498 pass; tsc clean; main bundle 404 → 406 KB raw, 130.09 → 131.07 KB gzip.

## Session 41 — Code-block line numbers + per-thread mute + side-by-side diff (with another recon miss) ✅ DONE

- 🟡 **Recon miss (third in two sessions).** I claimed bulk thread operations were missing this session, even with explicit grep evidence (`multiSelect|bulkArchive|selectedThreadIds`). All three terms turned out to be wrong-name guesses; the actual implementation in `Sidebar.tsx` uses `selectMode` / `selectedIds` / `archiveSelected` / `unarchiveSelected` / `exportSelected` and has a full bulk-action bar at line 218. Caught it before writing any new code. Lesson sharpened: name-based grep alone isn't enough — for any "missing from sidebar/composer/header" claim, also grep the file itself for whatever bar/toolbar/mode state already exists. Updated answer pattern: cite a grep that hits the *actual containing component file*, not just generic symbol names.
- ✅ **Code-block line numbers.** Per-block toggle (the `#` button next to Copy / Lang). Renders an aside `<span>` gutter alongside the existing `dangerouslySetInnerHTML` code; line-height is locked to a CSS custom prop so a 200-line block doesn't drift toward the bottom. Toggle is hidden on single-line blocks (toggling a one-liner adds noise without value).
- ✅ **Per-thread notification mute.** New `prefs.mutedThreadIds` schema + `mutedThreadIds: Set<string>` in `threads-store` + `setThreadMuted(threadId, muted)` action. Mute check layers on top of the global `shouldNotify()` gate — a muted thread skips desktop alerts even when global notifications are on. Toggle exposed via `ThreadContextMenu` ("Mute notifications" / "Unmute notifications").
- ✅ **Side-by-side diff view.** New `lib/diff-split.ts` with `parseUnifiedDiff` (typed line tokens with left/right line numbers tracked off `@@` hunks) + `splitUnifiedDiff` (zips remove/add runs into 1:1 pairs, pads the shorter side, repeats context on both sides). FileChangeRow gains a Split / Unified toggle on the actions row; renders a 2-column grid of `[gutter, text]` cells with per-kind background tints matching the unified view's palette.
- 18 new vitest cases (parser hunk / context / remove / add tracking + splitter zip + pad behavior). 489 / 489 pass; tsc clean; main bundle 400 → 404 KB raw, 129.06 → 130.09 KB gzip.

## Session 40 — Branch pill + search filters + code-block language pill (with a recon miss) ✅ DONE

- 🟡 **Recon miss (again).** I proposed per-thread draft auto-save as a missing feature this session. It turned out to **already be fully shipped** in `storage/drafts-store.ts` + Composer wiring. Same shape as Session 38's AI Change Sets miss and Session 39's three-out-of-four miss. I added a parallel `prefs.draftsByThread` schema before catching the existing implementation; reverted both the prefs-store + state/drafts-store additions before they shipped. The persistent root cause: I'm proposing follow-ups based on intuition rather than always grepping the codebase first. Target for future sessions: every "missing feature" claim must be backed by a grep result in the response.
- ✅ **Branch indicator pill in ChatHeader.** New pill subscribes to `git-store.byThread[threadId].currentBranch`, shows the branch label with a `•` marker when the working tree is dirty, and click-opens the existing GitPanel. Lazy first-fetch via `refreshStatus` only when the cache is empty so we don't spam status RPCs on every thread selection.
- ✅ **Search filter chips in CommandPalette.** New `lib/search-filter.ts` predicate (role / date-window / model, AND-combined) with `defaultFilters` / `isFilterDefault` sentinels. Palette gains a segmented-control row for role (any/you/agent) + date (any/24h/7d/30d), a `<select>` for model (only when the bridge has registered >1), and a Reset button when any filter is non-default. Filters-active mode skips the empty-query short-circuit so users can browse "all my user messages from the last 24h" without typing anything.
- ✅ **Code-block language pill.** The Markdown renderer was already setting `language-…` className for Prism but never showing the language to users. Added a top-left pill mirroring the existing top-right Copy button; canonical language id (so users see "typescript" not "ts" when those alias).
- 16 new vitest cases (filter predicate covering role / date / model axes + AND-combination). 479 / 479 pass; tsc clean; main bundle 399 → 400 KB raw, 128.86 → 129.06 KB gzip (negligible).

## Session 39 — AI commit drafts + slash arg hints + retry-with-model + mobile sweep ✅ DONE

- ✅ **Recon discipline.** Started this session by auditing actual gaps before promising features — Sessions 37 and 38 each shipped one "deliverable" that turned out to already exist (per-message revert was bridge-blocked, then turned out it wasn't; desktop notifications / markdown export / git commit-push-stash all turned out to already be wired). Confirmed before coding that AI-drafted commit messages, slash-arg hints, retry-with-model, and the bulk of the mobile sweep were genuinely missing.
- ✅ **AI-drafted commit messages.** Bridge already shipped `git/generateCommitMessage` (Codex-only, structured-JSON via `runStructuredCodexJsonImpl`). Wired through `git-store.generateCommitMessage` and surfaced as a "Draft" button in `GitPanel`'s commit row. The Codex-only error path surfaces a polite message via the existing `setError` channel rather than gating the button on a stale provider snapshot.
- ✅ **Slash-command argument hints.** Extended `lib/slash-variables.ts` with positional `{1}`/`{2}` placeholders + Claude-Code-style `$ARGUMENTS`. New `parseSlashArgs` handles quoted runs (`/cmd "two words" arg2`); new `describeBodyArgs` introspects bodies so the slash menu can render an argv-shape hint like `/release-notes <1> <2> <args…>` next to the command name. The composer's slash detector now allows whitespace after the trigger (was previously dismissed at the first space) so users can type args inline.
- ✅ **Retry with a different model.** New `options.modelOverride` on `threads-store.retryFailedTurn` wins over the per-thread / global flags for one retry without disturbing defaults. `SystemErrorRow` gains a "Retry with…" picker (only renders when >1 model is registered). Useful when one model flakes mid-turn and the same prompt succeeds on a different one.
- ✅ **Mobile responsive sweep.** New `@media (max-width: 600px)` rules: dialog modals get viewport-fit + internal scrollable body (was overflowing on narrow phones), footer buttons stack instead of wrapping, row-action chips bump to 32px min-height for thumb-friendly targets, ChatHeader pills become a horizontal scroll strip instead of a 3-row stack that ate the chat column, composer actions wrap. Existing 768px sidebar-drawer breakpoint stays in place.
- 19 new vitest cases (slash-arg parser + expander + body-arg description). 466 / 466 pass; tsc clean; main bundle 397 → 399 KB raw, 128 → 129 KB gzip.

## Session 38 — Token visibility + AI Change Sets (full) + i18n migration + render-cost trim ✅ DONE

- ✅ **Token / cost visibility per turn.** New `lib/token-usage.ts` extractor + `state/turn-token-usage-store.ts` capture the bridge's existing `thread/tokenUsage/updated` notification (already plumbed for the context pill but not surfaced per-turn). Assistant rows now show a "1.2k tokens · $0.018" chip next to the duration with a hover breakdown of input / output / cached / cost. Codex / opencode that don't surface `total_cost_usd` show only the token count.
- ✅ **AI Change Sets (full per-file revert).** **The bridge already exposed `workspace/revertPatchPreview` + `workspace/revertPatchApply`** — Session 37's "bridge-blocked" framing was wrong. New `protocol/workspace-checkpoints.ts` helpers wrap both RPCs; `FileChangeRow` now renders a "Revert this change" button when expanded, runs preview first to surface conflicts / staged-files / unsupported reasons, and on apply calls `git apply -R` via the bridge. Same safety checks as the per-turn checkpoint flow.
- ✅ **i18n migration (first pass).** Migrated ~12 high-traffic visible strings through `t()`: sidebar new-chat / search / 3 empty-states; settings title + 5 section headers + locale hint. Confirms the wiring works end-to-end — translators can fill the dictionaries without code edits. Non-English dictionaries remain placeholders.
- ✅ **Render-cost trim.** AssistantRow's per-turn-changes selector was subscribing to the entire messages array (so every reducer mutation in the thread re-fired every assistant row's selector). Replaced with a targeted selector that aggregates by turnId before returning + a custom equality comparator so re-renders only fire when the chip would actually change. Pairs with the existing `content-visibility: auto` and memoized `MessageRow` to keep long threads (200+ messages) responsive without a DOM-virtualization library.
- 13 new vitest cases (token-usage extractor + formatters). 452 / 452 pass; tsc clean; main bundle 391 → 397 KB raw, 126 → 128 KB gzip.

## Session 37 — Search depth + per-thread overrides + AI change sets (lite) + i18n scaffolding ✅ DONE

- ✅ **Search depth.** New `lib/fuzzy-match.ts` adds an LCS-style subsequence matcher with prefix / word-start / consecutive-run scoring; `CommandPalette` now falls back to fuzzy when a substring match misses, so a partial recall (`fobar` → `foobar`) still surfaces hits. Recent-searches MRU layered on top of Session 36's saved searches via new `prefs.recentSearches` (cap 8, `Clear` action). Sidebar rows gain a `title=` tooltip carrying the full title + cwd so truncated names are inspectable on hover.
- ✅ **Per-thread overrides.** New `prefs.threadOverrides` schema + `threads-store.setThreadOverride` lets a thread pin its own system prompt + model + reasoning effort. Wired into `sendTurn` and `retryFailedTurn`: per-thread values take precedence over the global `TurnFlagBar` picks; a non-empty `systemPrompt` is prepended to the first text item via `prependSystemPrompt`. New `ThreadOverridesSheet` opens from the sidebar context menu; empty fields are pruned on save so the persisted blob stays small.
- ✅ **AI Change Sets (lite).** New per-turn changes chip on completed `AssistantRow`s: aggregates the `fileChange` reducer entries that share the same `turnId`, surfaces "N files +X −Y" using the Session 30 diff-stats helpers, and on click scrolls the chat to the first matching FileChange row. Closes the discoverability gap; **true per-message revert remains bridge-blocked** (the bridge doesn't expose forward patches per assistant message yet) and is documented as such.
- ✅ **i18n scaffolding.** New `lib/i18n.ts` with: typed locale ids (`en`/`es`/`fr`/`de`/`ja`), per-locale dictionaries with English fallback, ICU-lite `{name}` placeholder interpolation, `Intl.DateTimeFormat` + `Intl.NumberFormat` helpers that follow the active locale. Locale picker in Settings persists to `prefs.locale` and seeds from `navigator.language` on first load. **Note**: this session ships only the scaffolding + the English baseline; non-English dictionaries are placeholders for translators / future sessions to fill.
- 13 new vitest cases (9 fuzzy-match + 6 i18n + 4 thread-overrides + helpers). 439 / 439 pass; tsc clean; main bundle 379 → 392 KB / 124 → 126 KB gzip (small growth from the new fuzzy helper + per-thread + i18n; CommandPalette chunk grew 1.2 KB for the recent-searches list).

## Session 36 — Onboarding refresh + power-user keyboard + robustness + visual completion ✅ DONE

- ✅ **Onboarding visual refresh.** Pairing screen now uses iOS display type (34px / 700, -0.03em tracking), an iOS `UISegmentedControl`-style tab strip (filled background, equal segments, active pill with elevation shadow), and `tertiarySystemFill` inputs with the focus-ring conventions from Sessions 33 + 35. The QR scanner trades its dashed full-rect outline for four iOS-style **corner brackets** drawn via gradient backgrounds — no extra DOM, no extra deps. Manual-code form + paste form share the same input treatment.
- ✅ **Multi-window thread links.** ⌘/Ctrl-click and middle-click on a sidebar row now open that thread in a new tab via the existing hash deep-link route — power users can keep a long-running thread visible while exploring others. Plain click still navigates in-place.
- ✅ **Saved searches in the CommandPalette.** `Save` button persists the current query to `prefs.savedSearches` (capped at 8); chips appear above the hits list; click a chip to apply, click the × to forget. Round-trips through `prefsStore.{loadSavedSearches,saveSavedSearches}`.
- ✅ **Global ErrorBoundary.** New `components/shared/ErrorBoundary.tsx` wraps the entire React tree in `App.tsx`. A render-time crash now surfaces a recoverable card (with the iOS palette tokens, inline-styled so the boundary is robust against CSS corruption) instead of blanking the page. Includes "Try again" + "Reload" actions and the error message. All console.error logs preserved for diagnostic export.
- ✅ **Service-worker cache eviction notice.** SW cache bumped to `agnt-web-v3`; on activation the worker now `postMessage`s an `agnt-cache-evicted` event to every connected client. `main.tsx` listens and surfaces a soft `system/notice` via `notices-store` ("agnt-web updated — Reload to apply"), so users running the app for hours don't keep serving a stale build.
- ✅ **Finish iOS look pass.** `StatusPill` swapped from outlined to tinted iOS pill with semantic dot indicator (green=ok / blue=info / orange=warn / red=error). `HelpModal` and `CommandPalette` both migrated to `Sheet` — Help is a comfortable bottom-sheet, palette uses the same sheet treatment so it sits visually consistent with New Chat / Project Picker. `ReconnectBanner` retuned to use `color-mix` tint over the current background. `ThreadSearchBar` now matches the sidebar search field's iOS look (tertiarySystemFill, 14px corner, focus shadow, no hard border).
- 7 new vitest cases (3 ErrorBoundary + 4 saved-searches). 418 / 418 pass; tsc clean; main bundle 379 → 382 KB raw / 124 → 124 KB gzip (essentially flat — the new code is mostly CSS + small components).

## Session 35 — Sheet rollout + accessibility + bundle audit + skeletons ✅ DONE

- ✅ **Finished sheet rollout.** `Sheet` gained two new props: `presentation: "sheet" | "alert"` (alert mode is centered + fades in, no grabber, no slide-up) and `closable: boolean` (when false, drag + backdrop click are disabled — Esc still fires `onClose` as a baseline accessibility expectation). `ApprovalModal` and `RevertSheet` migrated to alert mode with `closable={false}` so a stray drag can't accidentally decline a command or cancel a revert mid-stream. `StructuredInputModal` migrated to default sheet mode (drag-to-dismiss = cancel the input).
- ✅ **Accessibility floor.** Global `:focus-visible` outline (2px accent, 2px offset) on every interactive surface, scoped via `:where()` so component-specific focus styles still win when they want to. Composer + sidebar-search + settings inputs suppress the global ring in favor of their existing focus shadow. Full `prefers-reduced-motion` respect: animations + transitions + smooth-scroll all collapse to instant when the user opts in. ARIA audit on icon-only buttons confirmed coverage from Sessions 31 + 34 — the few that lacked labels are now labelled.
- ✅ **Bundle + lazy-load audit.** `Workspace` and `ChatHeader` now dynamic-`import` 12 surfaces that don't belong in first paint: `ApprovalModal`, `NewChatModal`, `RevertSheet`, `ProjectPicker`, `AboutModal`, `SettingsModal`, `CommandPalette`, `HelpModal`, `Lightbox`, `StructuredInputModal`, `FileBrowser`, `GitPanel`. Each shares a Suspense boundary with a `null` fallback so chunk-fetch latency never paints a flashing placeholder. **Main bundle: 425 KB / 135 KB gzip → 379 KB / 123 KB gzip** (-46 KB raw, -12 KB gzip on first paint). Heaviest chunked surface is `SettingsModal` at 17 KB / 5.5 KB gzip — only loaded when the user opens Settings.
- ✅ **Loading + empty-state polish.** New `components/shared/Loading.tsx` exposes `SidebarSkeleton` (shimmer rows that fill the sidebar while `thread/list` is in flight) and `EmptyState` (centered icon + heading + body, used for sidebar and chat empty surfaces). The shimmer animation uses a moving linear-gradient (cheap, no JS), and respects `prefers-reduced-motion` via the global rule above. Sidebar empty/search-no-match states + chat "no thread selected" / "no messages yet" / "no starred matches" all use the new component with iOS-y icons from the Session 34 set.
- 11 new vitest cases (5 sheet-presentation + 5 loading primitives + 1 helper). 411 / 411 pass; tsc clean.

## Session 34 — SF-Symbols-style icons + iOS sheet presentation ✅ DONE

- ✅ **Hand-traced SVG icon set.** New `components/shared/Icon.tsx` ships 25 icons that approximate the SF Symbols agnt uses on iOS — `ChevronRight`/`ChevronDown`/`ChevronUp`/`ChevronLeft`, `Xmark`, `Ellipsis`, `MagnifyingGlass`, `Plus`, `ArrowDown`, `ArrowClockwise`, `ArrowUturnLeft`, `ArrowshapeTurnUpLeft`, `Clock`, `ClockArrowCirclepath`, `Eye`, `EyeSlash`, `Star`, `StarFill`, `PinFill`, `Link`, `Paperclip`, `Mic`, `Line3Horizontal`, `Line3HorizontalDecrease`, `Trash`. Each is a 16×16 viewBox using `currentColor` so theme + provider tints apply automatically; line icons share `BASE_STROKE_PROPS` (1.5px stroke, round caps + joins) for a consistent weight.
- ✅ **Glyph replacement across chrome.** Unicode glyphs `★`, `☆`, `⏱`, `⤴`, `↶`, `🔗`, `📎`, `👁`, `↺`, `☰`, `≡`, `⋯`, `▾`, `▸`, `×` are now SVG icons in `AssistantRow`, `BookmarkButton`, `RowLinkButton`, `Composer`, `Sidebar`, `ThreadContextMenu`, `GitPanel`, `DiffView`, `SettingsModal`, `Workspace`, and `UndoToast`. Keeps the visual language consistent with the iOS app's SF Symbols treatment without shipping the proprietary font.
- ✅ **iOS-style sheet presentation.** New `components/shared/Sheet.tsx` replaces the centered-modal pattern for sheets that benefit from a "tray" affordance — currently `NewChatModal` and `ProjectPicker`. The sheet anchors to the bottom of the viewport, slides up on mount via a 280ms cubic-bezier transition, and exposes a small grabber handle at the top. On wide viewports (≥768px) it floats centered with side margins instead of edge-pinned, mirroring iOS's `formSheet` presentation.
- ✅ **Drag-to-dismiss.** New `lib/sheet-drag.ts` owns the pure gesture math (clamping, distance + velocity thresholds), kept separate from React so the dismiss rules are unit-testable. Pointer events drive the gesture (covers touch + mouse + pen). A drag commits when translation passes 120px OR release velocity exceeds 600 px/s in the trailing 120ms — i.e. a flick dismisses even on a short pull. The backdrop dim eases out as the user pulls, so the sheet "uncovers" the page just like iOS.
- 11 new vitest cases (5 sheet-drag + 4 icon set + 2 helpers). 401 / 401 pass; tsc + vite build clean (431 KB / 137 KB gzip JS, 58 KB CSS).
- 🟡 Still out of scope: SF Symbols proprietary font (legal), haptics, swipe-from-edge gestures, full presentation transition curves matching UIKit (CSS cubic-bezier is close, not pixel-identical).

## Session 33 — Visual fidelity pass: align web styling with AgntMobile ✅ DONE

- ✅ **iOS UIKit semantic colors.** The `:root` palette now mirrors `systemBackground` / `secondarySystemBackground` / `tertiarySystemFill` / `label` / `secondaryLabel` / `separator` / `systemBlue` / `systemRed` / `systemOrange` / `systemGreen` for both light and dark — same hex values UIKit ships. Adds a `--agnt-fg-tertiary` for placeholder / inactive text matching `placeholderText`. The legacy `--agnt-radius` variable is kept as an alias so older rules still compile.
- ✅ **iOS radius scale.** New `--agnt-radius-bubble` (22), `--agnt-radius-sheet` (18), `--agnt-radius-control` (14), `--agnt-radius-card` (12), `--agnt-radius-small` (8) match the iOS `RoundedRectangle(cornerRadius: N, style: .continuous)` values pulled from the AgntMobile views audit.
- ✅ **iOS typography.** Font stack is now SF Pro Text first, falling through Segoe UI / Roboto / Helvetica Neue. Body bumps from 14px to 15px to match the iOS body type; chat header titles render at 17px semibold with -0.02em letter-spacing; `font-smoothing: antialiased` mirrors the system rendering.
- ✅ **User chat bubble.** Right-aligned, 22px continuous corner, `tertiarySystemFill` background, 12 / 16 padding — visually equivalent to `Views/Home/...` in AgntMobile. Assistant rows render as flowing prose with no bubble (matching iOS), so role distinction comes from layout instead of color.
- ✅ **Composer + circular send.** Composer textarea uses 18px sheet radius on the tertiary fill; the send button is now a 36×36 filled circle (accent bg + white fg), and the stop button is a pill-style danger button — same shapes as the AgntMobile composer's `borderedProminent` controls.
- ✅ **Buttons + sidebar search field.** `.agnt-button-primary` swaps to a borderless 14px-radius accent fill, `.agnt-button-ghost` becomes a tertiary-fill rounded pill (no visible 1px border), and the sidebar search field rounds to 14px on `tertiarySystemFill` with a tertiary-label placeholder — same shape as `Views/Sidebar/SidebarSearchField.swift`.
- ✅ **Modal sheets + Settings cards.** Modals use the iOS sheet radius (18px), no border, and a tinted backdrop with a small backdrop-filter blur. Each Settings section now renders as its own `secondarySystemBackground` card (12px radius), matching the iOS Settings stack visually instead of the prior border-stack layout.
- ✅ **Pills + tags.** `.agnt-row-tag` becomes a small pill (10px caption, 8 / 2 padding, 999px radius) sitting on the tertiary fill — matches iOS caption2 metadata badges.
- 0 net code-behavior changes; CSS-only retune. 390 / 390 vitest pass; tsc + vite build clean (425 KB / 135 KB gzip JS, 57 KB CSS).
- 🟡 Out of scope this session: SF Symbols replacement (we still use unicode glyphs), haptics, swipe gestures, true `.continuous` corner curves (CSS `border-radius` is close but not pixel-identical), iOS sheet drag-handle. The result reads as "iOS-styled web", not pixel-cloned to the iOS app.

## Session 32 — Quality bundle: virtualization + undo + word-level diff + diagnostic export + webhook ✅ DONE

- ✅ **Performance.** Long-thread chat now uses CSS `content-visibility: auto` (with `contain-intrinsic-size: auto 120px`) on each row wrapper — browser-native virtualization, zero JS overhead, no library. Off-screen rows skip layout + paint entirely; the intrinsic-size hint keeps scroll height stable. `MessageRow` is wrapped in `React.memo` so a parent re-render (composer keystroke, throughput-pill tick) no longer cascades through every row — the reducer mutates message references, so referential equality on `message` is the right gate.
- ✅ **Undo for destructive actions.** New `state/undo-store.ts` is a single-slot publish-and-perform pub/sub: archive / unarchive / rename now publish a labelled reverse callback, and `components/shared/UndoToast.tsx` surfaces it bottom-center with an Undo button. Auto-dismisses at 5s; a second action replaces the slot (the older window has effectively "ended" once the user does something new). Reverse callback failures are swallowed so a flaky bridge can't crash the UI.
- ✅ **Word-level intra-line diff.** New `lib/diff-word-tokens.ts` tokenizes `-` / `+` line pairs into words / whitespace / punctuation tokens, runs an LCS pass, and tags each token `same` / `removed` / `added`. `DiffView` renders the per-token classes so a one-character rename inside a long line shows up as a tight highlight instead of the whole line painting red+green. Unbalanced runs (e.g. one removal, two additions) are skipped — proper alignment would need a full Myers' diff and most hunks are 1:1 swaps.
- ✅ **Per-file `Copy patch` button** in `GitPanel`. Copies just that file's slice of the unified patch — paste into `git apply`, a PR comment, or a chat message without grepping the full working-tree diff.
- ✅ **Diagnostic report export.** New `lib/diagnostic-report.ts` builds a JSON snapshot covering connection state, latency stats (count / median / p95), recent notice titles + severities, IDB key counts grouped by prefix, and browser info. **Privacy-first:** thread contents and identity-private bits are excluded by design; pairing identifiers (`sessionId` / `macDeviceId`) and persisted thread ids are routed through a 12-hex `shortHash` so the report is correlation-safe but not directly impersonation-useful. New "Diagnostic report" Settings section exposes the export.
- ✅ **Turn-completion webhook.** New `lib/turn-webhook.ts` fires a fire-and-forget POST when `turn/completed` or `turn/failed` lands. Configurable URL + master enable switch persisted via `prefsStore.{loadSaveTurnWebhook}`. URL is validated to `http(s)://`; non-https schemes (`javascript:`, `file:`) are refused. Payload includes outcome + threadId + turnId + ISO timestamp + optional error text — explicitly **no message text**, since shipping model output to a third-party URL would be a data leak. Network failures are swallowed (`console.warn`) so a flaky URL doesn't spam toasts on every turn.
- 33 new vitest cases (6 diff-word-tokens + 7 undo-store + 9 diagnostic-report + 5 turn-webhook + helpers). 390 / 390 pass; tsc + vite build clean (425 KB / 135 KB gzip main bundle).

## Session 31 — Polish bundle: thread + chat + reliability + git + composer + settings ✅ DONE

- ✅ **Thread + chat polish.** Inline rename — double-click any sidebar row's title to swap into an input; Enter commits via `renameThread`, Esc/blur reverts. **Duplicate thread** — context-menu entry hands the source thread's `cwd` and first user prompt to `state/new-chat-prefill-store.ts`, which `Workspace` consumes to open the New Chat modal pre-filled (the user reviews before sending — this is "clone the starting state", not "send the same turn"). **Vim-style `gg`/`G` jump-to-top/bottom** — double-press `g` within 600ms scrolls the chat to the top; bare `G` jumps to the latest. **Provider color badge** — `ChatHeader` maps `thread.modelProvider` to a stable slug (`codex` / `claude` / `opencode` / `cursor` / `other`) so `.agnt-provider-<slug>` CSS rules tint the existing tag. Both light + dark themes covered.
- ✅ **Reliability.** **Slow-response toast** — new `state/slow-response-watcher.ts` arms a 15-second per-turn watchdog on `turn/started` and cancels on `turn/completed`/`turn/failed`. If the timer fires, an info notice ("Still working… 15s without output") surfaces via `notices-store`. Bounded by the cancel hook so retries replace cleanly. **Disconnect-saved-drafts toast** — `connection-store` now tracks the previous status kind at module scope and emits a one-shot warn notice on `open → (closed|error)` ("Your in-progress drafts are saved locally. Reconnect to keep going."). Drafts already debounce-persist to IndexedDB (Session 19); the toast is the visible signal that the local backup exists.
- ✅ **Git polish.** New `Stash` and `Stash pop` quick buttons in `GitPanel` wired to existing bridge RPCs (`git/stash`, `git/stashPop`). Stash is gated on a dirty tree; Stash pop is gated on a clean tree (so a pop can't conflict with uncommitted changes). **`DiffView` per-hunk collapse** — new `lib/diff-hunk-grouper.ts` partitions a unified-diff string into a meta block + one entry per `@@ … @@` hunk; each hunk header is now a click/keyboard toggle that hides its body, with a `+N −M` summary chip while collapsed. The grouper requires the trailing space on `@@ ` (matching the Session-30 `git-diff-stats` fix) so a content line starting with `@@` isn't misclassified.
- ✅ **Composer + Settings power-user.** **Markdown live-preview** — toggle button in the actions row splits the textarea into a side-by-side preview rendered through `MarkdownContent`; collapses to a stacked layout below 768px. **Prompt history dropdown** — new ↺ button reveals the active thread's recent user prompts (newest-first, capped at 25); clicking drops the full text into the draft and parks the caret at the end. Older prompts stay reachable via the existing ↑ recall (Session 16). **Settings search filter** — new search input in the Settings modal header filters sections by keyword tags (Appearance / Notifications / Connection / Account / Custom slash commands / Backup / Trusted Macs).
- 14 new vitest cases (4 diff-hunk-grouper + 5 slow-response-watcher + 4 new-chat-prefill + 1 helper). 357 / 357 pass; tsc + vite build clean (415 KB / 132 KB gzip main bundle).

## Session 30 — Sidebar density + per-turn timing + diff stats + image lightbox + state backup ✅ DONE

- ✅ Collapsible sidebar recency groups + density toggle. Pinned / Today / Yesterday / This week / Earlier (and the single Archived group) get a clickable header with a chevron + thread count; collapse state persists per-group via `prefsStore.saveSidebar({ collapsedGroups })`. The j/k keyboard navigator skips threads inside collapsed groups so muscle-memory doesn't jump into a section the user has hidden. New `density` toggle (☰/≡) in the sidebar header swaps padding + font-size between `comfortable` (default) and `compact` for users who keep dozens of threads in view; persists across reloads.
- ✅ Per-turn timing chip on completed assistant rows. New `state/turn-timing-store.ts` records `startedAtMs` on `turn/started` and `endedAtMs` on `turn/completed`/`turn/failed`, indexed by turnId with a per-thread retention cap of 200 entries. `AssistantRow` shows a `⏱ N.Ns` chip in the actions slot — labels round to ms below 1s, one decimal below 10s, whole seconds up to 60s, and `Mm SSs` beyond. Memory-only by design: durations are a session artifact, not historical data the bridge persists.
- ✅ `GitPanel` diff stats. Uses the bridge's `git/status.diffTotals` for the thread-total chip in the header (no extra round-trip), and falls back to summing client-side per-file stats from new `lib/git-diff-stats.ts` when the bridge omits them. Each dirty-file row now carries an inline `+N −M` chip — populated lazily from the unified patch the panel already fetches on first expand. Pure helpers (`computeDiffStats`, `sumDiffStats`, `formatDiffStats`) live alongside `git-diff-parser.ts`.
- ✅ Workspace-image lightbox. Both kinds of inline images in `MarkdownContent` (direct `https://`/`data:` URLs and the `workspace/readImage`-resolved relative paths) now route a click through to the existing Lightbox — no new overlay component, just a one-line wire-up that reuses Session 15's full-window viewer + Session 16's keyboard-driven sibling cycling. Closes the deferred `WorkspaceImages` viewer item from the roadmap.
- ✅ State backup / restore. New `lib/state-backup.ts` enumerates IndexedDB via a new `idb.keys()` helper and exports the `prefs.*` + `messages:*` keys as a versioned JSON file (`schemaVersion: 1`). Identity (`phoneIdentity`) and pairing state (`relayPairing`, `trustedMacRegistry`) are excluded by an explicit hard-blocklist plus prefix allowlist — re-pair the bridge in a fresh browser instead. New "Backup & restore" Settings section exposes Export + Import; importing overwrites matching keys and prompts a reload to surface the restored UI.
- 25 new vitest cases (10 turn-timing-store + 10 state-backup + 5 git-diff-stats). 343 / 343 pass; tsc + vite build clean (408 KB / 130 KB gzip main bundle).

## Session 29 — Workspace file browser + per-thread color tag + connection latency ✅ DONE

- ✅ Workspace file browser side-panel. New "Files" toggle in the chat header (next to "Git") opens a tree-view rooted at the active thread's `cwd` via existing `project/listDirectory` RPC. Children are lazy-fetched + cached on first expand; clicking a file inserts an `@cwd-relative-path` mention into the composer through Session 27's inbox so it stacks with the existing mention picker. Disabled when no `cwd` is set; manual Refresh button re-fetches the active directory.
- ✅ Per-thread color tag. New 6-color palette (red/orange/yellow/green/blue/purple) selectable from the sidebar context menu, persisted to IndexedDB via `prefs.threadColors`. Sidebar rows render a 3 px colored bar; chat header gets a small colored dot next to the title. Pure visual organization layer atop pin/recency.
- ✅ Connection latency indicator in `StatusPill`. New `state/latency-store.ts` keeps a 16-sample rolling window; `JsonRpcClient` was extended with an `onLatencySample` observer fed by `connection-store`. Status pill shows the median ("12ms" / "210ms") with color tiers (`<100` ok, `<500` warn, `>=500` slow); hides while idle or older than 30s. Full tooltip exposes the source ("median of recent RPCs").
- 17 new vitest cases (latency rolling window + median + classify, color palette persistence). 318 / 318 pass; tsc + vite build clean (401 KB / 127 KB gzip main bundle).

## Session 28 — Chat nav shortcuts + URL hash deep-linking + approvals batch actions ✅ DONE

- ✅ `[` / `]` jump between user messages in the active thread. Anchor index is whichever user row is closest to the viewport mid-line, so successive presses make progress even after the user scrolls. Uses the existing scroll-into-view + brief highlight ring (Session 15). Bare keys, gated by `skipWhenTyping` so the shortcuts don't fire from inside a draft. HelpModal updated.
- ✅ URL hash deep-linking + per-row "Copy link". `#thread/<id>` selects on boot; `#thread/<id>/message/<id>` additionally scrolls the message into view via a one-slot `chat-focus-store` (waits for the matching reducer state to hydrate before scrolling). Active thread changes write back via `history.replaceState` so reload restores the view without polluting back-button history. New `🔗` button on assistant + user rows copies a `${origin}${pathname}#thread/<id>/message/<id>` permalink.
- ✅ Approvals "Accept all" / "Decline all" of the same kind. New `decideAllOfKind` in `state/approvals-store.ts` resolves every queued approval whose `kind` matches with one decision; the modal exposes Accept-all / Decline-all only when more than one approval of the head's kind is queued, scoped to that kind so a queued `git push` can't ride along with a batch `read` accept.

## Session 27 — Reply/quote + slash variables + cross-thread bookmark filter ✅ DONE

- ✅ Per-row Reply / quote on assistant rows. New "⤴ Reply" button next to Bookmark/Copy/Revert pushes a `> quoted text\n\n` block into the composer's draft via a tiny new `state/composer-inbox-store.ts` (single-slot pub/sub keyed by threadId so a Reply published while a different thread was active gets applied the moment the user navigates back). Code fences in the source are stripped so the quote can't reopen a fence in the user's draft; long quotes are truncated at ~1500 chars with an ellipsis.
- ✅ Custom slash command variables. New `lib/slash-variables.ts` expands `{cwd}`, `{thread}` / `{threadtitle}`, `{selection}` (current composer textarea selection), `{date}` (YYYY-MM-DD local), `{time}` (HH:MM local), and `{datetime}` (ISO) at run time. `buildCustomSlashCommand` now wires the expansion through. Unknown tokens are left intact so users notice typos rather than getting silent empty strings. Settings hint updated.
- ✅ Cross-thread bookmark filter in the `⌘/Ctrl+K` command palette. New "★ all / ☆ N" toggle filters hits to bookmarked messages across every cached thread. Empty-query mode still works (the toggle without any text shows the global star list). Empty-state messaging spells out which mode the user is in. Closes the loop on Session 25 — bookmarks are now discoverable globally, not just per-thread.

## Session 26 — @file mentions + composer auto-resize + JSON thread export ✅ DONE

- ✅ `@file` mention picker in the composer. Caret-aware detection (`lib/mention-detector.ts`) opens an inline picker when the user types `@` at the start of a token; debounced fetch via `project/searchDirectories` rooted at the active thread's `cwd` (or `project/listDirectory` for the empty query). Selecting a result splices the cwd-relative path into the draft and parks the caret past the insert with a trailing space. Email-style false positives (`name@host`) are rejected by requiring the leading `@` to sit at start-of-string, after whitespace, or after a sentence-opener like `(`/`[`.
- ✅ Composer auto-resize textarea. The textarea now grows with the draft up to ~10 visual rows (then scrolls internally), driven by a `useLayoutEffect` that measures `scrollHeight` against the computed line-height. Replaces the previous `rows={3}` hard-cap that forced multi-paragraph drafts into a tiny scrolled window.
- ✅ Conversation export to JSON. New `exportThreadToJson` helper emits a stable `schemaVersion: 1` payload alongside the existing Markdown export. Sidebar context menu gets an "Export to JSON" entry. Image attachments export by reference (`{id, fileName, byteLength}`) — payload data URLs can be tens of MB and would balloon the file; users wanting the bytes can grab them from the lightbox.

## Session 25 — Per-message bookmarks + mark-as-unread + composer find/replace ✅ DONE

- ✅ Per-message bookmarks. New `state/bookmarks-store.ts` keeps `Set<messageId>` per thread, persisted via `prefsStore.{loadSaveBookmarks}`. A small `BookmarkButton` (☆/★) sits in the row-actions slot for assistant + user rows. The `ThreadSearchBar` gets a "☆ N / ★ all" toggle that filters the timeline to bookmarked rows; a banner across the chat shows the active filter and the matched-of-total count. Combines with Session 15's in-thread search so you can text-search inside the starred set.
- ✅ Mark thread as unread. New `markThreadUnread(threadId)` action drops the `lastVisitedAt[id]` entry so the Session 23 unread dot reappears. Wired into the sidebar context menu; disabled when the thread is already unread (no-op clarity).
- ✅ Composer find/replace. ⌘/Ctrl+Shift+F (scoped to the textarea so it doesn't fight the global ⌘/Ctrl+F thread search) opens a small bar above the textarea: Find / Replace inputs, Next/Prev, Replace, Replace-all, count. Pure helpers (`findAllOccurrences`, `replaceAt`, `replaceAll`) live in `lib/draft-find-replace.ts`; `replaceAll` walks back-to-front so length-changing replacements don't corrupt later spans.

## Session 24 — Inline file diff + drag-reorder pins + composer stats footer ✅ DONE

- ✅ Inline file diff viewer in `GitPanel`. Clicking any row in the dirty-files list expands its per-file diff inline; the unified patch returned by `git/diff` is sliced client-side via new `lib/git-diff-parser.ts` and rendered with line-level coloring (`+` green, `-` red, `@@` accent) by `components/git/DiffView.tsx`. Lazy: the patch is only fetched on first expand and reused across files. Removes the workflow detour to a terminal to see what's about to be committed.
- ✅ Drag-reorder pinned threads. Pinned rows now `draggable=true`; HTML5 drag/drop fires a new `reorderPinnedThreads(orderedIds)` action that rebuilds the `pinnedThreadIds` Set in user-chosen order and persists it. `groupThreadsByRecency` was updated to walk the Set's iteration order for the pinned bucket so the manual order is what users see. Pin-state changes still append (most-recently-pinned ends up at the bottom of the pin list — fix it with a drag).
- ✅ Composer footer with char + word + approximate-token counts. Tiny line under the textarea: `1,234 chars · 215 words · ~310 tokens`. Token count uses the chars/4 heuristic and is prefixed with `~` so users know not to budget against it for hard limits. Hidden when the draft is empty.

## Session 23 — Retry failed turn + unread indicator + custom slash commands ✅ DONE

- ✅ Retry failed turn. The inline `SystemErrorRow` now exposes a Retry button that walks back to the user message with the same `turnId`, recovers its text + attachments, and re-issues `turn/start`. Today the only recovery from a network blip / provider hiccup was to re-type the prompt; this closes the gap and reuses the existing `buildTurnInput` path so per-turn flags stay consistent.
- ✅ Per-thread unread indicator. Sidebar rows render a small dot when `thread.updatedAt > lastVisitedAt[id]`. `lastVisited` is persisted to IndexedDB; `selectThread` stamps it to `Date.now()`, and `turn/completed`/`turn/failed` on the active thread re-stamps too so the dot doesn't pop on for foreground turns. The dot vanishes the moment you open the thread. Reload-stable since both sides of the comparison live in storage / `thread/list`.
- ✅ User-defined slash commands. New `state/custom-slash-commands-store.ts` keeps a list of `{name, body}` snippets persisted via `prefsStore.{loadSaveCustomSlashCommands}`; Settings has a "Custom slash commands" section to add / edit / delete. Names follow a strict slug rule (`/^[a-z][a-z0-9-]{0,31}$/`) so they can't visually collide with whitespace or built-ins; built-ins always win on a name match. Custom commands `expand` into the composer draft (so users can review/edit before sending) instead of running a side effect — cleanly distinct from `/compact` etc.

## Session 22 — Responsive drawer + multi-select bulk actions + streaming throughput ✅ DONE

- ✅ Narrow-viewport sidebar drawer. The 768 px breakpoint used to hide the sidebar entirely (which left no way to switch threads on iPad-via-Tailscale); it now slides out as an overlay drawer with a hamburger button in the workspace header. Selecting a thread or tapping the backdrop closes it. Wide viewports keep the existing two-column grid unchanged.
- ✅ Multi-select bulk actions in the sidebar. A new "Select" button in the sidebar header flips rows into checkbox mode; the action bar runs Archive (live tab), Unarchive (archived tab), or Export across the chosen set. Bulk export concatenates all chosen threads into one Markdown file with per-thread headers and `---` separators (`exportThreadsToMarkdown` helper). j/k navigation auto-disables in select mode so muscle-memory archive can't fire by accident.
- ✅ Streaming throughput indicator in the chat header. New `state/streaming-stats-store.ts` keeps a per-thread `{startedAtMs, charCount}` counter — `turn/started` resets, every assistant/reasoning delta increments, `turn/completed`/`turn/failed` clears. The `ChatHeader` shows `● 482 ch/s · 0:14` while streaming; ticks every 500 ms. Late deltas that arrive without a started entry are dropped (no phantom counters).

## Session 21 — Browser notifications + cross-thread palette + power-user shortcuts ✅ DONE

- ✅ Browser desktop notifications on `turn/completed` and `turn/failed`. New `lib/notifications.ts` wraps the `Notification` API with permission gating, a Settings-side auto/on/off override (default `auto` = "on if granted"), and a per-thread `tag` so a chatty thread doesn't stack ten dock badges. Silent when the tab is focused — the inline UI is enough — and never auto-prompts; users opt in from Settings so we don't trip the browser's "this site wants to notify you" blocker. Combines with Session 20's title-flash so users notice completions whether or not they've granted permission.
- ✅ Cross-thread search palette — ⌘/Ctrl+K opens `CommandPalette`, which walks every cached thread's reducer state with the same `searchableText` helper that powers in-thread search. Hits show thread label + a 60-char snippet; ↑/↓/Enter select; clicking jumps into the thread. Capped at 80 hits so a runaway query doesn't lock up the UI.
- ✅ Three more power-user shortcuts wired into `Workspace`: `n` opens the New Chat modal, `p` toggles pin on the active thread, ⌘/Ctrl+K toggles the palette. All registered in `HelpModal` so the keyboard reference stays accurate.

## Session 20 — Document title + sidebar grouping + completion flash ✅ DONE

- ✅ Document title reflects the active thread: `[name] · agnt`. Helps when agnt is open in several tabs at once.
- ✅ Sidebar grouped by recency on the live tab: Pinned / Today / Yesterday / This week / Earlier. Archived stays flat under a single section header. Pure `groupThreadsByRecency` reads `updatedAt` then `createdAt` so threads missing both fall into Earlier.
- ✅ Title flash on `turn/completed` (and `turn/failed`) when the tab is hidden — alternates `(Turn done) [name] · agnt` against neutral every 1.5 s, auto-stops on `visibilitychange`. No-op when the tab is focused. Closes the "did my turn finish while I was elsewhere" gap without needing a WebPush gateway.

## Session 19 — Drafts autosave + pinned threads + power-user shortcuts ✅ DONE

- ✅ Composer drafts auto-saved per thread to IndexedDB. 400 ms debounce while typing, immediate save on thread switch and `beforeunload`, cleared on successful send. Empty drafts are removed (not stored as `""`) so the cache stays small.
- ✅ Pin threads to the top of the sidebar's live tab. New `state/threads-store.ts:togglePinThread` action persists IDs through `prefs-store.savePinnedThreadIds`. ★ glyph appears in the row's title and `Pin to top` / `Unpin` joins the context menu.
- ✅ `e` exports the active thread to Markdown (same path as the sidebar context menu); `r` opens the revert sheet for the most recent completed turn (walks the message list backward, picks the latest `role:"assistant"` non-streaming turn). Both gated on `skipWhenTyping` so they don't fire while users are in an input.

## Session 18 — Workspace images + markdown task lists + autolinks ✅ DONE

- ✅ `workspace/readImage` wrapper + per-(cwd, path) cache. `MarkdownContent` accepts a `cwd` prop; markdown image refs without an explicit scheme (`![cap](screenshot.png)`) route through the cache and render the bridge-downscaled preview. Errors and missing-cwd states surface as styled placeholder spans rather than broken `<img>` tags. Cache uses `ifByteLength`/`ifMtimeMs` on subsequent renders so the bridge can short-circuit with `notModified`.
- ✅ Markdown task lists — `- [x]` / `- [ ]` (case-insensitive) render as disabled checkboxes with strikethrough on the completed items. The bullet-list loop now stops at a task line so a mixed run splits cleanly into two adjacent blocks.
- ✅ Bare-URL autolinks — `https?://…` URLs in plain text become `<a target="_blank">` links. Trailing punctuation (`.,;:!?]) `) is excluded from the match so `(visit https://example.com).` keeps the closing paren and period as text.

## Session 17 — Slash commands + blockquotes + horizontal rules ✅ DONE

- ✅ Composer slash menu — typing `/` at the start of an empty draft opens a filtered palette (`/compact`, `/fork`, `/archive`, `/unarchive`, `/stop` — `canRun()` per command hides ones that don't apply, e.g. `/unarchive` only shows on archived threads, `/stop` only on a running turn). ↑/↓ navigate, Enter runs the highlighted command, Tab autocompletes the name, Esc dismisses. The form's submit also routes to the slash runner so Enter in the textarea fires the command instead of shipping the literal `/foo` to the bridge.
- ✅ Markdown blockquotes — collapse consecutive `>`-prefixed lines into a single `<blockquote>` so the renderer can run the standard inline tokenizer over it (links / bold / italic still work inside).
- ✅ Markdown horizontal rules — `---`, `***`, `___` (3+ matching characters) on their own line render as `<hr>`. Excluded from the paragraph fall-through so they don't get swallowed.

## Session 16 — Markdown links/images, composer history, lightbox nav ✅ DONE

- ✅ Markdown links `[text](url)` and images `![alt](url)` rendered with a strict scheme allowlist (`https?:`, `mailto:`, `#anchor` for links; `https?:`, `data:image/*` for images). `javascript:` / `file:` schemes are refused — the original markdown text falls through unchanged.
- ✅ Composer prompt history: up-arrow at an empty draft (or while in recall mode) walks backward through past user prompts in the active thread; down-arrow steps forward; Esc restores the in-progress draft; manual editing drops out of recall mode.
- ✅ Lightbox sibling navigation: left/right arrow keys + on-screen ‹ › buttons cycle through the active row's attachments with a `1 / N` counter. `state/lightbox-store.ts` accepts an image set + index instead of a single image; UserRow passes the row's full attachment array.

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
