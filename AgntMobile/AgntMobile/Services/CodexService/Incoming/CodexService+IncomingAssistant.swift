// FILE: CodexService+IncomingAssistant.swift
// Purpose: Handles assistant-specific incoming events (delta/start/completed) and identity normalization.
// Layer: Service
// Exports: CodexService assistant incoming handlers
// Depends on: CodexService+Incoming shared routing helpers

import Foundation

struct AssistantEventIdentity {
    let turnId: String?
    let itemId: String?
    let phase: String?
}

struct AssistantEventContext {
    let threadId: String
    let identity: AssistantEventIdentity
}

extension CodexService {
    // Appends streaming assistant text deltas from stable + legacy namespaces.
    func appendAgentDelta(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        guard let delta = extractAssistantDeltaText(
            from: paramsObject,
            eventObject: eventObject
        ) else { return }

        guard let context = resolveAssistantEventContext(
            paramsObject: paramsObject,
            eventObject: eventObject,
            allowsActiveTurnFallback: true,
            requiresTurnId: true
        ),
        let turnId = context.identity.turnId else {
            return
        }

        if !isApplyingReplayedBridgeEvent {
            markThreadAsRunning(context.threadId)
            clearMirroredRunningCatchupNeeded(for: context.threadId)
        }
        appendAssistantDelta(
            threadId: context.threadId,
            turnId: turnId,
            itemId: context.identity.itemId,
            assistantPhase: context.identity.phase,
            delta: delta
        )
    }

    // Mirrors a user message coming from a desktop-origin rollout so reopened
    // threads can show the prompt before the next history reconciliation.
    func appendMirroredUserMessage(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let text = firstNonEmptyString([
            paramsObject["message"]?.stringValue,
            paramsObject["text"]?.stringValue,
        ])
        guard let text else { return }
        let createdAt = decodeHistoryTimestamp(from: paramsObject)

        markMirroredRunningCatchupNeeded(for: threadId)
        appendConfirmedMirroredUserMessage(
            threadId: threadId,
            turnId: turnId,
            text: text,
            createdAt: createdAt
        )
    }

    // Finalizes assistant text when item completion carries canonical content.
    func appendCompletedAgentText(from paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject)
        guard let itemObject else {
            // Some legacy codex/event notifications carry only plain final message text.
            let text = paramsObject["message"]?.stringValue
                ?? eventObject?["message"]?.stringValue
            guard let text,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return
            }

            guard let context = resolveAssistantEventContext(
                paramsObject: paramsObject,
                eventObject: eventObject
            ) else { return }
            let turnId = assistantCompletionTurnId(
                context: context,
                paramsObject: paramsObject,
                eventObject: eventObject,
                itemObject: nil
            )
            completeAssistantMessage(
                threadId: context.threadId,
                turnId: turnId,
                itemId: context.identity.itemId,
                assistantPhase: context.identity.phase,
                text: text
            )
            return
        }

        let itemType = normalizedItemType(itemObject["type"]?.stringValue ?? "")
        if handleMirroredUserMessageItem(
            itemObject: itemObject,
            paramsObject: paramsObject,
            itemType: itemType
        ) {
            return
        }

        if isCompletedGeneratedImageItemType(itemType) {
            appendCompletedGeneratedImageItem(
                itemObject: itemObject,
                paramsObject: paramsObject,
                eventObject: eventObject
            )
            return
        }

        if handleStructuredItemLifecycle(
            itemObject: itemObject,
            paramsObject: paramsObject,
            itemType: itemType,
            isCompleted: true
        ) {
            return
        }

        if itemType == "exitedreviewmode" {
            guard let text = extractCompletedReviewText(from: itemObject), !text.isEmpty else {
                return
            }

            guard let context = resolveAssistantEventContext(
                paramsObject: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject
            ) else { return }
            completeAssistantMessage(
                threadId: context.threadId,
                turnId: context.identity.turnId,
                itemId: context.identity.itemId,
                assistantPhase: context.identity.phase,
                text: text
            )
            return
        }

        guard isAssistantMessageItem(
            itemType: itemType,
            role: itemObject["role"]?.stringValue
        ) else {
            return
        }

        let text = extractIncomingMessageText(from: itemObject)
        if let input = CodexAsyncUserInput.decode(from: itemObject),
           let context = resolveAssistantEventContext(paramsObject: paramsObject, eventObject: eventObject, itemObject: itemObject) {
            upsertAsyncUserInput(input, threadId: context.threadId, turnId: context.identity.turnId,
                                itemId: context.identity.itemId, text: text, completed: true)
            return
        }
        guard !text.isEmpty else { return }

        guard let context = resolveAssistantEventContext(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        ) else { return }
        let turnId = assistantCompletionTurnId(
            context: context,
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        )
        completeAssistantMessage(
            threadId: context.threadId,
            turnId: turnId,
            itemId: context.identity.itemId,
            assistantPhase: context.identity.phase,
            text: text
        )
    }

    func isCompletedGeneratedImageItemType(_ itemType: String) -> Bool {
        itemType == "imagegeneration"
            || itemType == "imagegenerationcall"
            || itemType == "imagegenerationend"
            || itemType == "imageview"
    }

    // Converts live generated-image completion items into the same markdown preview used by history.
    func appendCompletedGeneratedImageItem(
        itemObject: IncomingParamsObject,
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?
    ) {
        let itemType = normalizedItemType(itemObject["type"]?.stringValue ?? "")
        let itemId = extractAssistantMessageItemID(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        ) ?? ""
        let imagePath = firstNonEmptyString([
            firstStringValue(in: itemObject, keys: ["saved_path", "savedPath", "path", "file_path"]),
            firstStringValue(in: eventObject, keys: ["saved_path", "savedPath", "path", "file_path"]),
            firstStringValue(in: paramsObject, keys: ["saved_path", "savedPath", "path", "file_path"])
        ])
        guard let imagePath, Self.isGeneratedImagePath(imagePath) else {
            debugRuntimeLog("generated image item dropped type=\(itemType) item=\(itemId) reason=missing-path")
            return
        }

        guard let context = resolveAssistantEventContext(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        ) else {
            debugRuntimeLog("generated image item dropped type=\(itemType) item=\(itemId) path=\(URL(fileURLWithPath: imagePath).lastPathComponent) reason=missing-context")
            return
        }

        appendGeneratedImageReference(
            threadId: context.threadId,
            turnId: context.identity.turnId,
            itemId: context.identity.itemId,
            imagePath: imagePath
        )
        debugRuntimeLog("generated image item appended type=\(itemType) thread=\(context.threadId) turn=\(context.identity.turnId ?? "") item=\(context.identity.itemId ?? "") path=\(URL(fileURLWithPath: imagePath).lastPathComponent)")
    }

    // Creates streaming assistant placeholder when an assistant item starts.
    func handleItemStarted(_ paramsObject: IncomingParamsObject?) {
        guard let paramsObject else { return }
        let eventObject = envelopeEventObject(from: paramsObject)

        guard let itemObject = extractIncomingItemObject(from: paramsObject, eventObject: eventObject) else {
            return
        }

        let lifecycleTurnID = extractTurnID(from: paramsObject)
        let lifecycleThreadID = resolveThreadID(from: paramsObject, turnIdHint: lifecycleTurnID)
        if lifecycleTurnID == nil,
           let lifecycleThreadID,
           !threadHasActiveOrRunningTurn(lifecycleThreadID) {
            return
        }
        if let lifecycleThreadID {
            markThreadAsRunning(lifecycleThreadID)
        }

        let itemType = normalizedItemType(itemObject["type"]?.stringValue ?? "")
        if handleMirroredUserMessageItem(
            itemObject: itemObject,
            paramsObject: paramsObject,
            itemType: itemType
        ) {
            return
        }

        if handleStructuredItemLifecycle(
            itemObject: itemObject,
            paramsObject: paramsObject,
            itemType: itemType,
            isCompleted: false
        ) {
            return
        }

        if itemType == "exitedreviewmode" {
            guard let context = resolveAssistantEventContext(
                paramsObject: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject,
                allowsActiveTurnFallback: true,
                requiresTurnId: true
            ),
            let turnId = context.identity.turnId else {
                return
            }
            beginAssistantMessage(
                threadId: context.threadId,
                turnId: turnId,
                itemId: context.identity.itemId,
                assistantPhase: context.identity.phase
            )
            return
        }

        guard isAssistantMessageItem(
            itemType: itemType,
            role: itemObject["role"]?.stringValue
        ) else {
            return
        }

        guard let context = resolveAssistantEventContext(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject,
            allowsActiveTurnFallback: true,
            requiresTurnId: true
        ),
        let turnId = context.identity.turnId else {
            return
        }
        if let input = CodexAsyncUserInput.decode(from: itemObject) {
            upsertAsyncUserInput(input, threadId: context.threadId, turnId: turnId,
                                itemId: context.identity.itemId, text: extractIncomingMessageText(from: itemObject), completed: false)
            return
        }
        beginAssistantMessage(
            threadId: context.threadId,
            turnId: turnId,
            itemId: context.identity.itemId,
            assistantPhase: context.identity.phase
        )
    }
}

private extension CodexService {
    // Desktop mirrors can deliver user prompts as item lifecycle events instead
    // of the explicit codex/event/user_message path. Upsert them immediately so
    // the prompt row is visible before the next history reconciliation.
    func handleMirroredUserMessageItem(
        itemObject: IncomingParamsObject,
        paramsObject: IncomingParamsObject,
        itemType: String
    ) -> Bool {
        guard isDesktopMirroredBridgeEvent(paramsObject) else {
            return false
        }

        let role = itemObject["role"]?.stringValue?.lowercased() ?? ""
        let isUserMessage = itemType == "usermessage"
            || (itemType == "message" && role.contains("user"))
        guard isUserMessage else {
            return false
        }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return true
        }
        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }

        let text = extractIncomingMessageText(from: itemObject)
        guard !text.isEmpty else {
            return true
        }

        markMirroredRunningCatchupNeeded(for: threadId)
        appendConfirmedMirroredUserMessage(
            threadId: threadId,
            turnId: turnId,
            text: text,
            createdAt: decodeHistoryTimestamp(from: paramsObject)
        )
        return true
    }

    func isDesktopMirroredBridgeEvent(_ paramsObject: IncomingParamsObject) -> Bool {
        paramsObject["agntDesktopMirror"]?.boolValue == true
            || paramsObject["agntDesktopIpcMirror"]?.boolValue == true
            || paramsObject["agntActionSource"]?.stringValue == "desktop-ipc-action-follower"
            || paramsObject["agntActionSource"]?.stringValue == "desktop-ipc-live-owner"
            || paramsObject["remodexDesktopMirror"]?.boolValue == true
            || paramsObject["remodexDesktopIpcMirror"]?.boolValue == true
            || paramsObject["remodexActionSource"]?.stringValue == "desktop-ipc-action-follower"
            || paramsObject["remodexActionSource"]?.stringValue == "desktop-ipc-live-owner"
    }
}
