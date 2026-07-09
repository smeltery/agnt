# AgntAndroid roadmap

Long-running adaptation work for the Android client, on top of the upstream
parity audit inherited from the original import.

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
      from the original import). Apache-2.0 `terminal-view` +
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

### P2.6 — QR pairing hardening

- [x] **Short pairing codes + pasteable `RMX1:` prefix.** Ported the
      QR scanner / validator changes from the original import:
      `QrPairingValidator.kt` (+87 lines) gained
      `QrPairingValidationResult.ShortCode`, the
      `[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,12}` regex,
      `normalizeShortPairingCode` (public, also lower-cases via
      `uppercase()` + strips dashes/spaces), and
      `decodePasteablePairingCode` for `RMX1:base64...` paste tokens
      (URL-safe Base64 with stripped padding). The `RMX1:` prefix
      matches iOS `QRScannerPairingValidator.swift:17`. `QrScannerScreen`
      (+136 lines) dropped the secondary "Relay URL for short codes"
      input field in favor of a smart manual-entry parser
      (`parseManualPairingInput`) that extracts pairing code + relay URL
      from arbitrary pasted text — including `code: ABCDEF` labels,
      bare 8-12-char short codes, and embedded `ws(s)?://` / `https?://`
      relay URLs — and a multi-candidate resolver
      (`resolvePairingCodeWithCandidates`) that tries pasted relay →
      saved snapshot → trusted-Mac registry → `AppEnvironment.relayBaseURL`
      until one resolves. `looksLikeRemodexPairingPayload` →
      `looksLikeAgntPairingPayload` and "Update Remodex" copy →
      "Update agnt" to match iOS. Three new tests
      (`shortPairingCode_returnsLookupRequest`,
      `pasteablePairingCode_decodesPayload`,
      `resolvePairingCode_preservesRelayPathPrefix`); full suite
      562 unit tests green, ktlint clean.

### P2.7 — services/ package reorganization

- [x] **34 flat `services/*.kt` files → 9 sub-packages.** Mirrors the
      iOS reorg of `Services/CodexService/{Account,Composer,Threads,...}/`
      so the AgentService extension files are domain-grouped instead of
      sitting at one level:
      ```
      services/
      ├── agent/                      AgentService.kt (root)
      │   ├── connection/             AgentServiceConnection / Transport / SecureTransport / Resume / DesktopHandoffService
      │   ├── threads/                AgentServiceHistory / Messages / MissingThread / StartThread / Thread{Fork,GroupOperations,ProjectRouting,Removal,Titles} / Turn / Continuation / ContextWindow / CodexLookupService
      │   ├── runtime/                AgentServiceRuntime / RuntimeTierCompat / Status / Sync / TurnStartRpcCompat / RateLimitPayloadCodec
      │   ├── notifications/          AgentServiceLocalNotifications / PendingRequests
      │   ├── review/                 AgentServiceReview / AiChangeSetRevertService
      │   └── voice/                  AgentServiceVoice
      ├── git/                        GitActionsService / ProjectFolderService
      └── workspace/                  WorkspaceCheckpointService / WorkspaceImageService
      ```
      `git mv` for the files, `perl` rewrite for the `package`
      declarations, `perl` rewrite for the 9 external import paths across
      the codebase, plus ~70 new cross-sub-package imports added to the
      moved files themselves (extension functions on `AgentService` that
      cross sub-package boundaries now need explicit imports — they used
      to be in the same flat package). 562-test suite green, ktlint clean.
      Total churn: 34 files moved, ~150 source files touched, 0 behavioral
      change.

- [x] **44 flat `ui/turn/*.kt` files → 9 sub-packages.** Same script-driven
      pattern as the services reorg, mirroring iOS's
      `Features/Chat/{Autocomplete,Composer,Attachments,Subagent,Diff,Toolbar,Timeline,Recovery,Worktree}/`:
      ```
      ui/turn/
      ├── TurnConversationPane.kt   (root — the top-level chat shell)
      ├── autocomplete/             SkillReferenceFormatter / TurnComposerAutocompleteModels / TurnConversationPaneAutocomplete
      ├── composer/                 TurnComposerBar / SecondaryBar / StateModel / RuntimeControls / RuntimeToolbarMenuBuilder / ToolbarActionsBuilder / ToolbarMenuModels / TrailingTokens / UnifiedModelRuntimeChip / UsageRing / UsageStrip / VoiceRecordingCapsule / TurnConversationPaneRuntime
      ├── attachments/              TurnAttachmentViews / TurnConversationPaneAttachments
      ├── subagent/                 ToolExecutionCard / ToolExecutionUiBuilder / TurnCommandExecutionCard / TurnCommandHumanizer / TurnSubagentActionCard
      ├── diff/                     TurnFileChangeDetailCard
      ├── toolbar/                  TurnGitBranchAccessory / TurnPlanAccessoryCard / TurnReviewAccessory / TurnUsageStatusSheet / BranchPickerOpenRequestPolicy / TurnConversationPaneAccessories
      ├── timeline/                 TurnMessageRow / TurnMarkdownBody / TurnMarkdownRepoFileLink / TurnMermaid{Fallback,WebView}Card / TurnCodeCommentDirectiveCard / TurnThinkingTimelineRow / TurnTimeline{FollowBottom,GroupedRunsRow,RenderCaches} / TurnSmartScrollNavigation
      ├── recovery/                 TurnConnectionRecovery / TurnFeedbackDialog
      └── worktree/                 TurnWorktreeHandoffModels
      ```
      Same mechanics as services: `git mv` for files, `perl` for package
      declarations (had to strip a UTF-8 BOM from 3 files first), then
      ~170 cross-sub-package imports added (some auto-generated from the
      compiler's unresolved-reference log, some by inspection).
      Additional cleanup: an over-greedy regex for fully-qualified
      reference rewriting briefly damaged ~56 files (turned
      `com.dotbrains.agnt.mobile.ui.turn.composer.X` →
      `composer.X` everywhere) — patched back with targeted scripts.
      One private extension function (`SmartScrollAction.displayLabel`
      in `timeline/TurnSmartScrollNavigation.kt`) had to be widened to
      `internal` so it could be called from `autocomplete/`.
      Final state: 562/562 tests green, ktlint clean. Note: the upstream
      parity tax flagged in the previous note is now real — future
      `ui/turn/` backports from upstream will need path
      translation through this layout.

### P2.5 — beta tester module

- [x] **Removed.** The `beta/` module and `TesterHqScreen` integrated with
      the upstream client's hosted Supabase tester program — a direct
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

- [x] **ktlint wired into CI.** `org.jlleitschuh.gradle.ktlint` 12.1.2
      (ktlint 1.4.1, android-mode on) applied to `:app`. A new
      `.editorconfig` at `AgntAndroid/.editorconfig` locks 4-space indent
      and disables five default rules that fight our codebase
      conventions: `function-naming` (Compose @Composable PascalCase),
      `string-template-indent` (test fixtures), `enum-entry-name-case`
      (enums mirror wire-format JSON), `property-naming` +
      `backing-property-naming` (the `_foo: MutableStateFlow` + public
      `val foo: StateFlow` pattern), and `filename` (purpose-named files
      that group multiple related types). CI runs `./gradlew
      :app:ktlintCheck --no-daemon` as the style gate before tests.
      Adopted intentionally on top of `:app:ktlintCheck` rather than the
      Gradle `:app:check` lifecycle task because the latter pulls in
      Android Lint, which currently has 20 pre-existing errors that are
      separate housekeeping work (track in a follow-up if anyone wants a
      Lint baseline).
- [x] **Android Lint baseline established.** `AgntAndroid/app/lint-baseline.xml`
      snapshots the current 20 errors / 163 warnings / 6 hints so
      `:app:lintDebug` now exits clean and gates only NEW lint findings.
      Wired via `android { lint { baseline = file("lint-baseline.xml") } }` in
      `app/build.gradle.kts`. The pre-existing issues are real housekeeping
      that should be addressed individually (see breakdown below); the
      baseline just stops them from auto-failing every build while that
      work is queued. To regenerate after fixing any: `./gradlew
      :app:updateLintBaseline`. Current error categories:
        - **`LocalContextGetResourceValueCall` (14)** — `context.getString(R.string.x)`
          inside `scope.launch { }` blocks within Composables. Fix is to
          hoist `stringResource(R.string.x)` to a `val` at the top of each
          Composable so it re-caches on configuration change. MainShell.kt,
          QrScannerScreen.kt, SidebarScreen.kt, TurnConversationPane.kt.
        - **`FlowOperatorInvokedInComposition` (4)** — `controller.outputEvents.filter { … }.map { … }`
          allocated on every recomposition inside `TerminalScreen.kt`.
          Fix is `remember(activeTerminalId) { … }` around the chain.
        - **`MissingPermission` (2)** — `NotificationManagerCompat.notify`
          (AgntLocalNotificationPresenter:169) and `AudioRecord(…)`
          (BridgeVoiceRecorder:157) can throw `SecurityException` if the
          user revokes POST_NOTIFICATIONS / RECORD_AUDIO at runtime. Wrap
          in `try { … } catch (e: SecurityException) { … }` or
          `checkSelfPermission` first.
- [x] **Unsigned debug APK uploaded on PRs.** The existing
      `assembleDebug` step now publishes
      `app/build/outputs/apk/debug/*.apk` as
      `agnt-debug-<PR#>.apk` artifact (14-day retention) via
      `actions/upload-artifact@v4`. Only on `pull_request` events so push
      builds don't shadow signed releases.
- [x] **Gradle dependency-version catalog.** Migrated all dependencies
      and plugin coordinates from inline string literals to
      `AgntAndroid/gradle/libs.versions.toml`. 24 versions / 35 library
      aliases / 5 plugin aliases. Both `build.gradle.kts` files now use
      `alias(libs.plugins.…)` and `libs.<bundle>`, making cross-module
      bumps a single-toml edit.

### P2.8 — companion pet overlay (iOS `Features/Pet/` parity)

- [x] **Ported the optional companion pet from iOS.** The bridge handler
      (`agnt-bridge/src/handlers/pet-handler.js`, `pet/list` + `pet/read` over
      `~/.codex/pets` / `~/.codex/avatars`) was already provider-agnostic, so
      this was a client-only port:
        - `core/model/PetCompanion.kt` — `PetCompanion`, `PetCompanionPhase`
          (atlas rows/frame counts/per-frame durations kept byte-identical to
          iOS so the same spritesheets animate the same way), `PetCompanionPosition`,
          `PetCompanionStatusSnapshot`, and a pure `PetCompanionLayout` (clamp /
          point / normalized round-trip).
        - `services/agent/pet/AgentServicePets.kt` — `CodexRepository.listPets` /
          `readPet` extensions (metadata-only list + separate spritesheet hydrate,
          with the iOS `pet/read` → `pet/list(includeData)` fallback for older
          bridges).
        - `data/PetCompanionStore.kt` — persists enabled / selected / position in
          a dedicated `agnt_pet` SharedPreferences file, exposes
          `availablePets` / `renderedPet` / `isLoading` / `errorMessage` flows,
          and resets in-memory state on disconnect. `PetCompanionStatus.kt` holds
          a pure `derivePetStatusSnapshot` (idle / running / waiting / failed /
          review) over the pet-relevant repo state slice.
        - `ui/pet/PetCompanionOverlay.kt` — decodes the base64 atlas to a
          `Bitmap`, crops 192×208 cells into cached `ImageBitmap` frames, runs the
          play-3×-then-idle animation loop, supports drag-to-reposition + tap-to-jump,
          and renders the status pill. `PetCompanionHost.kt` wires the store to the
          bridge + drives the 1 s status refresh while work runs; mounted in
          `MainShell` (interaction limited to Home).
        - Settings gains a `Companion pet` card (enable switch + pet picker +
          refresh).
      Status: `AgentService` feeds `failed` / `review` / completion-banner
      phases from turn lifecycle notifications and clears stale outcomes when a
      thread is viewed or starts another run.
      Coverage: `PetCompanionTest` (atlas math + layout), `PetCompanionStatusTest`
      (snapshot derivation + prompt sanitizing), `AgentServicePetsTest` (parsing).
      `:app:ktlintCheck` + `:app:testDebugUnitTest` + `:app:lintDebug` green.
      Visual verification on a device still pending.

### P2.9 — upstream parity ports (local-first)

Four local-first Android surfaces from upstream ("port android local-first
parity changes", landed the day after agnt's snapshot import). The
self-contained pieces (models, services, prefs, palette, draft logic) were
ported faithfully with tests; the UI wiring that conflicts with agnt's
structure was deferred rather than forced.

- [x] **Relay health client** — `core/model/RelayHealthModels.kt`,
      `services/RelayHealthClient.kt` (polls the relay `GET /health` route in
      `relay/server.js`; log tag rebranded `RemodexRelayHealth` → `AgntRelayHealth`),
      parser test. Reuses `SessionPersistence.loadRelaySnapshot()` +
      `validateRelayUrl()`. Fully self-contained — no deferred wiring.
- [x] **Workspace text-file preview (component)** — `WorkspaceTextFileModels`,
      `services/workspace/WorkspaceTextFileService` (uses the existing
      `workspace/readFile` RPC), `ui/turn/WorkspaceTextFilePreviewDialog`
      (`AgntModalBottomSheet`), service test.
  - [x] **Wired to a tap target.** Hooked into the existing repo-file-link
        dispatch in `MainShell` (`openRepoDiffSheetFromMarkdown`): tapping a
        repo-file link in assistant markdown opens the read-only preview when
        the repo-diff sheet isn't applicable (clean tree, no git controls, or no
        active thread). Reuses `RepoMarkdownFileLink.looksLikeLinkToLocalRepoFile`
        detection — no new fragile file-mention parser.
- [x] **User bubble color (palette + prefs)** — `core/model/UserBubbleColor.kt`,
      `data/UserBubblePreferences.kt` (key `codex.userBubbleColor` →
      `agnt.userBubbleColor`, reuses `ThemePreferences` store),
      `ui/theme/UserBubbleColorPalette.kt`, two tests.
  - [x] **Applied in user-message rendering + Settings picker.** A
        `LocalUserBubbleColor` CompositionLocal is provided by `AgntTheme`
        (listens to the pref key so the timeline recomposes on change) and read
        in `ui/turn/timeline/TurnMessageRow.kt` for the user bubble background +
        foreground (the hairline outline is kept only for the neutral default).
        A swatch picker lives in `ui/settings/SettingsScreen.kt`, persisted via
        `UserBubblePreferences`.
- [x] **New-chat draft (logic + models)** — `ui/draft/NewChatDraftLogic.kt`,
      `NewChatDraftModels.kt`, logic test. `GitRepoSyncResult` / `GitChangedFile`
      match upstream.
  - [x] **`NewChatDraftScreen.kt` ported + wired.** Adapted from upstream with
        the freemium `SubscriptionService` / free-send gate dropped entirely
        (agnt is local-first, no send limits). Wired into agnt's nav via
        `AppRoutes.NewChatDraft` + an `AppNavHost` destination, reachable from
        the sidebar "Quick Chat" action (`SidebarScreen` →
        `SidebarDrawerContent`). The existing project-picker-sheet new-chat path
        is left intact; the draft screen reuses `SidebarProjectPickerSheet` for
        folder selection only (the screen owns `thread/start` so the first
        prompt is sent atomically). General chat with no folder starts a rootless
        thread (`cwd = null`) — agnt has no upstream `createRootlessChatRoot` RPC.

`:app:ktlintCheck` + `:app:testDebugUnitTest` + `:app:assembleDebug` green.
All package/identifier rebrands applied; banned-identifier sweep clean.

### P3.0 — multi-device switcher / "My Devices" (iOS PR #100 parity)

Ports the upstream "My Devices" surface so a phone paired with
multiple computers can switch between them, with per-device local session state.
Provider-agnostic — the upstream freemium/`SubscriptionService` gate is dropped
(device switching is available on every provider). Trusted-session resolve is
built on QR pairing + the phone/Mac identity keys, not any ChatGPT token.

- [x] **Mac-scoped local session store** — `core/persistence/MacScopedSessionStore.kt`
      namespaces cached threads, active thread, renames, associated worktrees,
      runtime selection, and locally-deleted/archived ids per `macDeviceId`
      (SharedPrefs `agnt_mac_scoped_state`). Scoped base keys reuse the
      `SessionPersistence` `KEY_*` literal strings so the first scoping read falls
      back to existing un-scoped data. Our `CodexThread` has no `collaborationMode`,
      so the cached-thread snapshot drops that column.
- [x] **Trusted-session resolve client** — `services/agent/connection/AgntTrustedSessionResolveClient.kt`
      signs a per-request transcript with the phone identity key, POSTs it to the
      relay `/v1/trusted/session/resolve`, and verifies the relay's signed response.
- [x] **AgentService device-switch state + actions** — `services/agent/devices/`
      (`AgentServiceTrustedDevices`, `AgentServiceDeviceSwitch`). `AgentService`
      now exposes `trustedDevices`, `switchingDeviceId`, `deviceSwitchNotice`,
      `currentTrustedMacDeviceId`, `previousTrustedMacDeviceId`, `relayMacDeviceId`
      StateFlows and `switchToTrustedDevice` / `switchToScannedDevice` /
      `cancelDeviceSwitch` / `forgetTrustedDevice` / `setDeviceMenuVisible`.
      `initializeTrustedDeviceState()` runs from the service init; the secure
      handshake now refreshes the device list + `relayMacDeviceId` after recording
      the trusted-Mac registry (covers both QR bootstrap and trusted resume).
- [x] **My Devices UI** — `ui/mydevices/MyDevicesScreen.kt` +
      `MyDevicesPresentation.kt` (pure presentation + row/sort logic). Registered
      as nav route `AppRoutes.MyDevices` in `AppNavHost`, opened from a sidebar
      icon button (`lucide_ic_monitor_smartphone`) in `SidebarDrawerContent`. Scan
      QR / Pair with Code both route through the existing single QR scanner screen.
- [x] **Sidebar quick-switch dropdown** — `SidebarDrawerContent` now surfaces the
      active device row whenever `MyDevicesPresentation.shouldShowDeviceSwitcher`
      says at least two menu-eligible devices exist. It reuses
      `switcherRows` / `activeSwitcherRow`, confirms before switching, calls the
      existing `switchToTrustedDevice`, and keeps the full My Devices screen for
      visibility and forget-device management.
- [x] **`CodexRepository` device-switch surface** — flows + actions added with
      defaulted bodies so existing test fakes keep compiling.
- [x] **Tests** — `ui/mydevices/MyDevicesPresentationTest`,
      `core/persistence/MacScopedSessionStoreTest` (adapted: no composer-draft key,
      no `collaborationMode`).
- [ ] **Mac-scoped message-timeline store (deferred).** Per-device persistence
      currently covers thread metadata + runtime selection; the message timeline
      stays in the un-scoped `CodexMessagePersistence` (cleared/reloaded on switch
      rather than namespaced). `CodexMessagePersistence` / `SessionPersistence`
      were not given a `macDeviceId` param because that scoping cascades across the
      whole timeline read/write path. iOS PR #100 keeps the same un-scoped timeline.
- [ ] **Composer-draft scoping (deferred).** Upstream's `MacScopedSessionStore`
      has a composer-draft column; agnt has no per-thread composer-draft store yet,
      so that surface is omitted.

`:app:ktlintCheck` + `:app:testDebugUnitTest` green (619 tests, 0 failures).
Banned-identifier sweep clean over added/changed files.

### P3.1 — workspace artifact previews

- [x] **SVG workspace preview.** `WorkspaceTextFilePreviewDialog` now detects
      `.svg` workspace files and renders them through `WorkspaceSvgPreview`, an
      offline WebView with JavaScript disabled, network/file access blocked, a
      strict CSP, and external `href`/`src` stripping. This keeps using
      `workspace/readFile`, so no bridge or image-RPC change is required.
      Coverage: `WorkspaceSvgPreviewSecurityTest`.
- [x] **Syntax-highlighted code preview.** `WorkspaceCodePreview` now renders
      non-SVG workspace text previews with line numbers, selectable text, common
      language-token highlighting, and a 512 KB highlight cap that falls back to
      plain monospace for large files. Coverage: `WorkspaceCodePreviewTest`.

## Finishing the upstream parity audit

Per `ios-android-parity-plan.md`, the reasonable code-inspection parity gaps
for Android/iOS surface chrome have been closed for the main chat, sidebar,
project picker, settings, onboarding, and terminal editor flows. Two items
remain:

- [ ] Final markdown/message pixel polish (upstream commit c7843aa).
      Collapsible search citation rows are ported; finish the rest from
      screenshot/device comparison rather than more code-only inference.
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
