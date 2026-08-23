// FILE: AgntControlCenterWidget.swift
// Purpose: iOS 18 Control Center widget that adds an agnt quick-launch button
//          to the Controls Gallery. Tapping the button triggers
//          `AgntLaunchIntent`, which brings the agnt app to the foreground.
// Layer: Widget Extension

import AppIntents
import SwiftUI
import WidgetKit

@available(iOS 18.0, *)
struct AgntLaunchControl: ControlWidget {
    static let kind = "com.smeltery.agnt.AgntMobile.AgntWidget.LaunchControl.v1"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: AgntLaunchIntent()) {
                // Control Center only accepts symbol images, so this routes
                // through the control-sized agnt symbolset.
                Label("agnt", image: "agnt_control_symbol")
            }
        }
        .displayName("agnt")
        .description("Launch agnt from Control Center.")
    }
}
