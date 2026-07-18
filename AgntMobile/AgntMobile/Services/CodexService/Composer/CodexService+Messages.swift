// FILE: CodexService+Messages.swift
// Purpose: Owns message row mutation and streaming merge logic.
// Layer: Service
// Exports: CodexService message APIs
// Depends on: CodexMessage, JSONValue

import Foundation
import UIKit

extension CodexService {
    // Appends a user message immediately so UI feels instant before server events arrive.
    @discardableResult
    func appendUserMessage(
        threadId: String,
        text: String,
        turnId: String? = nil,
        attachments: [CodexImageAttachment] = [],
        fileMentions: [String] = [],
        skillMentions: [String] = [],
        pluginMentions: [String] = []
    ) -> String {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedText.isEmpty
                || !attachments.isEmpty
                || !skillMentions.isEmpty
                || !pluginMentions.isEmpty else {
            return ""
        }

        let message = CodexMessage(
            threadId: threadId,
            role: .user,
            text: trimmedText,
            fileMentions: fileMentions,
            skillMentions: skillMentions,
            pluginMentions: pluginMentions,
            turnId: turnId,
            isStreaming: false,
            deliveryState: .pending,
            attachments: attachments
        )
        appendMessage(message)
        return message.id
    }

    // Upserts a confirmed user row mirrored from a desktop-origin rollout so
    // reopened threads can display the remote prompt immediately without
    // disturbing the phone-native pending-send path.
    func appendConfirmedMirroredUserMessage(
        threadId: String,
        turnId: String?,
        text: String,
        fileMentions: [String] = [],
        createdAt: Date? = nil
    ) {
        let trimmedText = Self.normalizedMessageText(text)
        guard Self.hasMeaningfulHistoryText(trimmedText) else {
            return
        }

        if let existingIndex = messagesByThread[threadId]?.lastIndex(where: { candidate in
            candidate.role == .user
                && Self.userMessageMatchesTextForHistory(candidate, text: trimmedText)
                && (
                    (turnId != nil && (candidate.turnId == nil || candidate.turnId == turnId))
                        || (turnId == nil && candidate.turnId == nil)
                )
        }) {
            var didMutate = false
            if messagesByThread[threadId]?[existingIndex].deliveryState != .confirmed {
                messagesByThread[threadId]?[existingIndex].deliveryState = .confirmed
                didMutate = true
            }
            if messagesByThread[threadId]?[existingIndex].turnId == nil {
                messagesByThread[threadId]?[existingIndex].turnId = turnId
                didMutate = true
            }
            // Optional chaining turns `isEmpty` into `Bool?`, so compare explicitly here.
            if messagesByThread[threadId]?[existingIndex].fileMentions.isEmpty == true, !fileMentions.isEmpty {
                messagesByThread[threadId]?[existingIndex].fileMentions = fileMentions
                didMutate = true
            }
            if let createdAt,
               CodexTimestampParser.isTrustworthyServerDate(createdAt),
               let existingCreatedAt = messagesByThread[threadId]?[existingIndex].createdAt,
               (!CodexTimestampParser.isTrustworthyServerDate(existingCreatedAt)
                    || abs(existingCreatedAt.timeIntervalSince(createdAt)) > 0.5) {
                messagesByThread[threadId]?[existingIndex].createdAt = createdAt
                didMutate = true
            }
            if moveMirroredOpeningUserBeforeTurnOutputIfNeeded(
                threadId: threadId,
                turnId: turnId,
                messageIndex: existingIndex
            ) {
                didMutate = true
            }
            guard didMutate else {
                return
            }
            messagesByThread[threadId]?.sort(by: { $0.orderIndex < $1.orderIndex })
            persistMessages()
            updateCurrentOutput(for: threadId)
            return
        }

        let orderIndex = reserveMirroredOpeningUserOrderIndex(threadId: threadId, turnId: turnId)
        appendMessage(
            CodexMessage(
                threadId: threadId,
                role: .user,
                text: trimmedText,
                fileMentions: fileMentions,
                createdAt: createdAt ?? Date(),
                turnId: turnId,
                deliveryState: .confirmed,
                orderIndex: orderIndex
            )
        )
    }

    // Desktop rollout mirrors can deliver assistant output before the opening user event.
    // Reserve the first same-turn slot so the phone timeline matches the Mac transcript.
    private func reserveMirroredOpeningUserOrderIndex(threadId: String, turnId: String?) -> Int? {
        guard let turnAnchor = mirroredOpeningUserAnchor(threadId: threadId, turnId: turnId) else {
            return nil
        }

        guard let indices = messagesByThread[threadId]?.indices else {
            return turnAnchor
        }

        for index in indices {
            guard let currentOrder = messagesByThread[threadId]?[index].orderIndex,
                  currentOrder >= turnAnchor else {
                continue
            }
            messagesByThread[threadId]?[index].orderIndex = currentOrder + 1
        }
        CodexMessageOrderCounter.seed(from: messagesByThread)
        return turnAnchor
    }

    // Repositions an already-created mirrored opener without moving real steer prompts.
    private func moveMirroredOpeningUserBeforeTurnOutputIfNeeded(
        threadId: String,
        turnId: String?,
        messageIndex: Int
    ) -> Bool {
        guard let threadMessages = messagesByThread[threadId],
              threadMessages.indices.contains(messageIndex),
              let turnAnchor = mirroredOpeningUserAnchor(
                threadId: threadId,
                turnId: turnId,
                existingMessageID: threadMessages[messageIndex].id
              ),
              threadMessages[messageIndex].orderIndex > turnAnchor else {
            return false
        }

        let previousOrder = threadMessages[messageIndex].orderIndex
        for index in threadMessages.indices where index != messageIndex {
            guard let currentOrder = messagesByThread[threadId]?[index].orderIndex,
                  currentOrder >= turnAnchor,
                  currentOrder < previousOrder else {
                continue
            }
            messagesByThread[threadId]?[index].orderIndex = currentOrder + 1
        }
        messagesByThread[threadId]?[messageIndex].orderIndex = turnAnchor
        return true
    }

    // Returns the first output slot only when this turn has no other user row.
    // Multiple user rows mean an in-turn steer, where chronological order is intentional.
    private func mirroredOpeningUserAnchor(
        threadId: String,
        turnId: String?,
        existingMessageID: String? = nil
    ) -> Int? {
        guard let turnId, !turnId.isEmpty,
              let threadMessages = messagesByThread[threadId] else {
            return nil
        }

        var firstOutputOrder: Int?
        for message in threadMessages where message.turnId == turnId {
            if message.id == existingMessageID {
                continue
            }
            if message.role == .user {
                return nil
            }
            firstOutputOrder = min(firstOutputOrder ?? message.orderIndex, message.orderIndex)
        }
        return firstOutputOrder
    }

    // Appends a system message in the current thread timeline.

}
