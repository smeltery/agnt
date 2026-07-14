import SwiftUI

extension TurnTimelineView {
    // Keeps the padded timeline exactly viewport-wide so streaming rows cannot
    // expand the vertical ScrollView into a horizontally draggable surface.
    func timelineContentWidth(for viewportWidth: CGFloat) -> CGFloat {
        max(0, viewportWidth - (timelineHorizontalPadding * 2))
    }

    func recomputeRenderItemsIfNeeded() {
        let visibleSlice = visibleMessages
        let key = renderItemsInputKey(for: visibleSlice)
        let shapeSignature = renderItemsShapeSignature(for: visibleSlice)
        guard key != cachedRenderItemsInputKey || cachedRenderItems.isEmpty else {
            // Keep the body-time short-circuit in sync even when the full input key
            // matches (e.g. streaming text deltas re-hit the same cached projection).
            cachedRenderItemsShapeSignature = shapeSignature
            return
        }
        cachedRenderItemsInputKey = key
        cachedRenderItemsShapeSignature = shapeSignature
        cachedRenderItems = TurnTimelineRenderProjection.project(
            messages: Array(visibleSlice),
            completedTurnIDs: completedTurnIDs,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning
        )
    }

    func recomputeBlockInfoIfNeeded() {
        let visible = Array(visibleMessages)
        let key = blockInfoInputKey(for: visible)
        guard key != blockInfoInputKey else { return }
        blockInfoInputKey = key

        let cachedBlockInfo = Self.assistantBlockInfo(
            for: visible,
            activeTurnID: activeTurnID,
            isThreadRunning: isThreadRunning,
            latestTurnTerminalState: latestTurnTerminalState,
            stoppedTurnIDs: stoppedTurnIDs,
            revertStatesByMessageID: assistantRevertStatesByMessageID
        )

        let initialBlockInfoByMessageID = [String: AssistantBlockAccessoryState](
            uniqueKeysWithValues: zip(visible, cachedBlockInfo).compactMap { message, blockText in
                guard let blockText else { return nil }
                return (message.id, blockText)
            }
        )
        let updated = Self.rehomeCollapsedFinalAccessoryStates(
            initialBlockInfoByMessageID,
            messages: visible,
            completedTurnIDs: completedTurnIDs
        )
        let renderItems = visibleRenderItems
        let rehomed = Self.rehomeHiddenAccessoryStates(
            updated,
            messages: visible,
            renderItems: renderItems
        )
        if rehomed != cachedBlockInfoByMessageID {
            cachedBlockInfoByMessageID = rehomed
        }

        let newestStreamingMessageID = visible.last(where: { $0.isStreaming })?.id
        if newestStreamingMessageID != cachedNewestStreamingMessageID {
            cachedNewestStreamingMessageID = newestStreamingMessageID
        }
    }

    // Hashes the fields that change copy-block aggregation or inline action placement.
    // Include message text too because thread/resume can reconcile completed rows in place.
    func blockInfoInputKey(for messages: [CodexMessage]) -> Int {
        var hasher = Hasher()
        hasher.combine(messages.count)
        hasher.combine(isThreadRunning)
        hasher.combine(activeTurnID)
        hasher.combine(latestTurnTerminalState)
        hasher.combine(completedTurnIDs)
        hasher.combine(stoppedTurnIDs)

        for message in messages {
            hasher.combine(message.id)
            hasher.combine(message.role)
            hasher.combine(message.kind)
            hasher.combine(message.turnId)
            hasher.combine(message.isStreaming)
            // During streaming, text changes every delta — hash only the length to avoid
            // O(text_length) hashing per frame. Once finalized, hash full text for reconciliation.
            if message.isStreaming {
                hasher.combine(message.text.count)
            } else {
                hasher.combine(message.text)
            }
        }

        return hasher.finalize()
    }
    /// For each message index, returns the aggregated assistant block text if the message
    /// is the last non-user message before the next user message (or end of list).
    /// Returns nil for all other indices.
    static func assistantBlockInfo(
        for messages: [CodexMessage],
        activeTurnID: String?,
        isThreadRunning: Bool,
        isCopySuppressedByRunState: Bool? = nil,
        latestTurnTerminalState: CodexTurnTerminalState?,
        stoppedTurnIDs: Set<String>,
        revertStatesByMessageID: [String: AssistantRevertPresentation] = [:]
    ) -> [AssistantBlockAccessoryState?] {
        var result = [AssistantBlockAccessoryState?](repeating: nil, count: messages.count)
        let latestBlockEnd = messages.lastIndex(where: { $0.role != .user })
        var i = messages.count - 1
        while i >= 0 {
            guard messages[i].role != .user else { i -= 1; continue }
            let blockEnd = i
            let blockStart = assistantBlockStartIndex(endingAt: blockEnd, messages: messages)
            let blockTextParts = messages[blockStart...blockEnd]
                .filter { $0.role == .assistant }
                .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            let hasAssistantText = !blockTextParts.isEmpty
            let blockTurnID = messages[blockStart...blockEnd]
                .reversed()
                .compactMap(\.turnId)
                .first
            let isLatestBlock = latestBlockEnd == blockEnd
            let hasTrailingUserMessage = blockEnd < messages.index(before: messages.endIndex)
            let copyAllowed = hasAssistantText && shouldShowCopyButton(
                blockTurnID: blockTurnID,
                activeTurnID: activeTurnID,
                isCopySuppressedByRunState: isCopySuppressedByRunState ?? isThreadRunning,
                isLatestBlock: isLatestBlock,
                hasTrailingUserMessage: hasTrailingUserMessage,
                latestTurnTerminalState: latestTurnTerminalState,
                stoppedTurnIDs: stoppedTurnIDs
            )
            let copyText: String?
            if copyAllowed, messages[blockEnd].role != .assistant {
                copyText = blockTextParts.joined(separator: "\n\n")
            } else {
                copyText = nil
            }

            let showsRunningIndicator = shouldShowRunningIndicator(
                blockTurnID: blockTurnID,
                activeTurnID: activeTurnID,
                isThreadRunning: isThreadRunning,
                isLatestBlock: isLatestBlock,
                latestTurnTerminalState: latestTurnTerminalState,
                stoppedTurnIDs: stoppedTurnIDs
            )

            // Aggregate file-change entries across the block for the turn-end Diff button.
            let fileChangeMessages = Array(messages[blockStart...blockEnd].filter {
                $0.role == .system && $0.kind == .fileChange && !$0.isStreaming
            })
            let blockDiffPresentation = FileChangeBlockPresentationCache.presentation(from: fileChangeMessages)
            let blockDiffText = blockDiffPresentation?.bodyText
            let blockDiffEntries = blockDiffPresentation?.entries

            // Keep the source assistant row with its presentation so visible system rows can invoke the right change set.
            let blockRevert = messages[blockStart...blockEnd]
                .reversed()
                .compactMap { message -> (presentation: AssistantRevertPresentation, message: CodexMessage)? in
                    guard let presentation = revertStatesByMessageID[message.id] else { return nil }
                    return (presentation, message)
                }
                .first

            if copyAllowed || showsRunningIndicator || blockDiffEntries != nil || blockRevert != nil {
                result[blockEnd] = AssistantBlockAccessoryState(
                    copyText: copyText,
                    showsRunningIndicator: showsRunningIndicator,
                    allowsCopy: copyAllowed,
                    blockDiffText: blockDiffText,
                    blockDiffEntries: blockDiffEntries,
                    blockRevertPresentation: blockRevert?.presentation,
                    blockRevertMessage: blockRevert?.message
                )
            }
            i = blockStart - 1
        }
        return result
    }

    static func rehomeCollapsedFinalAccessoryStates(
        _ statesByMessageID: [String: AssistantBlockAccessoryState],
        messages: [CodexMessage],
        completedTurnIDs: Set<String>
    ) -> [String: AssistantBlockAccessoryState] {
        let collapsedFinalMessageIDs = TurnTimelineRenderProjection.collapsedFinalMessageIDs(
            in: messages,
            completedTurnIDs: completedTurnIDs
        )
        guard !collapsedFinalMessageIDs.isEmpty else {
            return statesByMessageID
        }
        let hiddenMessageIDs = TurnTimelineRenderProjection.collapsedPreviousMessageIDs(
            in: messages,
            completedTurnIDs: completedTurnIDs
        )

        var updated = statesByMessageID
        for finalIndex in messages.indices where collapsedFinalMessageIDs.contains(messages[finalIndex].id) {
            let finalMessage = messages[finalIndex]
            let sourceState = updated[finalMessage.id] ?? collapsedBlockAccessoryState(
                forFinalIndex: finalIndex,
                messages: messages,
                hiddenMessageIDs: hiddenMessageIDs,
                statesByMessageID: updated
            )
            guard let sourceState else { continue }

            let finalCopyText = finalMessage.text.trimmingCharacters(in: .whitespacesAndNewlines)
            updated[finalMessage.id] = sourceState.replacingCopyText(finalCopyText.isEmpty ? nil : finalCopyText)
        }
        return updated
    }

    static func rehomeHiddenAccessoryStates(
        _ statesByMessageID: [String: AssistantBlockAccessoryState],
        messages: [CodexMessage],
        renderItems: [TurnTimelineRenderItem]
    ) -> [String: AssistantBlockAccessoryState] {
        let hostIDs = accessoryHostMessageIDs(in: renderItems)
        guard !hostIDs.isEmpty else {
            return statesByMessageID
        }

        var updated = statesByMessageID
        for index in messages.indices {
            let message = messages[index]
            guard let hiddenState = updated[message.id],
                  !hostIDs.contains(message.id),
                  let targetID = nearestAccessoryHostID(
                    before: index,
                    messages: messages,
                    hostIDs: hostIDs
                  ) else {
                continue
            }

            updated[message.id] = nil
            updated[targetID] = updated[targetID]?.mergingRehomedAccessoryState(hiddenState) ?? hiddenState
        }
        return updated
    }

    // When late tool rows are collapsed after the final answer, their block action
    // state still belongs on the visible final row.
    static func collapsedBlockAccessoryState(
        forFinalIndex finalIndex: Int,
        messages: [CodexMessage],
        hiddenMessageIDs: Set<String>,
        statesByMessageID: [String: AssistantBlockAccessoryState]
    ) -> AssistantBlockAccessoryState? {
        let finalMessage = messages[finalIndex]
        let finalTurnID = normalizedTurnID(finalMessage.turnId)
        var blockStart = finalIndex
        while blockStart > messages.startIndex && messages[blockStart - 1].role != .user {
            blockStart -= 1
        }

        var blockEnd = finalIndex
        while blockEnd < messages.index(before: messages.endIndex) && messages[blockEnd + 1].role != .user {
            blockEnd += 1
        }

        for index in stride(from: blockEnd, through: blockStart, by: -1) {
            let candidate = messages[index]
            guard candidate.id != finalMessage.id else { continue }
            guard hiddenMessageIDs.contains(candidate.id) else { continue }
            if let finalTurnID, normalizedTurnID(candidate.turnId) != finalTurnID {
                continue
            }
            if let state = statesByMessageID[candidate.id] {
                return state
            }
        }
        return nil
    }

    static func accessoryHostMessageIDs(in renderItems: [TurnTimelineRenderItem]) -> Set<String> {
        var ids = Set<String>()
        for item in renderItems {
            switch item {
            case .message(let message):
                ids.insert(message.id)
            case .toolBurst(let group):
                ids.formUnion(group.visibleMessages.map(\.id))
            case .commandGroup(let group):
                ids.formUnion(group.orderedMessages.map(\.id))
            case .previousMessages:
                break
            }
        }
        return ids
    }

    static func nearestAccessoryHostID(
        before index: Int,
        messages: [CodexMessage],
        hostIDs: Set<String>
    ) -> String? {
        guard index > messages.startIndex else {
            return nil
        }

        for candidateIndex in stride(from: index - 1, through: messages.startIndex, by: -1) {
            let candidate = messages[candidateIndex]
            if candidate.role == .user {
                return nil
            }
            if hostIDs.contains(candidate.id) {
                return candidate.id
            }
        }
        return nil
    }

    static func normalizedTurnID(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    // User messages and stable turn ids both delimit accessory ownership. Rows
    // without a turn id remain grouped because live rows can receive ids late.
    static func assistantBlockStartIndex(
        endingAt blockEnd: Int,
        messages: [CodexMessage]
    ) -> Int {
        var blockStart = blockEnd
        var blockTurnID = normalizedTurnID(messages[blockEnd].turnId)

        while blockStart > messages.startIndex {
            let previous = messages[blockStart - 1]
            guard previous.role != .user else {
                break
            }

            if let previousTurnID = normalizedTurnID(previous.turnId) {
                if let blockTurnID, previousTurnID != blockTurnID {
                    break
                }
                blockTurnID = blockTurnID ?? previousTurnID
            }
            blockStart -= 1
        }

        return blockStart
    }

    // Keeps Copy aligned with real run completion instead of per-message streaming heuristics.
    static func shouldShowCopyButton(
        blockTurnID: String?,
        activeTurnID: String?,
        isCopySuppressedByRunState: Bool,
        isLatestBlock: Bool,
        hasTrailingUserMessage: Bool,
        latestTurnTerminalState: CodexTurnTerminalState?,
        stoppedTurnIDs: Set<String>
    ) -> Bool {
        if let blockTurnID, stoppedTurnIDs.contains(blockTurnID) {
            return false
        }

        if isLatestBlock, latestTurnTerminalState == .stopped {
            return false
        }

        guard isCopySuppressedByRunState else {
            return true
        }

        if let blockTurnID, let activeTurnID {
            return blockTurnID != activeTurnID
        }

        return !isLatestBlock || hasTrailingUserMessage
    }

    // Keeps the terminal loader attached to the block that still belongs to the active run.
    static func shouldShowRunningIndicator(
        blockTurnID: String?,
        activeTurnID: String?,
        isThreadRunning: Bool,
        isLatestBlock: Bool,
        latestTurnTerminalState: CodexTurnTerminalState?,
        stoppedTurnIDs: Set<String>
    ) -> Bool {
        guard isThreadRunning else {
            return false
        }

        if isLatestBlock, latestTurnTerminalState == .stopped {
            return false
        }

        if let blockTurnID, stoppedTurnIDs.contains(blockTurnID) {
            return false
        }

        if let blockTurnID, let activeTurnID {
            return blockTurnID == activeTurnID
        }

        return isLatestBlock
    }
}
