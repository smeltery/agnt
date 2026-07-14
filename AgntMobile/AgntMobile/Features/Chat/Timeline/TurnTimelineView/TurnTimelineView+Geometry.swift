import SwiftUI

extension TurnTimelineView {
    // Scrolls to the bottom sentinel; used by manual jump button and initial recovery snap.
    // Streaming follow-bottom uses the throttled scheduleFollowBottomScroll instead.
    func scrollToBottom(using proxy: ScrollViewProxy, animated: Bool) {
        guard !messages.isEmpty else { return }

        if animated {
            withAnimation(.easeInOut(duration: 0.2)) {
                proxy.scrollTo(scrollBottomAnchorID, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(scrollBottomAnchorID, anchor: .bottom)
        }
    }

    /// Single deferred commit for all scroll-geometry–driven state changes.
    /// Called once per runloop turn by the coalescer.
    func applyScrollGeometryUpdate(
        old: ScrollBottomGeometry,
        new: ScrollBottomGeometry,
        using proxy: ScrollViewProxy
    ) {
        let isSuppressingBottomCorrectionsForWarmup = isRecentTailWarmupActive
            && autoScrollMode == .followBottom
        let viewportHeightChanged = new.viewportHeight > 0
            && abs(new.viewportHeight - old.viewportHeight) > 2
        let shouldPinToBottom = shouldPinTimelineToBottomDuringGeometryChange
        let shouldScheduleFollowBottom = viewportHeightChanged
            && shouldPinToBottom
            && !isSuppressingBottomCorrectionsForWarmup
        let shouldCorrectForContentHeight = !isSuppressingBottomCorrectionsForWarmup
            && TurnScrollStateTracker.shouldCorrectBottomAfterContentHeightChange(
                previousHeight: old.contentHeight,
                newHeight: new.contentHeight,
                isPinnedToBottom: shouldPinToBottom
            )
        let bottomChanged = new.isAtBottom != old.isAtBottom
            && !(isSuppressingBottomCorrectionsForWarmup && !new.isAtBottom)
        let nextViewportHeight = new.viewportHeight

        Task { @MainActor in
            if nextViewportHeight > 0, abs(nextViewportHeight - viewportHeight) > 1 {
                viewportHeight = nextViewportHeight
                performInitialRecoverySnapIfNeeded(using: proxy)
            }
            if shouldScheduleFollowBottom || shouldCorrectForContentHeight {
                scheduleFollowBottomScroll(using: proxy)
            }
            if bottomChanged {
                handleScrolledToBottomChanged(new.isAtBottom)
            }
        }
        debugTimelineLog(
            "applyScrollGeometryUpdate oldBottom=\(old.isAtBottom) newBottom=\(new.isAtBottom) "
                + "oldViewport=\(Int(old.viewportHeight)) newViewport=\(Int(new.viewportHeight)) "
                + "oldContent=\(Int(old.contentHeight)) newContent=\(Int(new.contentHeight)) "
                + "pinned=\(shouldPinTimelineToBottomDuringGeometryChange) "
                + "warmupSuppressed=\(isSuppressingBottomCorrectionsForWarmup) "
                + "userDragging=\(isUserDraggingScroll)"
        )
    }

    func logTimelineGeometryChangeIfNeeded(old: ScrollBottomGeometry, new: ScrollBottomGeometry) {
        let delta = max(
            abs(new.contentHeight - old.contentHeight),
            abs(new.viewportHeight - old.viewportHeight)
        )
        let bucket = Int(delta / 20)
        guard bucket != lastTimelineGeometryLogBucket || new.isAtBottom != old.isAtBottom else {
            return
        }
        lastTimelineGeometryLogBucket = bucket
        debugTimelineLog(
            "geometry changed bucket=\(bucket) oldBottom=\(old.isAtBottom) newBottom=\(new.isAtBottom) "
                + "contentDelta=\(Int(new.contentHeight - old.contentHeight)) "
                + "viewportDelta=\(Int(new.viewportHeight - old.viewportHeight))"
        )
    }

    // Scroll callbacks hit this often; keep logging fully lazy and non-mutating.
    func debugTimelineLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isTimelineDebugLoggingEnabled else { return }
        print("[TimelineDebug] \(message())")
        #endif
    }
}

extension TurnTimelineView {
    static var isTimelineDebugLoggingEnabled: Bool { false }
}
