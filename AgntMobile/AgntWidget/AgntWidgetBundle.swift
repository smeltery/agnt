// FILE: AgntWidgetBundle.swift
// Purpose: Entry point for the agnt widget extension. Bundles together the
//          Lock Screen accessory widget, the iOS 18 Control Center quick-launch
//          control, and the Live Activity / Dynamic Island that surfaces an
//          in-flight agnt turn.
// Layer: Widget Extension

import SwiftUI
import WidgetKit

@main
struct AgntWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        AgntLockScreenWidget()
        AgntLiveActivity()
        if #available(iOS 18.0, *) {
            AgntLaunchControl()
        }
    }
}
