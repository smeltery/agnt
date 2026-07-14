// FILE: CodexService+HistoryMergeUsers.swift
// Purpose: User-message matching helpers for history merge reconciliation.
// Layer: Service

import Foundation

extension CodexService {
    nonisolated static func attachmentSignature(for attachments: [CodexImageAttachment]) -> String {
        attachments
            .map(\.stableIdentityKey)
            .joined(separator: "|")
    }

    nonisolated static func fileMentionsSignature(for fileMentions: [String]) -> String {
        fileMentions
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "|")
    }

    nonisolated static func userMessageMetadataLooksCompatible(
        localMessage: CodexMessage,
        serverMessage: CodexMessage,
        allowAttachmentCountFallback: Bool = false
    ) -> Bool {
        let localFileMentions = fileMentionsSignature(for: localMessage.fileMentions)
        let serverFileMentions = fileMentionsSignature(for: serverMessage.fileMentions)
        if !localFileMentions.isEmpty,
           !serverFileMentions.isEmpty,
           localFileMentions != serverFileMentions {
            return false
        }

        let localAttachments = attachmentSignature(for: localMessage.attachments)
        let serverAttachments = attachmentSignature(for: serverMessage.attachments)
        if !localAttachments.isEmpty,
           !serverAttachments.isEmpty,
           localAttachments != serverAttachments {
            // Pending image sends can return with a different server attachment identity
            // even though the user row is the same prompt/image count.
            return allowAttachmentCountFallback
                && localMessage.attachments.count == serverMessage.attachments.count
        }

        return true
    }

    nonisolated static func shouldReconcileUserHistoryMessage(
        _ candidate: CodexMessage,
        with message: CodexMessage,
        turnId: String
    ) -> Bool {
        guard candidate.role == .user,
              candidate.deliveryState != .failed,
              userMessagesMatchForHistory(candidate, message) else {
            return false
        }

        let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
        let allowsAttachmentCountFallback = candidate.deliveryState == .pending
            || candidateTurnId == turnId
        guard userMessageMetadataLooksCompatible(
            localMessage: candidate,
            serverMessage: message,
            allowAttachmentCountFallback: allowsAttachmentCountFallback
        ) else {
            return false
        }
        return candidateTurnId == nil || candidateTurnId == turnId
    }

    nonisolated static func shouldReconcilePendingUserHistoryMessage(
        _ candidate: CodexMessage,
        with message: CodexMessage
    ) -> Bool {
        guard candidate.role == .user,
              candidate.deliveryState == .pending,
              userMessagesMatchForHistory(candidate, message),
              userMessageMetadataLooksCompatible(
                localMessage: candidate,
                serverMessage: message,
                allowAttachmentCountFallback: true
              ) else {
            return false
        }

        return true
    }

    nonisolated static func uniqueUserHistoryMergeIndex(
        in merged: [CodexMessage],
        message: CodexMessage,
        turnId: String
    ) -> Int? {
        let matchingIndices = merged.indices.filter { index in
            shouldReconcileUserHistoryMessage(merged[index], with: message, turnId: turnId)
        }

        if matchingIndices.count == 1 {
            return matchingIndices[0]
        }

        // If a previous reopen already persisted an epoch-timestamp echo, bind new
        // history to the real-dated row so the duplicate does not keep multiplying.
        let nonFallbackMatches = matchingIndices.filter { index in
            !hasFallbackHistoryTimestamp(merged[index].createdAt)
        }
        if nonFallbackMatches.count == 1 {
            return nonFallbackMatches[0]
        }

        // Keep intentionally repeated sends separate when more than one real row fits.
        return nil
    }

    nonisolated static func uniquePendingUserHistoryMergeIndex(
        in merged: [CodexMessage],
        message: CodexMessage
    ) -> Int? {
        // Pending rows are especially easy to confuse during phone-started turns.
        let matchingIndices = merged.indices.filter { index in
            shouldReconcilePendingUserHistoryMessage(merged[index], with: message)
        }

        guard matchingIndices.count == 1 else {
            return nil
        }

        return matchingIndices[0]
    }

    nonisolated static func fallbackUserHistoryMergeIndices(
        in merged: [CodexMessage],
        message: CodexMessage
    ) -> [Int] {
        guard message.role == .user,
              normalizedHistoryIdentifier(message.itemId) == nil else {
            return []
        }

        let incomingTurnId = normalizedHistoryIdentifier(message.turnId)
        let incomingHasFallbackTimestamp = hasFallbackHistoryTimestamp(message.createdAt)

        return merged.indices.filter { index in
            let candidate = merged[index]
            guard candidate.threadId == message.threadId,
                  candidate.role == .user,
                  candidate.deliveryState != .failed,
                  userMessagesMatchForHistory(candidate, message),
                  userMessageMetadataLooksCompatible(
                    localMessage: candidate,
                    serverMessage: message,
                    allowAttachmentCountFallback: candidate.deliveryState == .pending
                  ) else {
                return false
            }

            let candidateTurnId = normalizedHistoryIdentifier(candidate.turnId)
            if let incomingTurnId, let candidateTurnId {
                return incomingTurnId == candidateTurnId
            }
            if incomingHasFallbackTimestamp {
                return true
            }
            if incomingTurnId == nil,
               abs(candidate.createdAt.timeIntervalSince(message.createdAt)) <= Self.identitylessUserHistoryEchoWindow {
                return true
            }
            if incomingTurnId == nil,
               !hasFallbackHistoryTimestamp(candidate.createdAt),
               candidate.deliveryState != .pending {
                return false
            }
            return true
        }
    }
}
