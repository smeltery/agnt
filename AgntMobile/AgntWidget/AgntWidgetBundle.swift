// FILE: AgntWidgetBundle.swift
// Purpose: Entry point for the agnt widget extension. Bundles together the
//          Lock Screen accessory widget and the iOS 18 Control Center
//          quick-launch control, both branded with the agnt outline mark.
// Layer: Widget Extension

import SwiftUI
import WidgetKit

@main
struct AgntWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        AgntLockScreenWidget()
        if #available(iOS 18.0, *) {
            AgntLaunchControl()
        }
    }
}
