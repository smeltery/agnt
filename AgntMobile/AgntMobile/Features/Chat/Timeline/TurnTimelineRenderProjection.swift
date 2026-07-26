// FILE: TurnTimelineRenderProjection.swift
// Purpose: Builds lightweight render items from raw timeline messages.
// Layer: View Model / Projection
// Exports: TurnTimelineRenderProjection
// Depends on: Foundation, CodexMessage, timeline projection helpers

import Foundation

enum TurnTimelineRenderProjection {
    // Groups tool runs and completed-turn preamble rows so the visible timeline stays compact.
    static func project(
        messages: [CodexMessage],
        completedTurnIDs: Set<String> = [],
        activeTurnID: String? = nil,
        isThreadRunning: Bool = false
    ) -> [TurnTimelineRenderItem] {
        var items: [TurnTimelineRenderItem] = []
        var bufferedToolMessages: [CodexMessage] = []
        var bufferedCommandMessages: [CodexMessage] = []
        var bufferedCommandOrderedMessages: [CodexMessage] = []
        var bufferedCommandPendingToolActivity: [CodexMessage] = []
        var bufferedCommandTrailingFileChanges: [CodexMessage] = []
        let fileChangePlan = fileChangeCollapsePlan(in: messages)
        let finalCollapsePlan = previousMessagesCollapsePlan(
            in: messages,
            completedTurnIDs: completedTurnIDs
        )
        let hiddenIndices = Set(finalCollapsePlan.values.flatMap(\.indices))
            .union(fileChangePlan.hiddenIndices)
        let groupByInsertionIndex = finalCollapsePlan.values.reduce(into: [Int: PreviousMessagesCollapse]()) { result, collapse in
            result[collapse.insertionIndex] = collapse
        }
        let previousReplacementByIndex = finalCollapsePlan.reduce(into: [Int: CodexMessage]()) { result, entry in
            if let replacement = entry.value.replacementFinalMessage {
                result[entry.key] = replacement
            }
        }

        func flushBufferedToolMessages() {
            guard !bufferedToolMessages.isEmpty else { return }
            if bufferedToolMessages.count > TurnTimelineToolBurstGroup.collapseThreshold {
                items.append(.toolBurst(TurnTimelineToolBurstGroup(messages: bufferedToolMessages)))
            } else {
                items.append(contentsOf: bufferedToolMessages.map(TurnTimelineRenderItem.message))
            }
            bufferedToolMessages.removeAll(keepingCapacity: true)
        }

        func commitBufferedCommandPendingToolActivity() {
            guard !bufferedCommandPendingToolActivity.isEmpty else { return }
            bufferedCommandOrderedMessages.append(contentsOf: bufferedCommandPendingToolActivity)
            bufferedCommandPendingToolActivity.removeAll(keepingCapacity: true)
        }

        func flushBufferedCommandMessages(adoptsPendingToolActivity: Bool = true) {
            if adoptsPendingToolActivity {
                commitBufferedCommandPendingToolActivity()
            }
            let deferredToolActivity = bufferedCommandPendingToolActivity
            bufferedCommandPendingToolActivity.removeAll(keepingCapacity: true)

            if !bufferedCommandMessages.isEmpty {
                items.append(.commandGroup(TurnTimelineCommandGroup(
                    messages: bufferedCommandMessages,
                    orderedMessages: bufferedCommandOrderedMessages
                )))
            }
            items.append(contentsOf: deferredToolActivity.map(TurnTimelineRenderItem.message))
            items.append(contentsOf: bufferedCommandTrailingFileChanges.map(TurnTimelineRenderItem.message))
            bufferedCommandMessages.removeAll(keepingCapacity: true)
            bufferedCommandOrderedMessages.removeAll(keepingCapacity: true)
            bufferedCommandTrailingFileChanges.removeAll(keepingCapacity: true)
        }

        func commitBufferedCommandTrailingFileChanges() {
            guard !bufferedCommandTrailingFileChanges.isEmpty else { return }
            bufferedCommandOrderedMessages.append(contentsOf: bufferedCommandTrailingFileChanges)
            bufferedCommandTrailingFileChanges.removeAll(keepingCapacity: true)
        }

        func adoptBufferedToolMessagesIntoOpeningCommandGroup(_ incoming: CodexMessage) -> Bool {
            guard bufferedCommandMessages.isEmpty,
                  !bufferedToolMessages.isEmpty,
                  bufferedToolMessages.allSatisfy({ message in
                      isCommandGroupingToolActivity(message)
                  }),
                  let previous = bufferedToolMessages.last,
                  canShareToolBurst(previous: previous, incoming: incoming) else {
                return false
            }

            bufferedCommandOrderedMessages.append(contentsOf: bufferedToolMessages)
            bufferedToolMessages.removeAll(keepingCapacity: true)
            return true
        }

        for (index, message) in messages.enumerated() {
            if let group = groupByInsertionIndex[index] {
                flushBufferedToolMessages()
                flushBufferedCommandMessages()
                if group.group.hiddenCount > 0 {
                    items.append(.previousMessages(group.group))
                }
            }

            if hiddenIndices.contains(index) {
                if !isCommandGroupingCompanion(message) {
                    flushBufferedToolMessages()
                    flushBufferedCommandMessages()
                }
                continue
            }

            let renderedMessage = previousReplacementByIndex[index] ?? fileChangePlan.replacementByIndex[index] ?? message
            if shouldSkipVisualRow(
                renderedMessage,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning
            ) {
                continue
            }

            if !bufferedCommandMessages.isEmpty,
               isCommandGroupingInterstitial(renderedMessage) {
                flushBufferedToolMessages()
                if let previous = bufferedCommandMessages.last,
                   !canShareToolBurst(previous: previous, incoming: renderedMessage) {
                    flushBufferedCommandMessages()
                    items.append(.message(renderedMessage))
                } else if isCommandGroupingTrace(renderedMessage) {
                    commitBufferedCommandPendingToolActivity()
                    commitBufferedCommandTrailingFileChanges()
                    bufferedCommandOrderedMessages.append(renderedMessage)
                } else {
                    bufferedCommandTrailingFileChanges.append(renderedMessage)
                }
                continue
            }

            guard isToolBurstCandidate(message) else {
                flushBufferedToolMessages()
                flushBufferedCommandMessages()
                items.append(.message(renderedMessage))
                continue
            }

            guard !isFinishedCommandToolCall(renderedMessage) else {
                if !adoptBufferedToolMessagesIntoOpeningCommandGroup(renderedMessage) {
                    flushBufferedToolMessages()
                }
                if let previous = bufferedCommandMessages.last,
                   !canShareToolBurst(previous: previous, incoming: renderedMessage) {
                    flushBufferedCommandMessages()
                }
                commitBufferedCommandPendingToolActivity()
                commitBufferedCommandTrailingFileChanges()
                bufferedCommandMessages.append(renderedMessage)
                bufferedCommandOrderedMessages.append(renderedMessage)
                continue
            }

            if !bufferedCommandMessages.isEmpty,
               isCommandGroupingToolActivity(renderedMessage),
               let previous = bufferedCommandMessages.last,
               canShareToolBurst(previous: previous, incoming: renderedMessage) {
                flushBufferedToolMessages()
                commitBufferedCommandTrailingFileChanges()
                bufferedCommandPendingToolActivity.append(renderedMessage)
                continue
            }

            flushBufferedCommandMessages()
            if let previous = bufferedToolMessages.last,
               !canShareToolBurst(previous: previous, incoming: renderedMessage) {
                flushBufferedToolMessages()
            }

            bufferedToolMessages.append(renderedMessage)
        }

        let keepsLiveToolActivityVisible = isThreadRunning
            && bufferedCommandPendingToolActivity.contains { $0.isStreaming }
        flushBufferedToolMessages()
        flushBufferedCommandMessages(adoptsPendingToolActivity: !keepsLiveToolActivityVisible)
        return mergeAdjacentFileChangeItems(items)
    }

    static func collapsedFinalMessageIDs(
        in messages: [CodexMessage],
        completedTurnIDs: Set<String>
    ) -> Set<String> {
        Set(previousMessagesCollapsePlan(
            in: messages,
            completedTurnIDs: completedTurnIDs
        ).keys.map { messages[$0].id })
    }

    static func collapsedPreviousMessageIDs(
        in messages: [CodexMessage],
        completedTurnIDs: Set<String>
    ) -> Set<String> {
        Set(previousMessagesCollapsePlan(
            in: messages,
            completedTurnIDs: completedTurnIDs
        ).values.flatMap { collapse in
            collapse.indices.map { messages[$0].id }
        })
    }

}
