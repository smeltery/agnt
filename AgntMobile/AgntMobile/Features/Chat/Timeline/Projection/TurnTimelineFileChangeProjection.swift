// FILE: TurnTimelineFileChangeProjection.swift
// Purpose: Collapses repeated timeline file-change snapshots for rendering.
// Layer: View Model / Projection
// Depends on: Foundation, CodexMessage, FileChangeBlockPresentationBuilder

import Foundation

extension TurnTimelineRenderProjection {
    struct FileChangeCollapsePlan {
        let hiddenIndices: Set<Int>
        let replacementByIndex: [Int: CodexMessage]
    }

    // Shows one end-of-turn file table even when the bridge streams multiple file-change snapshots.
    static func fileChangeCollapsePlan(in messages: [CodexMessage]) -> FileChangeCollapsePlan {
        var groups: [String: [Int]] = [:]
        var blockStart = messages.startIndex

        for index in messages.indices {
            if messages[index].role == .user {
                blockStart = messages.index(after: index)
                continue
            }

            let message = messages[index]
            guard message.role == .system,
                  message.kind == .fileChange,
                  !message.isStreaming else {
                continue
            }

            let key = normalizedIdentifier(message.turnId)
                .map { "turn:\($0)" }
                ?? "block:\(blockStart)"
            groups[key, default: []].append(index)
        }

        var hiddenIndices = Set<Int>()
        var replacementByIndex: [Int: CodexMessage] = [:]

        for indices in groups.values where indices.count > 1 {
            guard let targetIndex = indices.max() else { continue }
            let fileChangeMessages = indices.map { messages[$0] }
            guard let presentation = FileChangeBlockPresentationBuilder.build(from: fileChangeMessages) else {
                continue
            }

            hiddenIndices.formUnion(indices.filter { $0 != targetIndex })
            var replacement = messages[targetIndex]
            replacement.text = presentation.bodyText
            replacementByIndex[targetIndex] = replacement
        }

        return FileChangeCollapsePlan(
            hiddenIndices: hiddenIndices,
            replacementByIndex: replacementByIndex
        )
    }

    // Late file-change events can land as adjacent cards. Collapse only within
    // one turn so a previous turn's recap cannot appear under the next prompt.
    static func mergeAdjacentFileChangeItems(
        _ items: [TurnTimelineRenderItem]
    ) -> [TurnTimelineRenderItem] {
        var mergedItems: [TurnTimelineRenderItem] = []
        var pendingFileChanges: [CodexMessage] = []
        var pendingTurnKey: String?

        func flushPendingFileChanges() {
            guard !pendingFileChanges.isEmpty else { return }
            defer {
                pendingFileChanges.removeAll(keepingCapacity: true)
                pendingTurnKey = nil
            }

            guard pendingFileChanges.count > 1,
                  let presentation = FileChangeBlockPresentationBuilder.build(from: pendingFileChanges),
                  var replacement = pendingFileChanges.last else {
                mergedItems.append(contentsOf: pendingFileChanges.map(TurnTimelineRenderItem.message))
                return
            }

            replacement.text = presentation.bodyText
            mergedItems.append(.message(replacement))
        }

        for item in items {
            guard case .message(let message) = item,
                  message.role == .system,
                  message.kind == .fileChange,
                  !message.isStreaming else {
                flushPendingFileChanges()
                mergedItems.append(item)
                continue
            }

            let turnKey = fileChangeMergeTurnKey(for: message)
            if pendingTurnKey != nil, pendingTurnKey != turnKey {
                flushPendingFileChanges()
            }
            pendingTurnKey = turnKey
            pendingFileChanges.append(message)
        }

        flushPendingFileChanges()
        return mergedItems
    }

    static func fileChangeMergeTurnKey(for message: CodexMessage) -> String {
        normalizedIdentifier(message.turnId).map { "turn:\($0)" } ?? "turnless"
    }

}
