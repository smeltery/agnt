// FILE: CodexService+MessageTimeline.swift
// Purpose: Owns streaming delta buffering and timeline projection helpers.
// Layer: Service
// Exports: CodexService message timeline helpers
// Depends on: CodexMessage, TurnTimelineReducer

import Foundation
import UIKit

extension CodexService {
    func enqueueAssistantDelta(
        threadId: String,
        turnId: String,
        itemId: String?,
        assistantPhase: String? = nil,
        delta: String
    ) {
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let normalizedPhase = normalizedAssistantPhase(assistantPhase)
        let streamID = assistantDeltaStreamID(threadId: threadId, turnId: turnId, itemId: normalizedItemId)

        if normalizedItemId != nil {
            migratePendingTurnFallbackDelta(
                threadId: threadId,
                turnId: turnId,
                destinationStreamID: streamID,
                normalizedItemId: normalizedItemId
            )
        }

        pendingAssistantDeltaContextByStreamID[streamID] = (
            threadId: threadId,
            turnId: turnId.trimmingCharacters(in: .whitespacesAndNewlines),
            itemId: normalizedItemId,
            assistantPhase: normalizedPhase,
            isReplayed: isApplyingReplayedBridgeEvent
        )
        if pendingAssistantDeltaByStreamID[streamID] == nil,
           !pendingAssistantDeltaStreamOrder.contains(streamID) {
            pendingAssistantDeltaStreamOrder.append(streamID)
        }
        pendingAssistantDeltaByStreamID[streamID] = mergeAssistantDelta(
            existingText: pendingAssistantDeltaByStreamID[streamID] ?? "",
            incomingDelta: delta
        )
        schedulePendingAssistantDeltaFlushIfNeeded()
    }

    private func migratePendingTurnFallbackDelta(
        threadId: String,
        turnId: String,
        destinationStreamID: String,
        normalizedItemId: String?
    ) {
        let fallbackStreamID = assistantDeltaStreamID(threadId: threadId, turnId: turnId, itemId: nil)
        guard fallbackStreamID != destinationStreamID,
              let fallbackDelta = pendingAssistantDeltaByStreamID.removeValue(forKey: fallbackStreamID) else {
            return
        }

        let fallbackContext = pendingAssistantDeltaContextByStreamID[fallbackStreamID]
        pendingAssistantDeltaContextByStreamID.removeValue(forKey: fallbackStreamID)
        pendingAssistantDeltaStreamOrder.removeAll { $0 == fallbackStreamID }
        if pendingAssistantDeltaByStreamID[destinationStreamID] == nil,
           !pendingAssistantDeltaStreamOrder.contains(destinationStreamID) {
            pendingAssistantDeltaStreamOrder.append(destinationStreamID)
        }
        pendingAssistantDeltaByStreamID[destinationStreamID] = mergeAssistantDelta(
            existingText: pendingAssistantDeltaByStreamID[destinationStreamID] ?? "",
            incomingDelta: fallbackDelta
        )
        pendingAssistantDeltaContextByStreamID[destinationStreamID] = (
            threadId: threadId,
            turnId: turnId.trimmingCharacters(in: .whitespacesAndNewlines),
            itemId: normalizedItemId,
            assistantPhase: fallbackContext?.assistantPhase,
            isReplayed: fallbackContext?.isReplayed ?? isApplyingReplayedBridgeEvent
        )
    }

    private func schedulePendingAssistantDeltaFlushIfNeeded() {
        guard pendingAssistantDeltaFlushTask == nil else { return }

        let flushDelayNanoseconds = pendingAssistantDeltaFlushDelayNanoseconds()
        pendingAssistantDeltaFlushTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: flushDelayNanoseconds)
            guard !Task.isCancelled else { return }
            await Self.deferFlushWhileInteractionIsActive()
            guard !Task.isCancelled else { return }
            self.flushPendingAssistantDeltas()
        }
    }

    // A drag or typing burst can start after the flush timer was armed; wait it out in
    // interaction-cadence slices, bounded so a long flick chain cannot starve the stream.
    static func deferFlushWhileInteractionIsActive() async {
        var remainingDeferrals = 8
        while !Task.isCancelled,
              remainingDeferrals > 0,
              StreamingUIInteractionMonitor.isInteractionActive() {
            remainingDeferrals -= 1
            try? await Task.sleep(
                nanoseconds: StreamingDeltaCoalescingPolicy.interactionFlushDelayNanoseconds
            )
        }
    }

    private func pendingAssistantDeltaFlushDelayNanoseconds() -> UInt64 {
        var largestVisibleByteCount = 0
        for streamID in pendingAssistantDeltaStreamOrder {
            guard let visibleByteCount = visibleAssistantTextByteCount(forPendingAssistantStreamID: streamID) else {
                return StreamingDeltaCoalescingPolicy.assistantInitialFlushDelayNanoseconds
            }
            largestVisibleByteCount = max(largestVisibleByteCount, visibleByteCount)
        }

        let pendingDeltaByteCount = pendingAssistantDeltaByStreamID.values.reduce(0) { total, delta in
            total + delta.utf8.count
        }
        let isLargeStream = pendingDeltaByteCount >= StreamingDeltaCoalescingPolicy.assistantLargePendingDeltaByteCount
            || largestVisibleByteCount >= StreamingDeltaCoalescingPolicy.assistantLargeVisibleTextByteCount

        return isLargeStream
            ? StreamingDeltaCoalescingPolicy.assistantLargeStreamingFlushDelayNanoseconds
            : StreamingDeltaCoalescingPolicy.assistantStreamingFlushDelayNanoseconds
    }

    // Treat streams with no painted text as first-block work so sends still feel immediate.
    private func visibleAssistantTextByteCount(forPendingAssistantStreamID streamID: String) -> Int? {
        guard let context = pendingAssistantDeltaContextByStreamID[streamID],
              let messageID = streamingAssistantMessageID(
                threadId: context.threadId,
                turnId: context.turnId,
                itemId: context.itemId
              ),
              let messageIndex = findMessageIndex(threadId: context.threadId, messageId: messageID),
              let message = messagesByThread[context.threadId]?[messageIndex],
              hasRenderableAssistantOutputText(message.text) else {
            return nil
        }

        return message.text.utf8.count
    }

    private func streamingAssistantMessageID(threadId: String, turnId: String, itemId: String?) -> String? {
        if let itemId,
           let messageID = streamingAssistantMessageByItemKey[
            assistantStreamingMessageKey(threadId: threadId, turnId: turnId, itemId: itemId)
           ] {
            return messageID
        }

        return streamingAssistantFallbackMessageByTurnID[
            streamingMessageKey(threadId: threadId, turnId: turnId)
        ]
    }

    func flushPendingAssistantDeltas(
        for threadId: String? = nil,
        turnId: String? = nil,
        itemId: String? = nil
    ) {
        let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = normalizedStreamingItemID(itemId)
        let streamIDsToFlush = pendingAssistantDeltaStreamOrder.filter { streamID in
            guard let context = pendingAssistantDeltaContextByStreamID[streamID] else {
                return true
            }
            if let threadId, context.threadId != threadId {
                return false
            }
            if let normalizedTurnId, context.turnId != normalizedTurnId {
                return false
            }
            if let normalizedItemId {
                return context.itemId == normalizedItemId || context.itemId == nil
            }
            return true
        }

        if !streamIDsToFlush.isEmpty {
            let flushedStreamIDs = Set(streamIDsToFlush)

            for streamID in streamIDsToFlush {
                guard let context = pendingAssistantDeltaContextByStreamID[streamID],
                      let delta = pendingAssistantDeltaByStreamID[streamID] else {
                    pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
                    pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
                    continue
                }

                pendingAssistantDeltaByStreamID.removeValue(forKey: streamID)
                pendingAssistantDeltaContextByStreamID.removeValue(forKey: streamID)
                let previousReplayScope = isApplyingReplayedBridgeEvent
                if context.isReplayed {
                    isApplyingReplayedBridgeEvent = true
                }
                applyAssistantDeltaBatch(
                    threadId: context.threadId,
                    turnId: context.turnId,
                    itemId: context.itemId,
                    assistantPhase: context.assistantPhase,
                    delta: delta
                )
                isApplyingReplayedBridgeEvent = previousReplayScope
            }
            pendingAssistantDeltaStreamOrder.removeAll { flushedStreamIDs.contains($0) }
        }

        if pendingAssistantDeltaByStreamID.isEmpty {
            pendingAssistantDeltaStreamOrder.removeAll()
            pendingAssistantDeltaFlushTask?.cancel()
            pendingAssistantDeltaFlushTask = nil
        } else if pendingAssistantDeltaFlushTask == nil {
            schedulePendingAssistantDeltaFlushIfNeeded()
        }
    }

    private func assistantDeltaStreamID(threadId: String, turnId: String, itemId: String?) -> String {
        let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let itemComponent: String
        if let normalizedItemId, !normalizedItemId.isEmpty {
            itemComponent = normalizedItemId
        } else {
            itemComponent = "__turn__"
        }
        return "\(threadId)|\(normalizedTurnId)|\(itemComponent)"
    }

    // Reuses the sidebar "ready" signal to surface a lightweight in-app banner for off-screen chats.
    func presentThreadCompletionBannerIfNeeded(threadId: String) {
        guard let thread = thread(for: threadId), !thread.isSubagent else {
            return
        }

        threadCompletionBanner = CodexThreadCompletionBanner(
            threadId: threadId,
            title: thread.displayTitle
        )
    }

    // Bumps a thread-local revision whenever its message timeline changes.
    func noteMessagesChanged(for threadId: String) {
        messageRevisionByThread[threadId, default: 0] &+= 1
    }

    // Keeps the "latest output" cache in sync for both full refreshes and lightweight streaming updates.
    func syncLatestAssistantOutputCache(for threadId: String) -> String {
        guard let messages = messagesByThread[threadId] else {
            latestAssistantOutputByThread[threadId] = ""
            latestAssistantMessageIDByThread.removeValue(forKey: threadId)
            return ""
        }

        if let cachedMessageID = latestAssistantMessageIDByThread[threadId],
           let cachedIndex = findMessageIndex(threadId: threadId, messageId: cachedMessageID),
           messages.indices.contains(cachedIndex) {
            for index in messages[cachedIndex...].indices.reversed() {
                let candidate = messages[index]
                guard candidate.role == .assistant,
                      hasRenderableAssistantOutputText(candidate.text) else {
                    continue
                }
                latestAssistantOutputByThread[threadId] = candidate.text
                latestAssistantMessageIDByThread[threadId] = candidate.id
                return candidate.text
            }
        }

        let latestAssistant = messages
            .last(where: { $0.role == .assistant && hasRenderableAssistantOutputText($0.text) })
        let latestAssistantText = latestAssistant?.text ?? ""
        latestAssistantOutputByThread[threadId] = latestAssistantText
        latestAssistantMessageIDByThread[threadId] = latestAssistant?.id
        return latestAssistantText
    }

    // Streaming calls hit this on every delta; avoid allocating a trimmed copy for normal prose.
    func hasRenderableAssistantOutputText(_ text: String) -> Bool {
        guard let first = text.first else {
            return false
        }
        if !first.isWhitespace {
            return true
        }
        return text.contains { !$0.isWhitespace }
    }
}
