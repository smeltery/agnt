// FILE: AgntLaunchIntent.swift
// Purpose: OpenIntent used by the Control Center quick-launch button to bring
//          agnt to the foreground. This file is compiled into both the app and
//          widget targets because Control Widgets require that membership
//          before an intent can open the parent app.
// Layer: Widget Extension

import AppIntents

enum AgntLaunchTarget: String, AppEnum {
    case home

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "agnt")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .home: "agnt"
    ]
}

struct AgntLaunchIntent: OpenIntent {
    static var title: LocalizedStringResource = "Open agnt"
    static var description = IntentDescription("Brings agnt to the foreground.")

    @Parameter(title: "Target")
    var target: AgntLaunchTarget

    init() {
        self.target = .home
    }

    init(target: AgntLaunchTarget) {
        self.target = target
    }
}
