// FILE: CodexService+MessageLifecycle.swift
// Purpose: Updates delivery state and finalizes per-turn streaming lifecycle.
// Layer: Service
// Exports: CodexService message lifecycle helpers
// Depends on: Foundation

import Foundation

extension CodexService {
    func markMessageDeliveryState(
        threadId: String,
        messageId: String,
        state: CodexMessageDeliveryState,
        turnId: String? = nil
    ) {
        guard !messageId.isEmpty,
              let messageIndex = findMessageIndex(threadId: threadId, messageId: messageId) else {
            return
        }

        messagesByThread[threadId]?[messageIndex].deliveryState = state
        if let turnId, messagesByThread[threadId]?[messageIndex].turnId == nil {
            messagesByThread[threadId]?[messageIndex].turnId = turnId
        }
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func confirmLatestPendingUserMessage(threadId: String, turnId: String) {
        guard !turnId.isEmpty,
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { idx in
            let candidate = threadMessages[idx]
            return candidate.role == .user
                && candidate.deliveryState == .pending
                && (candidate.turnId == nil || candidate.turnId == turnId)
        }) else {
            return
        }

        threadMessages[index].deliveryState = .confirmed
        threadMessages[index].turnId = turnId
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    func removeLatestFailedUserMessage(
        threadId: String,
        matchingText: String,
        matchingAttachments: [CodexImageAttachment] = []
    ) {
        let normalizedText = matchingText.trimmingCharacters(in: .whitespacesAndNewlines)
        let matchingAttachmentSignature = matchingAttachments
            .map(\.stableIdentityKey)
            .joined(separator: "|")

        guard (!normalizedText.isEmpty || !matchingAttachmentSignature.isEmpty),
              var threadMessages = messagesByThread[threadId] else {
            return
        }

        guard let index = threadMessages.indices.reversed().first(where: { index in
            let message = threadMessages[index]
            let messageAttachmentSignature = message.attachments
                .map(\.stableIdentityKey)
                .joined(separator: "|")
            let matchesText = normalizedText.isEmpty
                || message.text.trimmingCharacters(in: .whitespacesAndNewlines) == normalizedText
            let matchesAttachments = matchingAttachmentSignature.isEmpty
                || messageAttachmentSignature == matchingAttachmentSignature
            return message.role == .user
                && message.deliveryState == .failed
                && matchesText
                && matchesAttachments
        }) else {
            return
        }

        threadMessages.remove(at: index)
        messagesByThread[threadId] = threadMessages
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Removes a known optimistic user row when text matching is not reliable, such as mention-only sends.
    @discardableResult
    func removeUserMessage(threadId: String, messageId: String) -> Bool {
        guard !messageId.isEmpty,
              var threadMessages = messagesByThread[threadId],
              let index = findMessageIndex(threadId: threadId, messageId: messageId),
              threadMessages.indices.contains(index),
              threadMessages[index].role == .user else {
            return false
        }

        threadMessages.remove(at: index)
        messagesByThread[threadId] = threadMessages
        messageIndexCacheByThread[threadId] = nil
        persistMessages()
        updateCurrentOutput(for: threadId)
        return true
    }

    // Marks streaming assistant state complete once turn/completed arrives.
    func markTurnCompleted(threadId: String, turnId: String?) {
        let resolvedTurnId = turnId ?? activeTurnIdByThread[threadId]
        flushPendingAssistantDeltas(for: threadId, turnId: resolvedTurnId)
        flushPendingSystemDeltasForTurn(threadId: threadId, turnId: resolvedTurnId)

        clearRunningState(for: threadId)
        clearRunningThreadWatch(threadId)
        let shouldFinalizePlanSteps: Bool = {
            if let resolvedTurnId {
                return turnTerminalState(for: resolvedTurnId, threadId: threadId) == .completed
            }
            return latestTurnTerminalStateByThread[threadId] == .completed
        }()

        if let resolvedTurnId {
            clearAssistantStreamingState(threadId: threadId, turnId: resolvedTurnId)
        }

        if let resolvedTurnId,
           activeTurnIdByThread[threadId] == resolvedTurnId {
            setActiveTurnID(nil, for: threadId)
        } else if resolvedTurnId == nil {
            setActiveTurnID(nil, for: threadId)
        }

        if let resolvedTurnId,
           activeTurnId == resolvedTurnId {
            activeTurnId = nil
        }

        updateBackgroundRunGraceTask()

        // Some servers never emit explicit item/completed for reasoning/fileChange.
        // Close both turn-bound and orphan system stream rows, but keep reasoning content visible.
        if var threadMessages = messagesByThread[threadId] {
            var didMutate = false
            let belongsToCompletedTurn: (CodexMessage) -> Bool = { message in
                if let resolvedTurnId {
                    return message.turnId == resolvedTurnId || message.turnId == nil
                }
                return message.isStreaming
            }

            for index in threadMessages.indices where threadMessages[index].role == .system
                && threadMessages[index].isStreaming {
                let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                guard belongsToTurn else { continue }
                threadMessages[index].isStreaming = false
                if var review = threadMessages[index].autoApprovalReview,
                   review.status == .inProgress {
                    review.status = .aborted
                    review.completedAtMs = Int(Date().timeIntervalSince1970 * 1_000)
                    threadMessages[index].autoApprovalReview = review
                }
                didMutate = true
            }

            for index in threadMessages.indices where threadMessages[index].role == .system
                && threadMessages[index].kind == .plan {
                let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                guard belongsToTurn else { continue }

                switch threadMessages[index].resolvedPlanPresentation {
                case .resultCompletedItem:
                    let nextPresentation: CodexPlanPresentation = shouldFinalizePlanSteps ? .resultReady : .resultClosed
                    if threadMessages[index].planPresentation != nextPresentation {
                        threadMessages[index].planPresentation = nextPresentation
                    }
                    refreshDerivedPlanMetadata(in: &threadMessages, index: index)
                    didMutate = true
                case .resultStreaming:
                    if threadMessages[index].planPresentation != .resultClosed {
                        threadMessages[index].planPresentation = .resultClosed
                        threadMessages[index].proposedPlan = nil
                        didMutate = true
                    }
                default:
                    break
                }
            }

            // Successful completions can land before the server publishes a final
            // "all steps completed" plan snapshot, so normalize stale progress steps here.
            if shouldFinalizePlanSteps {
                let fallbackPlanIndex: Int? = {
                    guard resolvedTurnId == nil else { return nil }
                    return threadMessages.indices.reversed().first(where: { index in
                        let candidate = threadMessages[index]
                        return candidate.role == .system
                            && candidate.kind == .plan
                            && candidate.resolvedPlanPresentation == .progress
                            && candidate.planState?.steps.contains(where: { $0.status != .completed }) == true
                    })
                }()

                for index in threadMessages.indices where threadMessages[index].role == .system
                    && threadMessages[index].kind == .plan {
                    let belongsToTurn = belongsToCompletedTurn(threadMessages[index])
                        || fallbackPlanIndex == index
                    guard belongsToTurn,
                          threadMessages[index].resolvedPlanPresentation == .progress,
                          let planState = threadMessages[index].planState,
                          !planState.steps.isEmpty,
                          planState.steps.contains(where: { $0.status != .completed }) else {
                        continue
                    }

                    threadMessages[index].planState = CodexPlanState(
                        explanation: planState.explanation,
                        steps: planState.steps.map { step in
                            CodexPlanStep(id: step.id, step: step.step, status: .completed)
                        }
                    )
                    didMutate = true
                }
            }

            let priorCount = threadMessages.count
            if let resolvedTurnId {
                threadMessages.removeAll {
                    $0.role == .system
                        && $0.kind == .thinking
                        && ($0.turnId == resolvedTurnId || $0.turnId == nil)
                        && shouldPruneThinkingRowAfterTurnCompletion($0)
                }
            } else {
                threadMessages.removeAll {
                    $0.role == .system
                        && $0.kind == .thinking
                        && shouldPruneThinkingRowAfterTurnCompletion($0)
                }
            }
            if threadMessages.count != priorCount {
                didMutate = true
            }

            if didMutate {
                messagesByThread[threadId] = threadMessages
            }
        }

        streamingSystemMessageByItemID = streamingSystemMessageByItemID.filter { _, messageId in
            guard let index = findMessageIndex(threadId: threadId, messageId: messageId),
                  let message = messagesByThread[threadId]?[index] else {
                return false
            }
            guard message.role == .system else {
                return true
            }
            if message.kind == .thinking {
                return false
            }
            if let resolvedTurnId {
                return message.turnId != resolvedTurnId
            }
            return !message.isStreaming
        }

        // Keep turn->thread mapping after completion to support late-arriving
        // notifications (e.g. turn/diff/updated emitted right after turn/completed).
        persistMessages()
        updateCurrentOutput(for: threadId)
    }

    // Converts all pending streaming bubbles to completed state after transport failures.
    func finalizeAllStreamingState() {
        flushAllPendingStreamingDeltas()
        var didMutate = false

        for threadId in messagesByThread.keys {
            guard var threadMessages = messagesByThread[threadId] else { continue }

            var localChanged = false
            for index in threadMessages.indices where threadMessages[index].isStreaming {
                threadMessages[index].isStreaming = false
                if var review = threadMessages[index].autoApprovalReview,
                   review.status == .inProgress {
                    review.status = .aborted
                    review.completedAtMs = Int(Date().timeIntervalSince1970 * 1_000)
                    threadMessages[index].autoApprovalReview = review
                }
                localChanged = true
            }

            if localChanged {
                messagesByThread[threadId] = threadMessages
                didMutate = true
            }
        }

        activeTurnId = nil
        activeTurnIdByThread.removeAll()
        threadsPendingCompletionHaptic.removeAll()
        clearAllRunningState()
        streamingAssistantFallbackMessageByTurnID.removeAll()
        streamingAssistantMessageByItemKey.removeAll()
        streamingSystemMessageByItemID.removeAll()
        pendingAssistantDeltaByStreamID.removeAll()
        pendingAssistantDeltaContextByStreamID.removeAll()
        pendingAssistantDeltaStreamOrder.removeAll()
        pendingAssistantDeltaFlushTask?.cancel()
        pendingAssistantDeltaFlushTask = nil
        threadIdByTurnID.removeAll()

        if didMutate {
            persistCurrentMacMessages()
            if let activeThreadId {
                updateCurrentOutput(for: activeThreadId)
            }
        }
    }
}
