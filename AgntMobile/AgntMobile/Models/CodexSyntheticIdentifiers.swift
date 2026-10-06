// FILE: CodexSyntheticIdentifiers.swift
// Purpose: Single source for synthetic identifier families minted by mirrors and live streams.
// Layer: Model
// Exports: CodexSyntheticIdentifiers
// Depends on: Foundation

import Foundation

nonisolated enum CodexSyntheticIdentifiers {
    static func isMirrorMintedItemID(_ itemId: String) -> Bool {
        itemId.hasPrefix("turn:") || itemId.hasPrefix("rollout-")
    }

    static func isRolloutMintedItemID(_ itemId: String) -> Bool {
        itemId.hasPrefix("rollout-")
    }

    static func isPlaceholderItemID(_ itemId: String, kind: CodexMessageKind) -> Bool {
        itemId.hasPrefix("turn:") && itemId.contains("|kind:\(kind.rawValue)")
    }

    static func placeholderItemID(turnId: String, kind: CodexMessageKind) -> String {
        "turn:\(turnId)|kind:\(kind.rawValue)"
    }

    static func isBridgeMintedTurnID(_ turnId: String) -> Bool {
        turnId.hasPrefix("turn-line-")
            || turnId.hasPrefix("rollout-")
            || isHistoryCompactionMarkerTurnID(turnId)
    }

    static func isHistoryCompactionMarkerTurnID(_ turnId: String) -> Bool {
        turnId.hasPrefix("agnt-history-compacted-")
    }

    static func isCumulativeFileChangeAggregateItemID(_ itemId: String) -> Bool {
        isPlaceholderItemID(itemId, kind: .fileChange)
            || itemId.hasPrefix("agnt-jsonl-file-change-")
    }

    static func isSyntheticPlaceholderTurnID(_ turnId: String) -> Bool {
        isBridgeMintedTurnID(turnId) || isProjectedDesktopTurnID(turnId)
            || turnId.hasPrefix("agnt-idless-turn-")
    }

    static func isProjectedDesktopTurnID(_ turnId: String) -> Bool {
        turnId.hasPrefix("ipc-turn-")
    }

    static func provisionalIDLessTurnID() -> String {
        "agnt-idless-turn-\(UUID().uuidString)"
    }

    static func isProjectedDesktopUserItemID(_ itemId: String) -> Bool {
        itemId.hasSuffix(":input")
    }
}
