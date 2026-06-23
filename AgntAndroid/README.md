# AgntAndroid

Android client for agnt. Pairs with the local [agnt-bridge](../agnt-bridge/) over
the same E2EE-encrypted JSON-RPC protocol that the iOS app (`../AgntMobile/`)
and the browser client (`../agnt-web/`) speak.

This directory is a fork of an Apache-2.0 Android client. See
[`NOTICE`](./NOTICE) for attribution and the list of modifications applied
during the import.

## Status

Alpha. The Android client has feature parity with iOS as of upstream's parity
audit (24/32 iOS commits ported, see [`commit-to-plan-map.md`](./commit-to-plan-map.md)
and [`ios-android-parity-plan.md`](./ios-android-parity-plan.md)) **against the
upstream Codex-only bridge**.

Adapting the client to agnt's provider-agnostic protocol (Claude Code,
opencode, Cursor) is tracked in [`ROADMAP.md`](./ROADMAP.md). See
[`PARITY.md`](./PARITY.md) for the feature-parity matrix vs iOS / web.

The bridge is already client-agnostic, so this client connects to today's
agnt-bridge for the Codex provider. Codex-only RPCs are gated bridge-side and
return synthetic responses when the active provider is not Codex.

## Quickstart (developer build)

1. Install Android Studio (Hedgehog or newer) with Android SDK 36 / NDK as
   prompted. JDK 17 required.
2. Start the bridge and relay on your computer:

   ```sh
   cd ../agnt-bridge && npm start
   ```

   This prints a pairing QR.

3. Build and install the debug APK on a device or emulator:

   ```sh
   ./gradlew :app:installDebug
   ```

4. Launch the app, tap "Pair", scan the QR.

## Configuration

The optional default relay URL can be wired via a `<meta-data>` in
`app/src/main/AndroidManifest.xml` (key `AGNT_DEFAULT_RELAY_URL`). Leave it
commented for local-first / QR pairing. There is no production relay baked in.

## Protocol parity contract

Per `/CLAUDE.md`:

> The secure-transport must stay byte-for-byte aligned with
> `agnt-bridge/src/secure-transport.js`. Any change to transcript framing,
> nonce layout, or HKDF info must land in both modules in the same PR.

The same rule applies here. Constants in
`app/src/main/kotlin/com/dotbrains/agnt/mobile/core/model/SecureTransportModels.kt`
mirror the bridge constants — do not edit one without the other and without
updating `../agnt-web/src/crypto/transcript.ts`.

## Tests

```sh
./gradlew :app:testDebugUnitTest
```

## Build guardrails

- Do not run device/emulator tests unless requested.
- Do not introduce hosted-service URLs or single-provider couplings.
- Keep this module conformant to the provider-agnostic gates described in
  `/CLAUDE.md` ("Provider plugin guardrails").
