import SwiftUI

extension TurnTimelineView {
    var shouldShowScrollToLatestButton: Bool {
        TurnScrollStateTracker.shouldShowScrollToLatestButton(
            messageCount: messages.count,
            isScrolledToBottom: isScrolledToBottom
        )
    }

    var initialScrollAnchor: UnitPoint {
        .bottom
    }

    var shouldShowPendingAssistantResponse: Bool {
        TurnTimelinePendingAssistantState.isWaitingForAssistantResponse(
            shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponse,
            messages: messages
        )
    }

    // Scroll geometry resumes after the optimistic send gap and assistant anchor settle.
    var shouldTrackScrollGeometry: Bool {
        TurnTimelinePendingAssistantState.shouldTrackScrollGeometry(
            shouldAnchorToAssistantResponse: shouldAnchorToAssistantResponse,
            autoScrollMode: autoScrollMode,
            isWaitingForAssistantResponse: shouldShowPendingAssistantResponse
        )
    }

    func handleLoadEarlierMessages() {
        progressiveTailRevealTask?.cancel()
        progressiveTailRevealTask = nil
        isProgressivelyRevealingRecentTail = false
        withAnimation(.easeOut(duration: 0.15)) {
            visibleTailCount = min(visibleTailCount + Self.pageSize, messages.count)
        }
    }

    func handleScrollToLatestButtonTap(using proxy: ScrollViewProxy) {
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        shouldAnchorToAssistantResponse = false
        autoScrollMode = .followBottom
        initialRecoverySnapPendingThreadID = nil
        isUserDraggingScroll = false
        userScrollCooldownUntil = nil
        pendingAssistantBottomSnapTask?.cancel()
        pendingAssistantBottomSnapTask = nil
        scrollToBottom(using: proxy, animated: true)
    }

    // Resets per-thread scroll intent so each opened conversation gets one fresh
    // post-layout recovery snap and starts in bottom-follow mode.
    func beginScrollSessionIfNeeded(force: Bool = false) {
        guard force || scrollSessionThreadID != threadID else { return }

        cancelScrollTasks()
        scrollSessionThreadID = threadID
        visibleTailCount = shouldStageHeavyThreadOpen
            ? Self.initialWarmTailCount
            : min(messages.count, Self.pageSize)
        isScrolledToBottom = true
        isUserDraggingScroll = false
        userScrollCooldownUntil = nil
        autoScrollMode = shouldAnchorToAssistantResponse ? .anchorAssistantResponse : .followBottom
        initialRecoverySnapPendingThreadID = shouldAnchorToAssistantResponse ? nil : threadID
        isProgressivelyRevealingRecentTail = shouldStageHeavyThreadOpen
    }

    // Cancels any delayed scroll work so old thread sessions cannot move the new one.
    func cancelScrollTasks() {
        initialRecoverySnapTask?.cancel()
        initialRecoverySnapTask = nil
        followBottomScrollTask?.cancel()
        followBottomScrollTask = nil
        pendingAssistantBottomSnapTask?.cancel()
        pendingAssistantBottomSnapTask = nil
        progressiveTailRevealTask?.cancel()
        progressiveTailRevealTask = nil
        isProgressivelyRevealingRecentTail = false
    }

    // Stages the recent tail for heavy chats so thread switches avoid building dozens
    // of rich markdown rows in one main-thread burst. The last 3 opened chats stay warm.
    func scheduleProgressiveTailRevealIfNeeded() {
        let targetTailCount = min(messages.count, Self.pageSize)

        guard targetTailCount > 0 else {
            return
        }

        guard shouldStageHeavyThreadOpen else {
            if visibleTailCount < targetTailCount {
                visibleTailCount = targetTailCount
            }
            if messages.count > Self.pageSize {
                TurnTimelineWarmThreadCache.remember(threadID)
            }
            isProgressivelyRevealingRecentTail = false
            return
        }

        guard isScrolledToBottom,
              !shouldPauseAutomaticScrolling,
              autoScrollMode == .followBottom else {
            isProgressivelyRevealingRecentTail = false
            progressiveTailRevealTask?.cancel()
            progressiveTailRevealTask = nil
            return
        }

        guard !TurnTimelineWarmThreadCache.contains(threadID) else {
            if visibleTailCount < targetTailCount {
                visibleTailCount = targetTailCount
            }
            isProgressivelyRevealingRecentTail = false
            return
        }

        guard visibleTailCount < targetTailCount else {
            TurnTimelineWarmThreadCache.remember(threadID)
            isProgressivelyRevealingRecentTail = false
            return
        }

        guard progressiveTailRevealTask == nil else { return }

        let expectedThreadID = threadID

        isProgressivelyRevealingRecentTail = true
        progressiveTailRevealTask = Task { @MainActor in
            defer {
                if scrollSessionThreadID == expectedThreadID {
                    isProgressivelyRevealingRecentTail = false
                }
                progressiveTailRevealTask = nil
            }

            try? await Task.sleep(nanoseconds: 35_000_000)

            guard !Task.isCancelled,
                  scrollSessionThreadID == expectedThreadID,
                  isScrolledToBottom,
                  !shouldPauseAutomaticScrolling,
                  autoScrollMode == .followBottom else {
                return
            }

            let liveTargetTailCount = min(messages.count, Self.pageSize)
            if visibleTailCount < liveTargetTailCount {
                visibleTailCount = liveTargetTailCount
            }
            TurnTimelineWarmThreadCache.remember(expectedThreadID)
        }
    }
}
