// FILE: StreamingUIInteractionMonitor.swift
// Purpose: Tracks live UI interaction so heavy streaming rows can back off briefly.
// Layer: Service Support
// Exports: StreamingUIInteractionMonitor
// Depends on: Foundation

import Foundation

@MainActor
enum StreamingUIInteractionMonitor {
    static let composerTypingActivityWindow: TimeInterval = 0.75

    private(set) static var isScrollInteractionActive = false
    private static var lastComposerKeystrokeAt: Date?

    static func setScrollInteractionActive(_ active: Bool) {
        isScrollInteractionActive = active
    }

    static func noteComposerKeystroke(now: Date = Date()) {
        lastComposerKeystrokeAt = now
    }

    static func isInteractionActive(now: Date = Date()) -> Bool {
        if isScrollInteractionActive {
            return true
        }

        guard let lastComposerKeystrokeAt else {
            return false
        }
        return now.timeIntervalSince(lastComposerKeystrokeAt) < composerTypingActivityWindow
    }
}
