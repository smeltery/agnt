import SwiftUI

extension TurnTimelineView {
    // Stops follow-bottom as soon as the user drags away so queued snaps cannot fight the gesture.
    func handleScrolledToBottomChanged(_ nextValue: Bool) {
        guard nextValue != isScrolledToBottom else { return }

        // Ignore transient "not at bottom" geometry while a newly selected chat is still
        // performing its initial recovery snap, otherwise fast chat switches can downgrade
        // follow-bottom to manual before the first bottom jump lands.
        if !nextValue,
           initialRecoverySnapPendingThreadID == threadID,
           autoScrollMode == .followBottom {
            return
        }

        if isProgressivelyRevealingRecentTail,
           autoScrollMode == .followBottom,
           !nextValue {
            return
        }

        // Content growth can briefly report "not bottom" before the queued
        // follow snap lands; only user scroll phases should make that visible.
        if !nextValue,
           TurnScrollStateTracker.shouldIgnoreTransientNotBottomGeometry(
            currentMode: autoScrollMode,
            hasPendingFollowBottomScroll: followBottomScrollTask != nil,
            isAutomaticScrollingPaused: shouldPauseAutomaticScrolling
           ) {
            return
        }

        if !nextValue {
            // Cancel queued app snaps once geometry confirms the viewport is away
            // from bottom; transient content-growth frames are filtered above.
            followBottomScrollTask?.cancel()
            followBottomScrollTask = nil
            progressiveTailRevealTask?.cancel()
            progressiveTailRevealTask = nil
            isProgressivelyRevealingRecentTail = false
        }

        isScrolledToBottom = nextValue
        if nextValue {
            if autoScrollMode != .anchorAssistantResponse {
                autoScrollMode = .followBottom
            }
            scheduleProgressiveTailRevealIfNeeded()
        } else {
            autoScrollMode = TurnScrollStateTracker.modeAfterAcceptedNotBottomGeometry(
                currentMode: autoScrollMode
            )
        }
    }

    // Gives user drag intent precedence over follow-bottom so streaming never wrestles the scroll gesture.
    func handleUserScrollDragChanged() {
        guard !isUserDraggingScroll else { return }
        isUserDraggingScroll = true
        userScrollCooldownUntil = nil
        followBottomScrollTask?.cancel()
        followBottomScrollTask = nil
        pendingAssistantBottomSnapTask?.cancel()
        pendingAssistantBottomSnapTask = nil
        progressiveTailRevealTask?.cancel()
        progressiveTailRevealTask = nil
        isProgressivelyRevealingRecentTail = false
        autoScrollMode = TurnScrollStateTracker.modeAfterUserDragBegan(currentMode: autoScrollMode)
    }

    // Preserves user-controlled deceleration for a short cooldown before auto-follow can resume.
    func handleUserScrollDragEnded() {
        isUserDraggingScroll = false
        userScrollCooldownUntil = TurnScrollStateTracker.cooldownDeadline()
        autoScrollMode = TurnScrollStateTracker.modeAfterUserDragEnded(
            currentMode: autoScrollMode,
            isScrolledToBottom: isScrolledToBottom
        )
    }

    // Mirrors user-driven scroll phases without pausing auto-follow during programmatic animations.
    func handleScrollPhaseChange(from oldPhase: ScrollPhase, to newPhase: ScrollPhase) {
        updateStreamingInteractionMonitor(from: oldPhase, to: newPhase)
        switch newPhase {
        case .tracking, .interacting:
            handleUserScrollDragChanged()
        case .decelerating:
            let wasUserTouchingScroll = oldPhase == .tracking || oldPhase == .interacting
            if wasUserTouchingScroll {
                handleUserScrollDragEnded()
            }
        case .idle:
            let wasUserTouchingScroll = oldPhase == .tracking || oldPhase == .interacting
            if wasUserTouchingScroll {
                handleUserScrollDragEnded()
            }
        case .animating:
            return
        @unknown default:
            return
        }
    }

    // Heavy streaming row flushes back off while a user drag/flick owns the main thread.
    // Deceleration keeps the backoff; programmatic animations and idle release it.
    func updateStreamingInteractionMonitor(from oldPhase: ScrollPhase, to newPhase: ScrollPhase) {
        switch newPhase {
        case .tracking, .interacting:
            StreamingUIInteractionMonitor.setScrollInteractionActive(true)
        case .decelerating:
            let wasUserTouchingScroll = oldPhase == .tracking || oldPhase == .interacting
            if !wasUserTouchingScroll {
                StreamingUIInteractionMonitor.setScrollInteractionActive(false)
            }
        case .idle, .animating:
            StreamingUIInteractionMonitor.setScrollInteractionActive(false)
        @unknown default:
            StreamingUIInteractionMonitor.setScrollInteractionActive(false)
        }
    }

    // Repairs the initial white/blank viewport race by snapping to bottom multiple
    // times with increasing delays until the full VStack layout has settled.
    func performInitialRecoverySnapIfNeeded(using proxy: ScrollViewProxy) {
        guard initialRecoverySnapPendingThreadID == threadID,
              initialRecoverySnapTask == nil,
              !messages.isEmpty,
              viewportHeight > 0,
              autoScrollMode == .followBottom,
              !shouldPauseAutomaticScrolling,
              !shouldAnchorToAssistantResponse else {
            return
        }

        let expectedThreadID = threadID
        // Delays in nanoseconds: yield, 16ms, 50ms, 100ms — covers typical layout settle times.
        let snapDelays: [UInt64] = [0, 16_000_000, 50_000_000, 100_000_000]
        initialRecoverySnapTask = Task { @MainActor in
            for delay in snapDelays {
                if delay == 0 {
                    await Task.yield()
                } else {
                    try? await Task.sleep(nanoseconds: delay)
                }

                guard !Task.isCancelled,
                      initialRecoverySnapPendingThreadID == expectedThreadID,
                      scrollSessionThreadID == expectedThreadID,
                      !messages.isEmpty,
                      viewportHeight > 0,
                      autoScrollMode == .followBottom,
                      !shouldPauseAutomaticScrolling,
                      !shouldAnchorToAssistantResponse else {
                    break
                }

                scrollToBottom(using: proxy, animated: false)
            }
            initialRecoverySnapPendingThreadID = nil
            initialRecoverySnapTask = nil
        }
    }

    func anchorToAssistantResponseIfNeeded(using proxy: ScrollViewProxy) -> Bool {
        guard shouldAnchorToAssistantResponse,
              let assistantMessageID = TurnTimelineReducer.assistantResponseAnchorMessageID(
                in: Array(visibleMessages),
                activeTurnID: activeTurnID
              ) else {
            return false
        }

        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(assistantMessageID, anchor: .top)
        }
        // Break the .onChange chain by deferring the binding write to avoid
        // AttributeGraph cycles when the parent re-renders in response.
        DispatchQueue.main.async {
            shouldAnchorToAssistantResponse = false
        }
        autoScrollMode = .followBottom
        initialRecoverySnapPendingThreadID = nil
        pendingAssistantBottomSnapTask?.cancel()
        pendingAssistantBottomSnapTask = nil
        return true
    }

    // Keep mutation handling narrow so scroll geometry remains the follow-bottom source of truth.
    func handleTimelineMutation(using proxy: ScrollViewProxy) {
        guard !shouldPauseAutomaticScrolling else { return }
        performInitialRecoverySnapIfNeeded(using: proxy)

        if autoScrollMode == .anchorAssistantResponse {
            if !anchorToAssistantResponseIfNeeded(using: proxy),
               shouldShowPendingAssistantResponse {
                // The assistant row does not exist yet; keep the optimistic user
                // bubble and pending thinking indicator anchored at the bottom.
                schedulePendingAssistantBottomSnap(using: proxy)
            }
        }
    }

    // The user row and sticky thinking indicator can appear one layout pass before the
    // assistant row exists; defer the bottom snap until that provisional stack is measurable.
    func schedulePendingAssistantBottomSnap(using proxy: ScrollViewProxy) {
        guard pendingAssistantBottomSnapTask == nil else { return }
        let expectedThreadID = threadID
        let snapDelays: [UInt64] = [0, 16_000_000, 50_000_000]
        pendingAssistantBottomSnapTask = Task { @MainActor in
            defer { pendingAssistantBottomSnapTask = nil }
            for delay in snapDelays {
                if delay == 0 {
                    await Task.yield()
                } else {
                    try? await Task.sleep(nanoseconds: delay)
                }

                guard !Task.isCancelled,
                      scrollSessionThreadID == expectedThreadID,
                      autoScrollMode == .anchorAssistantResponse,
                      shouldShowPendingAssistantResponse,
                      !shouldPauseAutomaticScrolling else {
                    return
                }

                scrollToBottom(using: proxy, animated: delay != 0)
            }
        }
    }

    /// Coalesces rapid follow-bottom scrolls into at most one per display frame,
    /// preventing discrete jumps on every streaming delta.
    func scheduleFollowBottomScroll(using proxy: ScrollViewProxy) {
        guard followBottomScrollTask == nil else { return }
        let expectedThreadID = threadID
        followBottomScrollTask = Task { @MainActor in
            defer { followBottomScrollTask = nil }
            try? await Task.sleep(nanoseconds: 16_000_000) // ~1 display frame
            guard !Task.isCancelled,
                  scrollSessionThreadID == expectedThreadID,
                  !shouldPauseAutomaticScrolling else {
                return
            }
            guard autoScrollMode == .followBottom || shouldPinTimelineToBottomDuringGeometryChange else {
                return
            }
            proxy.scrollTo(scrollBottomAnchorID, anchor: .bottom)
        }
    }

    var shouldPauseAutomaticScrolling: Bool {
        TurnScrollStateTracker.isAutomaticScrollingPaused(
            isUserDragging: isUserDraggingScroll,
            cooldownUntil: userScrollCooldownUntil
        )
    }

    // Follow-bottom owns bottom pinning; assistant anchoring waits for a real assistant row
    // so a new chat's first user bubble is not snapped around by geometry changes.
    var shouldPinTimelineToBottomDuringGeometryChange: Bool {
        return TurnScrollStateTracker.shouldPinDuringGeometryChange(
            currentMode: autoScrollMode,
            isAutomaticScrollingPaused: shouldPauseAutomaticScrolling
        )
    }
}
