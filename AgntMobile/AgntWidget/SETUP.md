# AgntWidget — Xcode target setup

The Swift sources, asset catalog, `Info.plist`, and entitlements in this
directory are ready to drop into a WidgetKit extension target, but the target
itself is **not** registered in `AgntMobile.xcodeproj`. The project currently
has no app-extension target (only the app, unit-test, UI-test, and menu-bar
products), and a WidgetKit target cannot be created or verified headlessly, so
registration is a manual follow-up in Xcode.

This is a static branding / quick-launch widget: three Lock Screen accessory
families plus an iOS 18 Control Center launch button. No live status, no
network, no App Group.

## What's in this directory

| File | Purpose |
| --- | --- |
| `AgntWidgetBundle.swift` | `@main WidgetBundle` — Lock Screen widget + (iOS 18) Control Center control. |
| `AgntLockScreenWidget.swift` | `accessoryCircular` / `accessoryRectangular` / `accessoryInline` accessory widget. |
| `AgntControlCenterWidget.swift` | iOS 18 `ControlWidget` launch button. |
| `AgntLaunchIntent.swift` | `OpenIntent` that foregrounds the app. Must be a member of **both** the widget target and the app target. |
| `Assets.xcassets` | Self-contained copy of the agnt glyph assets (`agnt_symbol_medium`, `agnt_control_symbol`, `agnt-outline`). An extension can't read the host app's asset bundle at runtime, so it carries its own. |
| `Info.plist` | `NSExtensionPointIdentifier = com.apple.widgetkit-extension`. |
| `AgntWidget.entitlements` | Empty placeholder (no App Group needed for a static widget). |

## Steps in Xcode

1. **Add the target.** File ▸ New ▸ Target ▸ **Widget Extension**.
   - Product Name: `AgntWidget`
   - Uncheck "Include Configuration App Intent" (this widget uses a static
     configuration; the AppIntent here is only for the Control Center launch).
   - Embed in application: `AgntMobile`.
   - Let Xcode generate the stub group, then delete the stub `.swift`,
     `Info.plist`, and `Assets.xcassets` it creates — you will point the target
     at the files already in this directory instead.

2. **Bundle identifier.** Set the new target's `PRODUCT_BUNDLE_IDENTIFIER` to:
   ```
   com.dotbrains.agnt.AgntMobile.AgntWidget
   ```
   (Main app is `com.dotbrains.agnt.AgntMobile`; the widget id is
   `<mainAppBundleId>.AgntWidget`. This must match the `static let kind`
   prefixes in the Swift sources.)

3. **Deployment target.** Set `IPHONEOS_DEPLOYMENT_TARGET = 18.6` to match the
   `AgntMobile` app target. (The Control Center control is additionally gated
   behind `#available(iOS 18.0, *)` in code, so it activates only on iOS 18+.)

4. **Add the source files to the target.** Add to the **AgntWidget** target:
   - `AgntWidgetBundle.swift`
   - `AgntLockScreenWidget.swift`
   - `AgntControlCenterWidget.swift`
   - `AgntLaunchIntent.swift`
   - `Assets.xcassets`

5. **Shared intent membership.** Also add `AgntLaunchIntent.swift` to the
   **AgntMobile** app target (Target Membership checkbox). Control Widget
   `OpenIntent`s must be compiled into the parent app for the launch action to
   resolve.

6. **Info.plist & entitlements.** In the AgntWidget target's Build Settings:
   - `INFOPLIST_FILE = AgntWidget/Info.plist`
   - `CODE_SIGN_ENTITLEMENTS = AgntWidget/AgntWidget.entitlements`
   Confirm `Info.plist` carries
   `NSExtension ▸ NSExtensionPointIdentifier = com.apple.widgetkit-extension`
   (already present in the committed plist).

7. **Signing.** Use the same team as `AgntMobile`. No App Group capability is
   required for this static widget; the entitlements file is intentionally
   empty.

8. **Embed & verify.** Ensure the extension appears under the app target's
   "Frameworks, Libraries, and Embedded Content" (Xcode adds this when you embed
   in step 1). Build and run; the widget should appear in the Lock Screen
   accessory gallery and, on iOS 18+, the Control Center Controls gallery.

## Notes

- Fully local / provider-agnostic: the widget only launches the app and shows
  branding. It performs no network calls and references no provider-specific
  copy.
- If you later need the widget and app to share data (not required today),
  add an `App Group` capability to both targets and populate
  `AgntWidget.entitlements` accordingly.
