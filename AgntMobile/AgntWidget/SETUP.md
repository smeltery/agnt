# AgntWidget — Widget Extension target

The `AgntWidget` WidgetKit extension target **is now registered** in
`AgntMobile.xcodeproj`. The sources, asset catalog, `Info.plist`, and
entitlements in this directory build into it. No manual Xcode setup is required;
the steps that used to live here have been applied to `project.pbxproj`.

The target ships three things:

1. **Lock Screen accessory widget** (`accessoryCircular` / `accessoryRectangular`
   / `accessoryInline`) — static branding / quick launch.
2. **iOS 18 Control Center launch button** (`ControlWidget`).
3. **Live Activity / Dynamic Island** (`AgntLiveActivity`) — surfaces an in-flight
   agnt turn (running / done / stopped) on the Lock Screen banner and Dynamic
   Island. Driven by the app via local ActivityKit updates.

## What's in this directory

| File | Target membership | Purpose |
| --- | --- | --- |
| `AgntWidgetBundle.swift` | widget | `@main WidgetBundle` — Lock Screen widget, Live Activity, (iOS 18) Control Center control. |
| `AgntLockScreenWidget.swift` | widget | Lock Screen accessory widget. |
| `AgntControlCenterWidget.swift` | widget | iOS 18 `ControlWidget` launch button. |
| `AgntLiveActivity.swift` | widget | `ActivityConfiguration` — Lock Screen banner + Dynamic Island (expanded / compact / minimal). |
| `AgntActivityAttributes.swift` | **widget + app** | Shared Live Activity contract. Must compile into both targets so ActivityKit matches the type. |
| `AgntLaunchIntent.swift` | **widget + app** | `OpenIntent` that foregrounds the app. Control Widget `OpenIntent`s must be in the parent app too. |
| `Assets.xcassets` | widget | Self-contained copy of the agnt glyphs (an extension can't read the host app's bundle at runtime). |
| `Info.plist` | widget | `NSExtensionPointIdentifier = com.apple.widgetkit-extension`. |
| `AgntWidget.entitlements` | widget | Empty — local Live Activity updates need no App Group. |

## How the Live Activity is driven (app side)

- `AgntMobile/Services/LiveActivity/LiveActivityCoordinator.swift` owns at most
  one `Activity<AgntActivityAttributes>` and starts / updates / ends it.
- `AgntMobile/Services/LiveActivity/CodexService+LiveActivity.swift` maps a
  thread's "turn active" edge to the coordinator and resolves a display title.
- `CodexService.setActiveTurnID(_:for:)` calls `syncLiveActivity(...)` only on the
  active/idle transition, so there is exactly one start and one end per turn.
- `BuildSupport/AgntMobile-Info.plist` carries `NSSupportsLiveActivities = true`.

## Build settings reference (already applied)

- `PRODUCT_BUNDLE_IDENTIFIER = com.dotbrains.agnt.AgntMobile.AgntWidget`
  (`<mainAppBundleId>.AgntWidget`; matches the `static let kind` prefixes).
- `IPHONEOS_DEPLOYMENT_TARGET = 18.6` (matches the app target).
- `INFOPLIST_FILE = AgntWidget/Info.plist`,
  `CODE_SIGN_ENTITLEMENTS = AgntWidget/AgntWidget.entitlements`.
- Same `DEVELOPMENT_TEAM` as the app; `SKIP_INSTALL = YES`.
- Embedded into `AgntMobile` via an "Embed Foundation Extensions" copy phase;
  `AgntMobile` depends on `AgntWidget` so the extension builds first.

## Notes

- Fully local / provider-agnostic: the Live Activity shows only a coarse turn
  phase plus a generic status line and the thread title. It carries no provider
  identity, session ids, prompt text, or other bearer-like values, and makes no
  network calls (local ActivityKit updates only — no push token).
- If you later want push-updated activities, add an App Group + a push token
  channel; today none is needed.
- This target has not been compiled here. Build `AgntMobile` in Xcode once to
  confirm the extension links and the Live Activity renders. The `kind` strings,
  `Info.plist`, and entitlements are unchanged from the verified PR #107 widget.
