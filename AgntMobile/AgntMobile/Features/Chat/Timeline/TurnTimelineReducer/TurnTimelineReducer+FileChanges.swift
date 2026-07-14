import Foundation

extension TurnTimelineReducer {
    static func removeDuplicateFileChangeMessages(in messages: [CodexMessage]) -> [CodexMessage] {
        let signatures = messages.map { fileChangeDedupSignature(for: $0) }
        let fileChangeIndices = signatures.indices.filter { signatures[$0] != nil }
        var supersededIndices: Set<Int> = []

        for olderSlot in fileChangeIndices.indices {
            let olderIndex = fileChangeIndices[olderSlot]
            guard let olderSignature = signatures[olderIndex],
                  !supersededIndices.contains(olderIndex) else { continue }

            for newerSlot in (olderSlot + 1)..<fileChangeIndices.count {
                let newerIndex = fileChangeIndices[newerSlot]
                guard let newerSignature = signatures[newerIndex],
                      !supersededIndices.contains(newerIndex) else {
                    continue
                }
                if fileChangeMessage(newerSignature, supersedes: olderSignature)
                    || fileChangeAggregateAbsorbs(newerSignature, card: olderSignature) {
                    supersededIndices.insert(olderIndex)
                    break
                }
                if fileChangeAggregateAbsorbs(olderSignature, card: newerSignature) {
                    supersededIndices.insert(newerIndex)
                }
            }
        }

        return messages.enumerated().compactMap { index, message in
            if signatures[index] != nil, supersededIndices.contains(index) {
                return nil
            }
            return message
        }
    }

    // Collapses back-to-back subagent cards when the first one is only a transient
    // placeholder and the second one carries the real child-thread payload.
    static func removeDuplicateSubagentActionMessages(in messages: [CodexMessage]) -> [CodexMessage] {
        var result: [CodexMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard let action = message.subagentAction,
                  message.role == .system,
                  message.kind == .subagentAction else {
                result.append(message)
                continue
            }

            guard let previous = result.last,
                  let previousAction = previous.subagentAction,
                  shouldMergeSubagentActionMessages(
                      previous: previous,
                      previousAction: previousAction,
                      incoming: message,
                      incomingAction: action
                  ) else {
                result.append(message)
                continue
            }

            result[result.count - 1] = preferredSubagentActionMessage(previous: previous, incoming: message)
        }

        return result
    }

    static func shouldMergeSubagentActionMessages(
        previous: CodexMessage,
        previousAction: CodexSubagentAction,
        incoming: CodexMessage,
        incomingAction: CodexSubagentAction
    ) -> Bool {
        guard previous.role == .system,
              previous.kind == .subagentAction,
              previous.threadId == incoming.threadId,
              normalizedIdentifier(previous.turnId) == normalizedIdentifier(incoming.turnId),
              previousAction.normalizedTool == incomingAction.normalizedTool,
              previous.text == incoming.text else {
            return false
        }

        guard let previousItemId = normalizedIdentifier(previous.itemId),
              let incomingItemId = normalizedIdentifier(incoming.itemId) else {
            return false
        }
        if previousItemId != incomingItemId {
            return false
        }

        let previousRows = previousAction.agentRows
        let incomingRows = incomingAction.agentRows

        if previousRows.isEmpty && !incomingRows.isEmpty {
            return true
        }

        if previousRows == incomingRows {
            return true
        }

        return false
    }

    static func preferredSubagentActionMessage(previous: CodexMessage, incoming: CodexMessage) -> CodexMessage {
        let previousRows = previous.subagentAction?.agentRows ?? []
        let incomingRows = incoming.subagentAction?.agentRows ?? []

        if previousRows.isEmpty && !incomingRows.isEmpty {
            return incoming
        }

        if incoming.isStreaming != previous.isStreaming {
            return incoming.isStreaming ? previous : incoming
        }

        return incoming.orderIndex >= previous.orderIndex ? incoming : previous
    }

    // Keys file-change cards by turn + rendered payload so repeated turn/diff snapshots collapse to one row.
    // Falls back to full normalized text so even unparseable messages with identical content get deduped.
    static func duplicateFileChangeKey(for message: CodexMessage) -> String? {
        let turnLabel = normalizedIdentifier(message.turnId) ?? "turnless"

        if message.text.utf8.count <= largeTextDedupeByteLimit,
           let summaryKey = TurnFileChangeSummaryParser.dedupeKey(from: message.text) {
            return "\(turnLabel)|\(summaryKey)"
        }

        guard let normalizedText = normalizedSmallMessageText(message.text) else {
            return nil
        }
        return "\(turnLabel)|\(normalizedText)"
    }

    // Captures the parts of a file-change row that matter for timeline dedupe.
    // Produces a signature even for turnless rows (local/streaming) so a later
    // snapshot with a real turnId can supersede them via path overlap.
    static func fileChangeDedupSignature(for message: CodexMessage) -> FileChangeDedupSignature? {
        guard message.role == .system,
              message.kind == .fileChange else {
            return nil
        }

        let turnId = normalizedIdentifier(message.turnId)
        let key = duplicateFileChangeKey(for: message)
        let entries = message.text.utf8.count <= largeTextDedupeByteLimit
            ? (TurnFileChangeSummaryParser.parse(from: message.text)?.entries ?? [])
            : []

        let paths = Set(
            entries.map(\.path)
        )
        let singleEntryDescriptor: FileChangeSingleEntryDescriptor? = {
            guard entries.count == 1, let entry = entries.first else { return nil }
            return FileChangeSingleEntryDescriptor(
                path: entry.path,
                additions: entry.additions,
                deletions: entry.deletions,
                action: entry.action
            )
        }()

        // Need at least a key or paths to participate in dedup.
        guard key != nil || !paths.isEmpty || singleEntryDescriptor != nil else {
            return nil
        }

        return FileChangeDedupSignature(
            turnId: turnId,
            key: key,
            paths: paths,
            singleEntryDescriptor: singleEntryDescriptor,
            isStreaming: message.isStreaming,
            isKnownAggregate: normalizedIdentifier(message.itemId)
                .map(CodexSyntheticIdentifiers.isCumulativeFileChangeAggregateItemID) ?? false
        )
    }

    static func fileChangeAggregateAbsorbs(
        _ aggregate: FileChangeDedupSignature,
        card: FileChangeDedupSignature
    ) -> Bool {
        guard !card.isStreaming,
              !card.isKnownAggregate,
              let aggregateTurn = aggregate.turnId,
              let cardTurn = card.turnId,
              aggregateTurn == cardTurn,
              !card.paths.isEmpty,
              !aggregate.paths.isEmpty else {
            return false
        }
        if aggregate.isStreaming || aggregate.isKnownAggregate {
            return card.paths.isSubset(of: aggregate.paths)
        }
        return card.paths.isStrictSubset(of: aggregate.paths)
    }

    // Treats newer file-change snapshots as authoritative only when they describe the
    // same turn (or a turnless→turnful upgrade) and either the same dedupe key or a
    // provisional-to-final snapshot upgrade with matching paths.
    static func fileChangeMessage(
        _ newer: FileChangeDedupSignature,
        supersedes older: FileChangeDedupSignature
    ) -> Bool {
        let sameTurn: Bool
        if let newerTurn = newer.turnId, let olderTurn = older.turnId {
            sameTurn = newerTurn == olderTurn
        } else {
            // One or both are turnless — allow matching if paths overlap.
            sameTurn = older.turnId == nil || newer.turnId == nil
        }
        guard sameTurn else {
            return false
        }

        if let newerKey = newer.key, let olderKey = older.key, newerKey == olderKey {
            return true
        }

        if let newerSingle = newer.singleEntryDescriptor,
           let olderSingle = older.singleEntryDescriptor,
           (older.isStreaming || older.turnId == nil),
           singleFileChangeLooksLikePathUpgrade(newer: newerSingle, older: olderSingle) {
            return true
        }

        guard !newer.paths.isEmpty, !older.paths.isEmpty else {
            return false
        }

        // Turnless local row superseded by a real snapshot that now covers the same or a wider file set.
        if older.turnId == nil,
           newer.turnId != nil,
           older.paths.isSubset(of: newer.paths) {
            return true
        }

        // A finalized aggregate snapshot should replace provisional per-file rows from the same turn.
        if older.isStreaming,
           !newer.isStreaming,
           older.paths.isSubset(of: newer.paths) {
            return true
        }

        return false
    }

    static func singleFileChangeLooksLikePathUpgrade(
        newer: FileChangeSingleEntryDescriptor,
        older: FileChangeSingleEntryDescriptor
    ) -> Bool {
        guard newer.additions == older.additions,
              newer.deletions == older.deletions,
              newer.action == older.action else {
            return false
        }

        let newerPath = normalizedFileChangePath(newer.path)
        let olderPath = normalizedFileChangePath(older.path)
        guard !newerPath.isEmpty, !olderPath.isEmpty, newerPath != olderPath else {
            return false
        }

        let newerHasDirectory = newerPath.contains("/")
        let olderHasDirectory = olderPath.contains("/")
        guard newerHasDirectory != olderHasDirectory else {
            return false
        }

        let longerPath = newerPath.count >= olderPath.count ? newerPath : olderPath
        let shorterPath = newerPath.count >= olderPath.count ? olderPath : newerPath
        return longerPath.hasSuffix("/" + shorterPath)
    }

    static func normalizedFileChangePath(_ path: String) -> String {
        path.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct FileChangeDedupSignature: Equatable {
    let turnId: String?
    let key: String?
    let paths: Set<String>
    let singleEntryDescriptor: FileChangeSingleEntryDescriptor?
    let isStreaming: Bool
    // Positive-only: true when the item id can only belong to the cumulative
    // aggregate row; false means identity unknown, not per-patch card.
    let isKnownAggregate: Bool
}

struct FileChangeSingleEntryDescriptor: Equatable {
    let path: String
    let additions: Int
    let deletions: Int
    let action: TurnFileChangeAction?
}
