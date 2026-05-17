# AgntAndroid roadmap

Long-running adaptation work for the Android client, on top of the upstream
parity audit inherited from Stivy-01/remodex.

## Provider-agnostic adaptation

The upstream Android client assumes a Codex-only bridge. agnt's bridge serves
Codex, Claude Code, opencode, and Cursor through a provider plugin contract.
Most of the client is already agnostic (the bridge translates each provider
into Codex-shaped JSON-RPC), but a few surfaces need targeted work.

### P1 — runtime correctness

- [ ] **opencode approval flow**. Handle `item/commandExecution/requestApproval`
      and `item/fileChange/requestApproval` JSON-RPC requests. Reply with
      `{decision: "accept" | "decline"}`. iOS lives in
      `AgntMobile/.../PendingRequestPresentation*`; mirror that. The Android
      types (`StructuredInputDialogLogicTest`, `PendingRequestPresentationTest`)
      already exist, so the data plumbing is partly in place.
- [ ] **Codex-only RPC gating**. Verify all UI surfaces that call
      `account/login/*`, `account/status/read`, `voice/transcribe`,
      `voice/resolveAuth`, structured-JSON `thread/generateTitle`, and
      `account/login/openOnMac` either:
        - hide their affordance when `activeProvider.id != "codex"`, or
        - tolerate the synthetic "managed externally" response.
      Today the Codex UI in `CodexServiceVoice.kt`, `CodexServiceStatus.kt` and
      `CodexServiceMessages.kt` calls these unconditionally.
- [ ] **Active provider awareness**. Surface the active provider id on
      `thread/started` / `bridge/status` and use it to drive the gates above.
      Add a `ActiveProvider` state holder in `core/` and observe it from
      `CodexService*` (rename of the latter is deferred — see below).
- [ ] **`system/notice` toast surfacing**. Verify the `system/notice` JSON-RPC
      notification path renders an Android Snackbar/toast like opencode's
      `tui.toast.show` does on iOS.

### P2 — provider-flag plumbing

- [ ] Surface Claude plan mode in the composer toolbar
      (`TurnComposerToolbar*Builder.kt`). The bridge accepts
      `params.permissionMode` per turn.
- [ ] Verify per-turn `params.model` override is forwarded for all providers
      (currently designed against the Codex shape).

### P2.4 — terminal feature follow-ups

The on-device SSH terminal landed (parity with iOS Citadel/Ghostty surface)
backed by `sshj` and an xterm.js WebView host (`assets/terminal/terminal.html`).
Open follow-ups:

- [ ] Per-turn "Open Terminal Here" toolbar entry (iOS lives in
      `TurnToolbarContent.swift`); on Android this needs to land in the turn
      action menu and pre-populate the terminal cwd from the active worktree.
- [ ] ECDSA + OpenSSH FIDO key support. sshj decodes Ed25519 / RSA / ECDSA
      out of the box, but the editor sheet only documents Ed25519/RSA. Verify
      ECDSA round-trips and document.
- [ ] Termux-style native terminal renderer as an alternative to WebView. The
      WebView path is faithful to Ghostty's rendering but heavier than a
      `terminal-view`-based widget; revisit if perf or input latency complaints
      arrive.
- [ ] Multi-tab session UI polish. The drop-down session list works but
      lacks the per-tab cwd / status badging the iOS menu has.

### P2.5 — beta tester module

- [ ] The `beta/` module + `TesterHqScreen.kt` integrate with a hosted Supabase
      backend used for upstream Remodex's tester program. It is build-time
      gated off by default (`BuildConfig.BETA_ENABLED` requires both the env
      var `BETA_ENABLED=true` and a non-blank `BETA_API_BASE_URL`), but the
      hosted-service coupling is at odds with the local-first guardrail in
      `/CLAUDE.md`. Decide: remove the module entirely, or repurpose it as
      opt-in self-hosted feedback wired to the user's own relay/instance.
      Stivy-01's `supabase/` config folder was not imported.

### P3 — cosmetics / rename

- [ ] Rename `CodexService*` to `AgentService*` (or split provider-specific
      shims). The current name is a holdover from the Codex-only upstream;
      the class hierarchy is already protocol-agnostic in practice. Deferred
      because it's a wide rename across ~30 files with high diff cost and zero
      runtime impact. Worth doing once the P1/P2 work has settled.
- [ ] Rename the `core/model/CODEX_*` constants similarly (e.g.
      `CODEX_SECURE_HANDSHAKE_TAG` → `AGNT_SECURE_HANDSHAKE_TAG`). Value
      already updated; only the symbol name still encodes the upstream's
      Codex-only assumption.
- [ ] Rename `nav_about_remodex`, `about_remodex_*`, `settings_about_remodex_hint`
      string resource keys to drop the `remodex` prefix. Display values already
      updated; keys kept for now to minimize the porting diff.

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
