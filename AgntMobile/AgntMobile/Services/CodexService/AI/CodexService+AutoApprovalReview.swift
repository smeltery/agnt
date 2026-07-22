// FILE: CodexService+AutoApprovalReview.swift
// Purpose: Handles automatic approval-review notifications from the local runtime.
// Layer: Service
// Exports: CodexService auto-approval review handling
// Depends on: CodexService, CodexAutoApprovalReview, JSONValue

import Foundation

extension CodexService {
    func handleAutoApprovalReviewNotification(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject,
              let threadId = paramsObject["threadId"]?.stringValue,
              let review = decodeAutoApprovalReview(from: paramsObject) else {
            debugRuntimeLog("item/autoApprovalReview dropped: undecodable payload")
            return
        }

        upsertAutoApprovalReview(review, threadId: threadId)
    }

    func decodeAutoApprovalReview(from paramsObject: IncomingParamsObject) -> CodexAutoApprovalReview? {
        guard let reviewId = paramsObject["reviewId"]?.stringValue,
              !reviewId.isEmpty,
              let turnId = paramsObject["turnId"]?.stringValue,
              let reviewObject = paramsObject["review"]?.objectValue,
              let statusValue = reviewObject["status"]?.stringValue,
              let action = paramsObject["action"] else {
            return nil
        }

        return CodexAutoApprovalReview(
            reviewId: reviewId,
            targetItemId: paramsObject["targetItemId"]?.stringValue,
            turnId: turnId,
            startedAtMs: integerAutoApprovalTimestamp(paramsObject["startedAtMs"]),
            completedAtMs: optionalAutoApprovalTimestamp(paramsObject["completedAtMs"]),
            status: CodexAutoApprovalReviewStatus(rawValue: statusValue),
            riskLevel: reviewObject["riskLevel"]?.stringValue,
            userAuthorization: reviewObject["userAuthorization"]?.stringValue,
            rationale: reviewObject["rationale"]?.stringValue,
            decisionSource: paramsObject["decisionSource"]?.stringValue,
            action: action,
            retryApproved: false,
            retryUnavailableReason: "Approve retries in Codex Desktop."
        )
    }

    private func upsertAutoApprovalReview(
        _ review: CodexAutoApprovalReview,
        threadId: String
    ) {
        if var threadMessages = messagesByThread[threadId],
           let messageIndex = threadMessages.firstIndex(where: {
               $0.autoApprovalReview?.reviewId == review.reviewId
           }),
           let existingReview = threadMessages[messageIndex].autoApprovalReview {
            if existingReview.status.isTerminal, !review.status.isTerminal {
                return
            }

            var updatedReview = review
            updatedReview.retryApproved = existingReview.retryApproved
            updatedReview.retryUnavailableReason = review.retryUnavailableReason
                ?? existingReview.retryUnavailableReason
            threadMessages[messageIndex].text = updatedReview.actionSummary
            threadMessages[messageIndex].turnId = updatedReview.turnId
            threadMessages[messageIndex].isStreaming = !updatedReview.status.isTerminal
                && !isApplyingReplayedBridgeEvent
            threadMessages[messageIndex].autoApprovalReview = updatedReview
            messagesByThread[threadId] = threadMessages
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let createdAt = review.startedAtMs > 0
            ? Date(timeIntervalSince1970: Double(review.startedAtMs) / 1_000)
            : Date()
        appendMessage(
            CodexMessage(
                threadId: threadId,
                role: .system,
                kind: .autoApprovalReview,
                text: review.actionSummary,
                createdAt: createdAt,
                turnId: review.turnId,
                itemId: "auto-approval-review:\(review.reviewId)",
                isStreaming: review.status == .inProgress,
                autoApprovalReview: review
            )
        )
    }

    private func integerAutoApprovalTimestamp(_ value: JSONValue?) -> Int {
        optionalAutoApprovalTimestamp(value) ?? 0
    }

    private func optionalAutoApprovalTimestamp(_ value: JSONValue?) -> Int? {
        if let integer = value?.intValue {
            return integer
        }
        if let double = value?.doubleValue {
            return Int(double)
        }
        return nil
    }
}
