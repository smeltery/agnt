// FILE: CodexService+IncomingTurnLifecycle.swift
// Purpose: Incoming turn lifecycle and terminal-state handling.
// Layer: Service
// Exports: CodexService turn lifecycle handlers

import Foundation

extension CodexService {
    func handleTurnStarted(_ paramsObject: IncomingParamsObject?) {
        let threadId = resolveThreadID(from: paramsObject)
        let turnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        let isReplayedEvent = isReplayedBridgeEvent(paramsObject)
        let previousActiveTurnID = threadId.flatMap { activeTurnIdByThread[$0] }
        let wasThreadRunning = threadId.map { threadHasActiveOrRunningTurn($0) } ?? false

        if let threadId, !isReplayedEvent {
            let previousKnownTurnID = streamRecovery.lastStartedTurnIDs[threadId] ?? previousActiveTurnID
            let repeatsKnownTurn = turnID != nil && turnID == previousKnownTurnID
            let startsDistinctTurn = turnID != nil && previousKnownTurnID != nil && turnID != previousKnownTurnID
            if !repeatsKnownTurn && (!wasThreadRunning || startsDistinctTurn || (turnID == nil && previousActiveTurnID != nil)) {
                streamRecovery.runGenerations[threadId, default: 0] += 1
                streamRecovery.failures.removeValue(forKey: threadId)
            }
            if let turnID { streamRecovery.lastStartedTurnIDs[threadId] = turnID }
            else if !wasThreadRunning || previousActiveTurnID != nil {
                streamRecovery.lastStartedTurnIDs.removeValue(forKey: threadId)
            }
            markThreadAsRunning(threadId)
        }

        if let threadId, let turnID {
            promoteProvisionalIDLessTurnIfNeeded(threadId: threadId, canonicalTurnID: turnID)
            if let previousActiveTurnID,
               previousActiveTurnID != turnID,
               !isReplayedEvent {
                displacedActiveTurnIDsByThread[threadId, default: []].insert(previousActiveTurnID)
            }
            supersededTurnIDsByIDLessRunByThread.removeValue(forKey: threadId)
            threadIdByTurnID[turnID] = threadId
            confirmLatestPendingUserMessage(threadId: threadId, turnId: turnID)
            if !isReplayedEvent {
                setActiveTurnID(turnID, for: threadId)
                setProtectedRunningFallback(false, for: threadId)
            }
        } else if let threadId, !isReplayedEvent {
            if let previousActiveTurnID, wasThreadRunning {
                var supersededTurnIDs = displacedActiveTurnIDsByThread.removeValue(forKey: threadId) ?? []
                supersededTurnIDs.insert(previousActiveTurnID)
                supersededTurnIDsByIDLessRunByThread[threadId] = supersededTurnIDs
                setActiveTurnID(nil, for: threadId)
                if activeTurnId == previousActiveTurnID {
                    activeTurnId = nil
                }
            }
            _ = provisionalIDLessTurnID(for: threadId, startsNewRun: !wasThreadRunning)
            setProtectedRunningFallback(true, for: threadId)
        }

        if let turnID, !isReplayedEvent {
            activeTurnId = turnID
        }

        requestImmediateSync(threadId: threadId ?? activeThreadId)
    }

    func handleTurnCompleted(_ paramsObject: IncomingParamsObject?) {
        let completedTurnID = extractTurnIDForTurnLifecycleEvent(from: paramsObject)
        if completedTurnID == nil, isHistoricalCompletionEvent(paramsObject) { return }
        let turnFailureMessage = parseTurnFailureMessage(from: paramsObject)

        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: completedTurnID) {
            if reconcileRepeatedStreamFailure(threadId: threadId, turnId: completedTurnID) { return }
            let notificationTurnID = trackedCompletionNotificationTurnID(
                threadId: threadId, turnId: completedTurnID, paramsObject: paramsObject
            )
            if let completedTurnID {
                promoteProvisionalIDLessTurnIfNeeded(threadId: threadId, canonicalTurnID: completedTurnID)
                confirmLatestPendingUserMessage(threadId: threadId, turnId: completedTurnID)
            }
            let resolvedTurnID = completedTurnID
                ?? activeTurnIdByThread[threadId]
                ?? provisionalIDLessTurnIDByThread[threadId]
            let terminalState = parseTurnTerminalState(
                from: paramsObject,
                turnFailureMessage: turnFailureMessage
            )
            if terminalState == .failed, let turnFailureMessage, !isHistoricalCompletionEvent(paramsObject) {
                recordRecoverableStreamFailure(
                    threadId: threadId, turnId: resolvedTurnID, message: turnFailureMessage,
                    errorInfo: paramsObject?["turn"]?.objectValue?["error"]?.objectValue?["codexErrorInfo"]
                        ?? paramsObject?["error"]?.objectValue?["codexErrorInfo"]
                )
            }
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: terminalState)
            noteTurnFinished(threadId: threadId, turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            if terminalState == .completed {
                Task { @MainActor [weak self] in
                    await self?.captureTurnEndWorkspaceCheckpointIfPossible(
                        threadId: threadId,
                        turnId: resolvedTurnID
                    )
                }
                markReadyIfUnread(threadId: threadId)
                if let notificationTurnID, isSuccessfulCompletionNotification(paramsObject) {
                    notifyRunCompletionIfNeeded(threadId: threadId, turnId: notificationTurnID, result: .completed)
                }
            } else if terminalState == .failed {
                discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
                markFailedIfUnread(threadId: threadId)
                if let notificationTurnID {
                    notifyRunCompletionIfNeeded(threadId: threadId, turnId: notificationTurnID, result: .failed)
                }
            } else {
                discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
            }
            requestImmediateSync(threadId: threadId)
            Task { await flushQueuedAsyncUserInput(threadId: threadId) }
            if terminalState == .completed {
                scheduleAppReviewPromptAfterSuccessfulRun(threadId: threadId, turnId: resolvedTurnID)
            }

            guard let turnFailureMessage else {
                return
            }

            let userFacingFailureMessage = userFacingRuntimeMessage(for: turnFailureMessage)
                ?? turnFailureMessage
            lastErrorMessage = shouldSuppressRuntimeMessageInChat(turnFailureMessage) ? nil : userFacingFailureMessage
            if !shouldSuppressRuntimeMessageInChat(turnFailureMessage) {
                appendSystemMessage(
                    threadId: threadId,
                    text: "Turn error: \(userFacingFailureMessage)",
                    turnId: completedTurnID
                )
            }
            return
        }

        finalizeAllStreamingState()

        guard let turnFailureMessage else {
            return
        }
        lastErrorMessage = shouldSuppressRuntimeMessageInChat(turnFailureMessage)
            ? nil
            : (userFacingRuntimeMessage(for: turnFailureMessage) ?? turnFailureMessage)
    }

    func scheduleAppReviewPromptAfterSuccessfulRun(threadId: String, turnId: String?) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.appReviewPromptCoordinator.noteSuccessfulRun(
                threadId: threadId,
                turnId: turnId,
                isCurrentThreadVisible: self.activeThreadId == threadId
            )
        }
    }

    func handleErrorNotification(_ paramsObject: IncomingParamsObject?) {
        if extractTurnID(from: paramsObject) == nil, isHistoricalCompletionEvent(paramsObject) { return }
        if shouldRetryTurnError(from: paramsObject) {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let paramsErrorObject = paramsObject?["error"]?.objectValue
        let eventErrorObject = eventObject?["error"]?.objectValue
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let errorMessage = firstNonEmptyString([
            firstStringValue(in: paramsObject, keys: ["message"]),
            firstStringValue(in: paramsErrorObject, keys: ["message"]),
            firstStringValue(in: eventObject, keys: ["message"]),
            firstStringValue(in: eventErrorObject, keys: ["message"]),
            firstStringValue(in: nestedEventObject, keys: ["message"]),
        ]) ?? "Server error"
        let shouldSuppressErrorMessage = shouldSuppressRuntimeMessageInChat(errorMessage)
        let userFacingErrorMessage = userFacingRuntimeMessage(for: errorMessage) ?? errorMessage

        let turnId = extractTurnID(from: paramsObject)
        if let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) {
            let resolvedTurnID = turnId ?? activeTurnIdByThread[threadId]
            if reconcileRepeatedStreamFailure(threadId: threadId, turnId: resolvedTurnID) { return }
            if !isHistoricalCompletionEvent(paramsObject) {
                recordRecoverableStreamFailure(
                    threadId: threadId, turnId: resolvedTurnID, message: errorMessage,
                    errorInfo: paramsErrorObject?["codexErrorInfo"] ?? eventErrorObject?["codexErrorInfo"]
                )
            }
            let notificationTurnID = trackedCompletionNotificationTurnID(
                threadId: threadId, turnId: resolvedTurnID, paramsObject: paramsObject
            )
            if !shouldSuppressErrorMessage {
                lastErrorMessage = userFacingErrorMessage
                appendSystemMessage(threadId: threadId, text: "Error: \(userFacingErrorMessage)", turnId: turnId)
            }
            recordTurnTerminalState(threadId: threadId, turnId: resolvedTurnID, state: .failed)
            noteTurnFinished(threadId: threadId, turnId: resolvedTurnID)
            markTurnCompleted(threadId: threadId, turnId: resolvedTurnID)
            discardTurnStartWorkspaceCheckpointCopyIfNeeded(turnId: resolvedTurnID)
            markFailedIfUnread(threadId: threadId)
            if let notificationTurnID {
                notifyRunCompletionIfNeeded(threadId: threadId, turnId: notificationTurnID, result: .failed)
            }
        } else {
            lastErrorMessage = shouldSuppressErrorMessage ? nil : userFacingErrorMessage
            finalizeAllStreamingState()
        }
    }

    func parseTurnTerminalState(
        from paramsObject: IncomingParamsObject?,
        turnFailureMessage: String?
    ) -> CodexTurnTerminalState {
        if turnFailureMessage != nil {
            return .failed
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let turnObject = paramsObject?["turn"]?.objectValue
        let statusObject = turnObject?["status"]?.objectValue
            ?? paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue

        let rawStatus = firstNonEmptyString([
            firstStringValue(in: turnObject, keys: ["status"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
        ]) ?? ""

        let normalizedStatus = normalizeThreadStatusType(rawStatus)
        if normalizedStatus.contains("cancel")
            || normalizedStatus.contains("abort")
            || normalizedStatus.contains("interrupt")
            || normalizedStatus.contains("stopped") {
            return .stopped
        }
        if normalizedStatus.contains("fail")
            || normalizedStatus.contains("error") {
            return .failed
        }
        return .completed
    }

    func runCompletionResult(for state: CodexTurnTerminalState) -> CodexRunCompletionResult? {
        switch state {
        case .completed:
            .completed
        case .failed:
            .failed
        case .stopped:
            nil
        }
    }

    func parseTurnFailureMessage(from paramsObject: IncomingParamsObject?) -> String? {
        let turnObject = paramsObject?["turn"]?.objectValue
        let status = turnObject?["status"]?.stringValue
            ?? paramsObject?["status"]?.stringValue

        guard status == "failed" else {
            return nil
        }

        return turnObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["error"]?.objectValue?["message"]?.stringValue
            ?? paramsObject?["errorMessage"]?.stringValue
            ?? "Turn failed with no details"
    }
}
