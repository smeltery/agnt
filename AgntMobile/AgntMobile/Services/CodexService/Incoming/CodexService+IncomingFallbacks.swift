// FILE: CodexService+IncomingFallbacks.swift
// Purpose: Incoming fallback lifecycle and resolved-request handlers.
// Layer: Service
// Exports: CodexService fallback lifecycle handlers

import Foundation

extension CodexService {
    func handleFileChangeLifecycleFallback(
        _ paramsObject: IncomingParamsObject?,
        isCompleted: Bool
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        if let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject) {
            _ = handleStructuredItemLifecycle(
                itemObject: itemObject,
                paramsObject: paramsObject,
                itemType: "filechange",
                isCompleted: isCompleted
            )
            return
        }

        let payloadObject = eventObject ?? paramsObject
        let body = decodeFileChangeItemBody(payloadObject)
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }

        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let itemId = extractItemID(from: paramsObject, eventObject: eventObject)
        if let itemId, !itemId.isEmpty {
            if isCompleted {
                completeStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .fileChange,
                    text: body
                )
            } else {
                upsertStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: .fileChange,
                    text: body,
                    isStreaming: true
                )
            }
            return
        }

        if let turnId, !turnId.isEmpty {
            if isCompleted {
                completeStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .fileChange,
                    text: body
                )
            } else {
                upsertStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: .fileChange,
                    text: body,
                    isStreaming: true
                )
            }
            return
        }

        appendSystemMessage(
            threadId: threadId,
            text: body,
            turnId: turnId,
            kind: .fileChange,
            isStreaming: !isCompleted
        )
    }

    func handleToolCallLifecycleFallback(
        _ paramsObject: IncomingParamsObject?,
        isCompleted: Bool
    ) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        if let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject) {
            _ = handleStructuredItemLifecycle(
                itemObject: itemObject,
                paramsObject: paramsObject,
                itemType: "toolcall",
                isCompleted: isCompleted
            )
            return
        }

        let payloadObject = eventObject ?? paramsObject
        _ = handleStructuredItemLifecycle(
            itemObject: payloadObject,
            paramsObject: paramsObject,
            itemType: "toolcall",
            isCompleted: isCompleted
        )
    }

    func handleServerRequestResolved(_ paramsObject: IncomingParamsObject?) {
        guard let requestID = paramsObject?["requestId"] else {
            return
        }

        let threadId = normalizedResolvedRequestThreadID(paramsObject?["threadId"]?.stringValue)
        removeStructuredUserInputPrompt(requestID: requestID, threadIdHint: threadId)
        removePendingApproval(requestID: requestID)
    }

    func handleGitStackedActionProgress(_ paramsObject: IncomingParamsObject?) {
        guard let progressId = paramsObject?["progressId"]?.stringValue,
              let phase = paramsObject?["phase"]?.stringValue,
              let status = paramsObject?["status"]?.stringValue else {
            return
        }
        gitStackedActionProgressHandlers[progressId]?(phase, status)
    }

    func registerGitStackedActionProgressHandler(
        progressId: String,
        handler: @escaping (String, String) -> Void
    ) {
        gitStackedActionProgressHandlers[progressId] = handler
    }

    func unregisterGitStackedActionProgressHandler(progressId: String) {
        gitStackedActionProgressHandlers.removeValue(forKey: progressId)
    }
}
