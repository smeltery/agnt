// FILE: CodexService+HistoryCanonicalReplacement.swift
// Purpose: Reconciles mirror/provisional timeline rows with canonical history snapshots.
// Layer: Service
// Exports: CodexService canonical history replacement helpers
// Depends on: CodexMessage, CodexSyntheticIdentifiers

import Foundation

extension CodexService {
    nonisolated static func existingMessagesForCanonicalSourceReplacement(
        _ existing: [CodexMessage],
        history: [CodexMessage]
    ) -> [CodexMessage] {
        guard !existing.isEmpty, !history.isEmpty else {
            return existing
        }

        func kindsAreCompatible(_ first: CodexMessage, _ second: CodexMessage) -> Bool {
            first.kind == second.kind || first.kind == .chat || second.kind == .chat
        }

        var canonicalTurnByProvisionalTurn: [String: String] = [:]
        for local in existing where local.role == .user {
            guard let localTurnID = normalizedHistoryIdentifier(local.turnId),
                  isProvisionalHistoryTurnIdentifier(localTurnID) else {
                continue
            }
            let canonicalMatches = history.filter { canonical in
                guard canonical.role == .user,
                      let canonicalTurnID = normalizedHistoryIdentifier(canonical.turnId),
                      !isProvisionalHistoryTurnIdentifier(canonicalTurnID) else {
                    return false
                }
                return userMessagesMatchForHistory(local, canonical)
                    && userMessageMetadataLooksCompatible(
                        localMessage: local,
                        serverMessage: canonical,
                        allowAttachmentCountFallback: local.deliveryState == .pending
                    )
            }
            let localMatches = existing.filter { candidate in
                candidate.role == .user && userMessagesMatchForHistory(candidate, local)
            }
            if canonicalMatches.count == 1,
               localMatches.count == 1,
               let canonicalTurnID = normalizedHistoryIdentifier(canonicalMatches[0].turnId) {
                canonicalTurnByProvisionalTurn[localTurnID] = canonicalTurnID
            }
        }

        func turnsAreCompatible(_ first: CodexMessage, _ second: CodexMessage) -> Bool {
            let firstTurnID = normalizedHistoryIdentifier(first.turnId)
            let secondTurnID = normalizedHistoryIdentifier(second.turnId)
            if firstTurnID == secondTurnID {
                return true
            }
            guard let firstTurnID, let secondTurnID else {
                return false
            }
            return canonicalTurnByProvisionalTurn[firstTurnID] == secondTurnID
        }

        func hasCanonicalCounterpart(_ local: CodexMessage) -> Bool {
            let localItemID = normalizedHistoryIdentifier(local.itemId)
            return history.contains { canonical in
                guard canonical.role == local.role, kindsAreCompatible(local, canonical) else {
                    return false
                }
                if let localItemID,
                   localItemID == normalizedHistoryIdentifier(canonical.itemId) {
                    if CodexSyntheticIdentifiers.isProjectedDesktopUserItemID(localItemID) {
                        return userMessagesMatchForHistory(local, canonical)
                            && turnsAreCompatible(local, canonical)
                    }
                    return !CodexSyntheticIdentifiers.isMirrorMintedItemID(localItemID)
                        || turnsAreCompatible(local, canonical)
                }
                if local.role == .system,
                   local.kind == .plan,
                   local.resolvedPlanPresentation == .progress,
                   canonical.resolvedPlanPresentation == .progress,
                   turnsAreCompatible(local, canonical) {
                    return true
                }
                let localText = normalizedMessageText(local.text)
                return !localText.isEmpty
                    && localText == normalizedMessageText(canonical.text)
                    && turnsAreCompatible(local, canonical)
            }
        }

        func hasStrongCanonicalAnchor(_ local: CodexMessage) -> Bool {
            let localItemID = normalizedHistoryIdentifier(local.itemId)
            return history.contains { canonical in
                guard canonical.role == local.role, kindsAreCompatible(local, canonical) else {
                    return false
                }
                if let localItemID,
                   localItemID == normalizedHistoryIdentifier(canonical.itemId),
                   !CodexSyntheticIdentifiers.isMirrorMintedItemID(localItemID) {
                    return true
                }
                guard turnsAreCompatible(local, canonical) else {
                    return false
                }
                let localTurnID = normalizedHistoryIdentifier(local.turnId)
                let canonicalTurnID = normalizedHistoryIdentifier(canonical.turnId)
                let hasRealSharedTurn = localTurnID == canonicalTurnID
                    && localTurnID.map { !isProvisionalHistoryTurnIdentifier($0) } == true
                let hasMappedPromptTurn = local.role == .user
                    && localTurnID.flatMap { canonicalTurnByProvisionalTurn[$0] } == canonicalTurnID
                guard hasRealSharedTurn || hasMappedPromptTurn else {
                    return false
                }
                return normalizedMessageText(local.text) == normalizedMessageText(canonical.text)
            }
        }

        let anchoredMessages = existing.filter(hasStrongCanonicalAnchor)
        let anchoredTurnIDs = Set(anchoredMessages.compactMap { normalizedHistoryIdentifier($0.turnId) })
        let replacementTailCandidates = existing.filter { message in
            hasStrongCanonicalAnchor(message)
                || normalizedHistoryIdentifier(message.turnId).map { anchoredTurnIDs.contains($0) } == true
        }
        guard let replacementTailStartOrder = replacementTailCandidates.map(\.orderIndex).min() else {
            return existing
        }

        return existing.filter { message in
            guard message.orderIndex >= replacementTailStartOrder else {
                return true
            }
            if message.role == .user, message.deliveryState != .confirmed {
                return true
            }
            let hasMirrorItemID = normalizedHistoryIdentifier(message.itemId)
                .map { CodexSyntheticIdentifiers.isMirrorMintedItemID($0) }
                ?? false
            let hasMirrorTurnID = isProvisionalHistoryTurnIdentifier(message.turnId)
            guard hasMirrorItemID || hasMirrorTurnID else {
                return true
            }
            return hasCanonicalCounterpart(message)
        }
    }
}
