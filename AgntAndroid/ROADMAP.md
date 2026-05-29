# AgntAndroid roadmap

Long-running adaptation work for the Android client, on top of the upstream
parity audit inherited from Stivy-01/remodex.

## Provider-agnostic adaptation

The upstream Android client assumes a Codex-only bridge. agnt's bridge serves
Codex, Claude Code, opencode, and Cursor through a provider plugin contract.
Most of the client is already agnostic (the bridge translates each provider
into Codex-shaped JSON-RPC), but a few surfaces need targeted work.

### P1 — runtime correctness

- [x] **opencode approval flow**. `IncomingEventRouter` matches both
      `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
      via `isApprovalServerRequestMethod`, exposes a
      `pendingApprovalRequest: StateFlow<PendingApprovalRequest?>` from
      `CodexService`, surfaces an `AlertDialog` (kind-aware title via
      `PendingRequestPresentation.approvalKindTitleRes`), and replies with
      `{decision: "accept"|"decline"|"acceptForSession"}` —
      `acceptForSession` is gated to command approvals only, matching iOS.
      Regression coverage: `IncomingEventRouterServerRequestTest`,
      `PendingApprovalTimelineFormatterTest`, `PendingRequestPresentationTest`.
- [x] **Codex-only RPC gating**. Audit complete:
        - `account/login/*`, `account/status/read`, `account/logout`,
          `account/login/openOnMac`, `getAuthStatus` — **never called** from the
          Android client. Account state is managed externally on the Mac/desktop
          side; the Android client has no login UI to gate.
        - `thread/generateTitle` — already tolerated. `generatedThreadTitleOrNull`
          (`CodexServiceThreadTitles.kt`) wraps `sendRequestImpl` in
          `runCatching { ... }.getOrNull()`; non-Codex providers' "managed
          externally" reply falls through to whatever fallback the caller has.
        - `voice/resolveAuth` / `voice/transcribe` — UI now self-disables.
          `supportsBridgeVoiceAuth` was already cleared by
          `consumeUnsupportedVoiceBridgeAuth` on the first negative response;
          it's now exposed as `bridgeSupportsVoiceTranscription: StateFlow<Boolean>`
          on `CodexRepository`, and `TurnConversationPane.voiceInteractionEnabled`
          observes it so the composer hides the mic after the first failed
          attempt. Self-resets on reconnect via `resetBridgeSession`.
          Pre-emptive gating (hiding the mic *before* the first attempt) still
          needs the `ActiveProvider` state holder below.
- [x] **Active provider awareness**. The bridge now publishes `providerId` in
      the `initialize` response (`agnt-bridge/src/bridge/handshake-handler.js`).
      `core/model/ActiveProvider.kt` parses it via `fromBridgeId`, the
      `CodexService` holds a `MutableStateFlow<ActiveProvider>`, and
      `CodexRepository.activeProvider: StateFlow<ActiveProvider>` exposes it
      to UI. `TurnConversationPane.voiceInteractionEnabled` now hides the mic
      pre-emptively for Claude / opencode / Cursor; `Unknown` (older bridges
      that don't publish providerId) falls back to the legacy
      fail-once-then-hide path so nothing regresses. Reset to `Unknown` in
      `resetBridgeSession`. Cold-path initialize (codex transport answers
      directly) doesn't carry providerId yet — the client picks it up on the
      next warm reconnect. Tracked: `ActiveProviderTest`,
      `handshake-handler.test.js` providerId cases.
- [x] **`system/notice` toast surfacing**. End-to-end wired:
        - Bridge already emits `system/notice` from opencode `tui.toast.show`
          (`agnt-bridge/src/providers/opencode/translate.js#handleToastShow`).
        - `IncomingEventRouter` dispatches `system/notice` → `onSystemNotice`
          callback, dropping payloads with no title and no message.
        - `SystemNoticesStore` (in `data/`) buffers notices with per-severity
          default durations (info 5s / warn 8s / error 12s); supports
          bridge-supplied `durationMs` overrides, manual dismiss, and `clear()`
          on reconnect via `resetBridgeSession`.
        - `CodexRepository.systemNotices: StateFlow<List<SystemNotice>>` +
          `dismissSystemNotice(id)`.
        - `MainShell` renders `SystemNoticeHost` (bottom-aligned, severity-
          colored pills, animated slide-in/out, close button).
        - Note: iOS PARITY row claimed "yes" but no iOS implementation
          actually exists; PARITY corrected.
        - Coverage: `SystemNoticeSeverityTest`, `SystemNoticesStoreTest`,
          `IncomingEventRouterServerRequestTest` (system/notice envelope +
          empty-payload guard).

### P2 — provider-flag plumbing

- [x] **Plan mode for Claude**. Already wired end-to-end via the existing
      `collaborationMode` mechanism: the composer's plan-mode toggle
      (`TurnComposerBar.isPlanModeEnabled`, in the attachment-menu dropdown)
      sends `params.collaborationMode = { mode: "plan", settings: {...} }`
      on `turn/start`, which the Claude bridge translator
      (`agnt-bridge/src/providers/claude/translate.js`) maps to
      `--permission-mode plan`. Producer pinned by
      `CollaborationModePayloadTest`; consumer pinned by the Claude
      translator's "turn/start params translate to per-turn CLI args"
      test. Granular per-turn `permissionMode` values
      (`acceptEdits`/`bypassPermissions`/`dontAsk`/...) aren't surfaced in
      the composer — left as a follow-up if a user need surfaces.
- [x] **Per-turn `params.model` override**. Already wired in
      `CodexServiceTurn.buildTurnStartRequestParams` (always sends
      `params["model"]` from `runtimeModelIdentifierForTurn`, which respects
      the composer's `_selectedModelId` first and falls back to the
      thread's persisted model). Confirmed against all three non-Codex
      providers: Claude / Cursor read `params.model | modelId | modelID`;
      opencode reads `params.modelID | params.model` — fallback path now
      pinned by an opencode contract test
      (`turn/start accepts params.model as a fallback for modelID`).

### P2.4 — terminal feature follow-ups

The on-device SSH terminal landed (parity with iOS Citadel/Ghostty surface)
backed by `sshj` and an xterm.js WebView host (`assets/terminal/terminal.html`).
Open follow-ups:

- [x] **Per-turn "Open Terminal Here" toolbar entry**. The
      `ConversationHeader` overflow menu now exposes "Open Terminal Here"
      whenever the active thread is bound to a git working directory; it
      navigates to the terminal screen with the cwd pre-populated. Wired
      through a new `AppRoutes.terminalRoute(cwd)` builder (URL-encodes the
      path) → `composable(AppRoutes.Terminal, args = [cwd])` →
      `TerminalScreen(preferredWorkingDirectory = cwd)`. Older sidebar
      entry passes `cwd = null` and keeps the previous behavior. Tracked:
      `AppRoutesTest`.
- [x] **ECDSA SSH key support**. sshj's `client.loadKeys(...)` already
      accepts ECDSA (P-256/384/521) keys — confirmed via a JVM regression
      test (`EcdsaKeyDecodeTest`) that generates a P-256 keypair, PEM-wraps
      it as PKCS#8, and asserts `PKCS8KeyFile` round-trips it to
      `KeyType.ECDSA256`. Doc strings updated:
      `TerminalError.UnsupportedPrivateKey` now mentions ECDSA, and the
      Windows setup guide note documents `-t ecdsa` / `-t rsa` alongside
      Ed25519. OpenSSH FIDO (`-t ed25519-sk` / `-t ecdsa-sk`) keys still
      require a hardware token round-trip that sshj doesn't support — out
      of scope.
- [x] Termux-style native terminal renderer (`TermuxTerminalSurface`, ported
      from upstream Stivy-01/remodex 245ea8a). Apache-2.0 `terminal-view` +
      `terminal-emulator` deps resolved via JitPack. Wired as the WebView
      fallback — strictly better than the previous static-text fallback. To
      promote Termux above WebView, add a user-facing toggle; for now WebView
      remains the default unless `isUnavailableSignal` fires. Visual
      verification on a device still pending.
- [x] **Multi-tab session UI polish**. Each session row in
      `TerminalOptionsMenu` now renders a status dot (using the same tone
      palette as the title pill) and the session's cwd as a secondary line
      under the label, matching iOS's `TerminalScreen.swift` multi-tab
      menu. Empty cwd is hidden so unconnected/idle tabs don't show a
      stray subtitle.

### P2.5 — beta tester module

- [x] **Removed.** The `beta/` module and `TesterHqScreen` integrated with
      upstream Remodex's hosted Supabase tester program — a direct
      violation of the local-first guardrail in `/CLAUDE.md`. The whole
      surface is gone: the `beta/` and `ui/beta/` source directories
      (8 source files + 4 unit tests), the `BETA_ENABLED` / `BETA_API_BASE_URL` /
      `BETA_API_KEY` gradle properties + BuildConfig fields,
      `FeatureFlags.betaEngagementEnabled`, the `TesterHq` nav route,
      the sidebar trophy + coachmark overlay, the Settings `Tester HQ`
      row, ~22 `recordMissionEvent` call sites scattered across the
      composer / shell / terminal / scanner, and the 4 beta unit tests.
      Net diff is a substantial deletion. If we ever want feedback
      collection again, we'd build it as a `mailto:` / GitHub-issue
      handoff so nothing crosses an unowned hosted boundary.

### P3 — cosmetics / rename

- [x] **`CodexService*` → `AgentService*`.** Bulk-renamed `CodexService`
      (the impl class), `CodexServiceError` (the sealed error), and all
      `CodexService.Foo` extension files (28 files total) to their
      `AgentService` counterparts via `git mv` + `sed`. `CodexServiceTier`
      stayed as-is because it's a wire-protocol model for the
      `serviceTier` field on `turn/start.params`, not a service-layer
      name. Pure mechanical rename; behavior unchanged. All 600+ Android
      unit tests still green.
- [x] **`CODEX_*` constants → `AGNT_*`.** Bulk-renamed 8 constants
      (`CODEX_SECURE_PROTOCOL_VERSION`,
      `CODEX_PAIRING_QR_VERSION`,
      `CODEX_SECURE_HANDSHAKE_TAG`,
      `CODEX_SECURE_HANDSHAKE_LABEL`,
      `CODEX_SECURE_CLOCK_SKEW_TOLERANCE_SECONDS`,
      `CODEX_TRUSTED_SESSION_RESOLVE_TAG`,
      `CODEX_TRUSTED_SESSION_RESOLVE_RESPONSE_TAG`,
      `CODEX_TRUSTED_SESSION_RESOLVE_CLOCK_SKEW_TOLERANCE_SECONDS`) +
      their 36 references across 5 files.
- [x] **`*_remodex` string-resource keys → `*_agnt`.** Renamed
      `nav_about_remodex`, `settings_about_remodex_hint`, and 6
      `about_remodex_*` keys plus their 8 `R.string.*` references in
      `SettingsScreen` / `AboutScreen`. Display values were already
      branded "About agnt" / "Pairing" / etc.; only the symbol names
      moved.

## Build / CI

- [ ] Add `ktlint` or `detekt` to `:app:check`.
- [ ] Add `:app:assembleDebug` artifact upload on PRs (unsigned APK).
- [ ] Consider Gradle dependency-version catalog (`libs.versions.toml`) for
      cross-module bumps.

## Finishing the upstream parity audit

Per `ios-android-parity-plan.md`, the reasonable code-inspection parity gaps
for Android/iOS surface chrome have been closed for the main chat, sidebar,
project picker, settings, onboarding, and terminal editor flows. Two items
remain:

- [ ] Final markdown/message pixel polish (upstream commit c7843aa).
- [ ] Manual device pairing + visual screenshot verification. This is the next
      useful source of truth before more subjective UI changes; do it with
      paired iOS/Android screenshots instead of more inferred code-only tweaks.

## Known upstream divergences

The following constants were tightened during import; nothing else should
diverge from upstream silently:

| File                                                                                  | Upstream                                 | This module                              |
| ---                                                                                   | ---                                      | ---                                      |
| `core/model/SecureTransportModels.kt::CODEX_SECURE_HANDSHAKE_TAG`                     | `remodex-e2ee-v1`                        | `agnt-e2ee-v1`                           |
| `core/model/SecureTransportModels.kt::CODEX_TRUSTED_SESSION_RESOLVE_TAG`              | `remodex-trusted-session-resolve-v1`     | `agnt-trusted-session-resolve-v1`        |
| `core/model/SecureTransportModels.kt::CODEX_TRUSTED_SESSION_RESOLVE_RESPONSE_TAG`     | `remodex-trusted-session-resolve-response-v1` | `agnt-trusted-session-resolve-response-v1` |
| `app/build.gradle.kts` `defaultConfig`                                                | `sionCode = 7` orphan line + `versionCode = 8` | clean `versionCode = 1`, `versionName = "0.1.0"` |
| Bridge checkpoint ref prefix (test fixtures)                                          | `refs/remodex/checkpoints`               | `refs/agnt/checkpoints`                  |
| Bridge update command (test fixture)                                                  | `npm install -g remodex@latest`          | `bun install -g @dotbrains/agnt`         |
| `AndroidManifest.xml` optional default-relay meta-data key                            | `PHODEX_DEFAULT_RELAY_URL`               | `AGNT_DEFAULT_RELAY_URL`                 |
