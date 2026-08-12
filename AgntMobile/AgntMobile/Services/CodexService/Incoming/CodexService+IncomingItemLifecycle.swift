// FILE: CodexService+IncomingItemLifecycle.swift
// Purpose: Structured incoming item lifecycle routing.
// Layer: Service
// Exports: CodexService structured item lifecycle handler

import Foundation

extension CodexService {
    func handleStructuredItemLifecycle(
        itemObject: IncomingParamsObject,
        paramsObject: IncomingParamsObject?,
        itemType: String,
        isCompleted: Bool
    ) -> Bool {
        guard itemType == "reasoning"
            || itemType == "filechange"
            || isGenericToolCallItemType(itemType)
            || itemType == "commandexecution"
            || itemType == "collabagenttoolcall"
            || itemType == "collabtoolcall"
            || itemType.hasPrefix("collabagentspawn")
            || itemType.hasPrefix("collabwaiting")
            || itemType.hasPrefix("collabclose")
            || itemType.hasPrefix("collabresume")
            || itemType.hasPrefix("collabagentinteraction")
            || itemType == "diff"
            || itemType == "plan"
            || itemType == "todolist"
            || itemType == "enteredreviewmode"
            || itemType == "contextcompaction" else {
            return false
        }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return true
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject)

        let kind: CodexMessageKind
        let body: String
        var planState: CodexPlanState? = nil
        switch itemType {
        case "reasoning":
            kind = .thinking
            body = decodeReasoningItemBody(itemObject)
        case "filechange":
            kind = .fileChange
            body = decodeFileChangeItemBody(itemObject)
        case let toolType where isGenericToolCallItemType(toolType):
            if let resolvedBody = decodeToolCallFileChangeBody(itemObject, isCompleted: isCompleted) {
                kind = .fileChange
                body = resolvedBody
            } else if let resolvedBody = decodeToolCallActivityBody(itemObject, isCompleted: isCompleted) {
                kind = .toolActivity
                body = resolvedBody
            } else {
                return false
            }
        case "commandexecution":
            kind = .commandExecution
            body = decodeCommandExecutionStatusText(itemObject, isCompleted: isCompleted)
        case let collabType where collabType == "collabagenttoolcall"
            || collabType == "collabtoolcall"
            || collabType.hasPrefix("collabagentspawn")
            || collabType.hasPrefix("collabwaiting")
            || collabType.hasPrefix("collabclose")
            || collabType.hasPrefix("collabresume")
            || collabType.hasPrefix("collabagentinteraction"):
            guard let subagentAction = decodeSubagentActionItem(from: itemObject) else {
                return false
            }
            upsertSubagentActionMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                action: subagentAction,
                isStreaming: !isCompleted
            )
            return true
        case "diff":
            guard let resolvedBody = decodeDiffItemBody(itemObject, isCompleted: isCompleted) else {
                return false
            }
            kind = .fileChange
            body = resolvedBody
        case "plan", "todolist":
            kind = .plan
            body = decodePlanItemBody(itemObject)
            planState = decodePlanState(from: itemObject)
        case "enteredreviewmode":
            kind = .commandExecution
            let reviewLabel = firstNonEmptyString([
                itemObject["review"]?.stringValue,
                firstString(forKey: "review", in: .object(itemObject)),
            ]) ?? "changes"
            body = "Reviewing \(reviewLabel)..."
        case "contextcompaction":
            kind = .commandExecution
            body = isCompleted ? "Context compacted" : "Compacting context…"
        default:
            kind = .fileChange
            body = ""
        }

        if isCompleted,
           kind == .fileChange,
           let turnId,
           let patch = extractChangeSetUnifiedPatch(from: itemObject, itemType: itemType) {
            recordFallbackFileChangePatch(threadId: threadId, turnId: turnId, patch: patch)
        }

        if kind == .plan {
            guard CodexPlanUpdateVisibilityPolicy.shouldApply(
                text: body,
                planState: planState
            ) else {
                if isCompleted {
                    finalizeExistingPlanMessage(
                        threadId: threadId,
                        turnId: turnId,
                        itemId: itemId
                    )
                }
                return true
            }
            upsertPlanMessage(
                threadId: threadId,
                turnId: turnId,
                itemId: itemId,
                text: body,
                explanation: planState?.explanation,
                steps: planState?.steps,
                isStreaming: !isCompleted,
                planPresentation: isCompleted ? .resultCompletedItem : .resultStreaming
            )
            return true
        }

        if let itemId, !itemId.isEmpty {
            if isCompleted {
                completeStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: kind,
                    text: body
                )
            } else {
                upsertStreamingSystemItemMessage(
                    threadId: threadId,
                    turnId: turnId,
                    itemId: itemId,
                    kind: kind,
                    text: body,
                    isStreaming: true
                )
            }
            return true
        }

        if let turnId, !turnId.isEmpty {
            if isCompleted {
                completeStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: kind,
                    text: body
                )
            } else {
                upsertStreamingSystemTurnMessage(
                    threadId: threadId,
                    turnId: turnId,
                    kind: kind,
                    text: body,
                    isStreaming: true
                )
            }
            return true
        }

        appendSystemMessage(
            threadId: threadId,
            text: body,
            turnId: turnId,
            kind: kind,
            isStreaming: !isCompleted
        )
        return true
    }
}
