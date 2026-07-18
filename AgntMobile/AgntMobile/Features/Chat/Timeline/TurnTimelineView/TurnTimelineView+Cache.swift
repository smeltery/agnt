import SwiftUI

extension TurnTimelineView {
    var visibleMessages: ArraySlice<CodexMessage> {
        let startIndex = max(messages.count - visibleTailCount, 0)
        return messages[startIndex...]
    }

    // Catches delayed tail updates without hashing the whole render window each body pass.
    var visibleMessagesBoundarySignature: Int {
        let visibleSlice = visibleMessages
        var hasher = Hasher()
        hasher.combine(threadID)
        hasher.combine(visibleTailCount)
        hasher.combine(visibleSlice.count)
        if let message = visibleSlice.first {
            hasher.combine(message.id)
            hasher.combine(message.orderIndex)
        }
        if let message = visibleSlice.last {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.kind)
            hasher.combine(message.turnId)
            hasher.combine(message.deliveryState)
            hasher.combine(message.isStreaming)
            hasher.combine(message.orderIndex)
        }
        return hasher.finalize()
    }

    // Renders appended/removed rows immediately if SwiftUI reaches body before the
    // lifecycle cache refresh. Assistant text-only deltas still use the cached rows.
    var visibleRenderItems: [TurnTimelineRenderItem] {
        let visibleSlice = visibleMessages
        guard renderItemsShapeSignature(for: visibleSlice) != cachedRenderItemsShapeSignature else {
            return cachedRenderItems
        }
        return TurnTimelineRenderProjection.project(
            messages: Array(visibleSlice),
            completedTurnIDs: completedTurnIDs,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning
        )
    }

    // Mirrors visibleMessagesBoundarySignature shape but adds the projection inputs
    // so a body-time fallback can stay synchronous without rehashing streaming text.
    func renderItemsShapeSignature(for messages: ArraySlice<CodexMessage>) -> Int {
        var hasher = Hasher()
        hasher.combine(threadID)
        hasher.combine(visibleTailCount)
        hasher.combine(messages.count)
        hasher.combine(activeTurnID)
        hasher.combine(isThreadRunning)
        hasher.combine(completedTurnIDs)

        if let message = messages.first {
            hasher.combine(message.id)
            hasher.combine(message.orderIndex)
        }

        if let message = messages.last {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.kind)
            hasher.combine(message.turnId)
            hasher.combine(message.deliveryState)
            hasher.combine(message.isStreaming)
            hasher.combine(message.orderIndex)
        }

        return hasher.finalize()
    }

    var hasEarlierMessages: Bool {
        visibleTailCount < messages.count
    }

    var shouldWarmRecentTailProgressively: Bool {
        isProgressivelyRevealingRecentTail
            && messages.count > visibleTailCount
    }

    var isRecentTailWarmupActive: Bool {
        shouldStageHeavyThreadOpen
            && visibleTailCount < min(messages.count, Self.pageSize)
    }

    var shouldShowFullTimelineLoader: Bool {
        shouldWarmRecentTailProgressively && visibleTailCount == 0
    }

    // Keeps larger accessibility text inside a slightly roomier gutter so assistant
    // prose does not read as edge-to-edge when Dynamic Type is bumped up.
    var timelineHorizontalPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 20 : 16
    }

    var shouldStageHeavyThreadOpen: Bool {
        false
    }

    var planMatchingFingerprint: Int {
        var hasher = Hasher()
        for message in threadMessagesForPlanMatching where message.kind == .userInputPrompt {
            hasher.combine(message.id)
            hasher.combine(message.turnId)
            hasher.combine(message.orderIndex)
            hasher.combine(message.structuredUserInputRequest?.requestID)
            hasher.combine(message.structuredUserInputRequest?.questions)
        }
        return hasher.finalize()
    }

    func renderItemsInputKey(for messages: ArraySlice<CodexMessage>) -> Int {
        var hasher = Hasher()
        hasher.combine(messages.count)
        hasher.combine(activeTurnID)
        hasher.combine(isThreadRunning)
        hasher.combine(completedTurnIDs)
        for message in messages {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.kind)
            hasher.combine(message.turnId)
            hasher.combine(message.itemId)
            hasher.combine(message.isStreaming)
            hasher.combine(message.deliveryState)
            hasher.combine(message.orderIndex)
            hasher.combine(message.attachments)
            hasher.combine(message.planState)
            hasher.combine(message.planPresentation)
            hasher.combine(message.proposedPlan)
            hasher.combine(message.subagentAction)
            hasher.combine(message.structuredUserInputRequest)
            // Streaming prose only appends during live output; length is enough to
            // invalidate the projected row without rehashing the full transcript text.
            if message.isStreaming {
                hasher.combine(message.text.count)
            } else {
                hasher.combine(message.text)
            }
        }
        return hasher.finalize()
    }
}
