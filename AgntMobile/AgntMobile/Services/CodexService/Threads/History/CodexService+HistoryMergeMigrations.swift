// FILE: CodexService+HistoryMergeMigrations.swift
// Purpose: One-off corrections applied to already-persisted history during a merge.
// Layer: Service

import Foundation

extension CodexService {
    // Older builds could persist a read-only connector result as a file-change
    // row merely because its result contained a `diff` field. Once canonical
    // history decodes that same stable item as tool activity, discard the stale
    // kind so it cannot survive every relaunch beside the corrected row.
    nonisolated static func discardStaleFileChangeRowsSupersededByCanonicalToolActivity(
        _ existing: [CodexMessage],
        history: [CodexMessage]
    ) -> [CodexMessage] {
        let canonicalToolActivityItemIDs = Set(history.compactMap { message -> String? in
            guard message.role == .system,
                  message.kind == .toolActivity else {
                return nil
            }
            return normalizedHistoryIdentifier(message.itemId)
        })
        guard !canonicalToolActivityItemIDs.isEmpty else {
            return existing
        }

        var merged = existing
        merged.removeAll { candidate in
            guard candidate.role == .system,
                  candidate.kind == .fileChange,
                  let itemID = normalizedHistoryIdentifier(candidate.itemId) else {
                return false
            }
            return canonicalToolActivityItemIDs.contains(itemID)
        }
        return merged
    }
}
