// FILE: CodexService+IncomingThreadStatus.swift
// Purpose: Incoming thread status and context-usage notifications.
// Layer: Service
// Exports: CodexService thread status handlers

import Foundation

extension CodexService {
    func handleThreadTokenUsageUpdated(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let usageObject = paramsObject?["usage"]?.objectValue
            ?? eventObject?["usage"]?.objectValue
            ?? paramsObject

        guard let usage = extractContextWindowUsage(from: usageObject) else { return }
        contextWindowUsageByThread[threadId] = usage
    }

    func handleThreadStatusChanged(_ paramsObject: IncomingParamsObject?) {
        guard let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty else {
            return
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject?["event"]?.objectValue
        let statusObject = paramsObject?["status"]?.objectValue
            ?? eventObject?["status"]?.objectValue
            ?? nestedEventObject?["status"]?.objectValue

        let rawStatusType = firstNonEmptyString([
            firstStringValue(in: statusObject, keys: ["type", "statusType", "status_type"]),
            firstStringValue(in: paramsObject, keys: ["status"]),
            firstStringValue(in: eventObject, keys: ["status"]),
            firstStringValue(in: nestedEventObject, keys: ["status"]),
        ]) ?? ""

        let normalizedStatusType = normalizeThreadStatusType(rawStatusType)

        if normalizedStatusType == "active"
            || normalizedStatusType == "running"
            || normalizedStatusType == "processing"
            || normalizedStatusType == "inprogress"
            || normalizedStatusType == "started"
            || normalizedStatusType == "pending" {
            guard !isApplyingReplayedBridgeEvent else {
                return
            }
            markThreadAsRunning(threadId)
            return
        }

        if normalizedStatusType == "idle"
            || normalizedStatusType == "notloaded"
            || normalizedStatusType == "completed"
            || normalizedStatusType == "done"
            || normalizedStatusType == "finished"
            || normalizedStatusType == "stopped"
            || normalizedStatusType == "systemerror" {
            if activeTurnIdByThread[threadId] != nil
                || protectedRunningFallbackThreadIDs.contains(threadId)
                || hasStreamingMessage(in: threadId) {
                return
            }

            let activeTurnIdForThread = activeTurnIdByThread[threadId]
            let terminalState = threadTerminalState(from: normalizedStatusType)
            if let terminalState {
                recordTurnTerminalState(
                    threadId: threadId,
                    turnId: activeTurnIdForThread,
                    state: terminalState
                )
                noteTurnFinished(threadId: threadId, turnId: activeTurnIdForThread)
                if let completionResult = runCompletionResult(for: terminalState) {
                    notifyRunCompletionIfNeeded(
                        threadId: threadId,
                        turnId: activeTurnIdForThread,
                        result: completionResult
                    )
                }
            }
            markTurnCompleted(threadId: threadId, turnId: activeTurnIdForThread)
            clearRunningState(for: threadId)

            if normalizedStatusType.contains("error") {
                markFailedIfUnread(threadId: threadId)
            }
        }
    }
}
