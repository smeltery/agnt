// FILE: TurnTimelineScrollHelpers.swift
// Purpose: Provides scroll geometry, axis guard, and coalescing helpers for TurnTimelineView.
// Layer: View Support
// Exports: ScrollBottomGeometry, VerticalScrollAxisGuard, ScrollGeometryCoalescer, TurnTimelineWarmThreadCache, TurnFloatingButtonPressStyle, MainQueueUpdateCoalescer
// Depends on: SwiftUI, UIKit

import SwiftUI
import UIKit

struct ScrollBottomGeometry: Equatable {
    let isAtBottom: Bool
    let viewportHeight: CGFloat
    let contentHeight: CGFloat
}

// Pins SwiftUI's backing UIScrollView to the vertical axis when an oversized row
// briefly makes UIKit preserve a horizontal content offset.
struct VerticalScrollAxisGuard: UIViewRepresentable {
    func makeUIView(context: Context) -> VerticalScrollAxisGuardView {
        VerticalScrollAxisGuardView()
    }

    func updateUIView(_ uiView: VerticalScrollAxisGuardView, context: Context) {
        uiView.attachToNearestScrollViewIfNeeded()
    }
}

final class VerticalScrollAxisGuardView: UIView {
    private weak var guardedScrollView: UIScrollView?
    private var contentOffsetObservation: NSKeyValueObservation?
    private var boundsObservation: NSKeyValueObservation?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attachToNearestScrollViewIfNeeded()
    }

    func attachToNearestScrollViewIfNeeded() {
        guard let scrollView = enclosingScrollView(), guardedScrollView !== scrollView else {
            clampHorizontalOffset()
            return
        }

        guardedScrollView = scrollView
        scrollView.alwaysBounceHorizontal = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.isDirectionalLockEnabled = true

        contentOffsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            self?.clampHorizontalOffset()
        }
        boundsObservation = scrollView.observe(\.bounds, options: [.new]) { [weak self] _, _ in
            self?.clampHorizontalOffset()
        }
        clampHorizontalOffset()
    }

    private func enclosingScrollView() -> UIScrollView? {
        sequence(first: superview, next: { $0?.superview })
            .first { $0 is UIScrollView } as? UIScrollView
    }

    private func clampHorizontalOffset() {
        guard let scrollView = guardedScrollView else { return }
        let pinnedX = -scrollView.adjustedContentInset.left
        guard abs(scrollView.contentOffset.x - pinnedX) > 0.5 else { return }

        var offset = scrollView.contentOffset
        offset.x = pinnedX
        scrollView.setContentOffset(offset, animated: false)
    }
}

/// Batches rapid `onScrollGeometryChange` callbacks so at most one @State
/// commit reaches SwiftUI per runloop turn, preventing the
/// "tried to update multiple times per frame" cycling.
@MainActor
final class ScrollGeometryCoalescer {
    var pending: (old: ScrollBottomGeometry, new: ScrollBottomGeometry)?
    var isScheduled = false
}

@MainActor
enum TurnTimelineWarmThreadCache {
    private static let maxEntries = 3
    private static var recentThreadIDs: [String] = []

    static func contains(_ threadID: String) -> Bool {
        recentThreadIDs.contains(threadID)
    }

    static func remember(_ threadID: String) {
        recentThreadIDs.removeAll { $0 == threadID }
        recentThreadIDs.append(threadID)
        if recentThreadIDs.count > maxEntries {
            recentThreadIDs.removeFirst(recentThreadIDs.count - maxEntries)
        }
    }
}

struct TurnFloatingButtonPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// Coalesces high-frequency observer callbacks without mutating SwiftUI state from onChange.
final class MainQueueUpdateCoalescer {
    private var isScheduled = false
    private var pendingAction: (() -> Void)?

    func schedule(_ action: @escaping () -> Void) {
        pendingAction = action
        guard !isScheduled else { return }
        isScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let action = pendingAction
            pendingAction = nil
            isScheduled = false
            action?()
        }
    }
}
