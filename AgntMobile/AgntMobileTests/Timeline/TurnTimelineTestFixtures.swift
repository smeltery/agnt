// FILE: TurnTimelineTestFixtures.swift
// Purpose: Shared compact fixtures for timeline reducer tests.
// Layer: Unit Test Support
// Exports: makeTimelineTestMessage
// Depends on: Foundation, AgntMobile

import Foundation
@testable import AgntMobile

// Builds compact fixtures for reducer invariants.
func makeTimelineTestMessage(
    id: String,
    threadID: String,
    role: CodexMessageRole,
    kind: CodexMessageKind = .chat,
    assistantPhase: String? = nil,
    text: String,
    createdAt: Date = Date(),
    turnID: String? = nil,
    itemID: String? = nil,
    isStreaming: Bool = false,
    attachments: [CodexImageAttachment] = [],
    deliveryState: CodexMessageDeliveryState = .confirmed,
    orderIndex: Int? = nil
) -> CodexMessage {
    var message = CodexMessage(
        id: id,
        threadId: threadID,
        role: role,
        kind: kind,
        assistantPhase: assistantPhase,
        text: text,
        createdAt: createdAt,
        turnId: turnID,
        itemId: itemID,
        isStreaming: isStreaming,
        deliveryState: deliveryState,
        attachments: attachments
    )
    if let orderIndex {
        message.orderIndex = orderIndex
    }
    return message
}

// Builds a compact auto-approval review fixture for timeline priority-visibility tests.
func makeTimelineTestAutoApprovalReview(
    id: String,
    status: CodexAutoApprovalReviewStatus
) -> CodexAutoApprovalReview {
    CodexAutoApprovalReview(
        reviewId: id,
        targetItemId: nil,
        turnId: "turn-1",
        startedAtMs: 0,
        completedAtMs: 1,
        status: status,
        riskLevel: nil,
        userAuthorization: nil,
        rationale: nil,
        decisionSource: nil,
        action: .object(["type": .string("command"), "command": .string("true")]),
        retryApproved: false,
        retryUnavailableReason: nil
    )
}

