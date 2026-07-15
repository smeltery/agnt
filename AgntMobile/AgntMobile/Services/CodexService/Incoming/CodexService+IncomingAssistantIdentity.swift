// FILE: CodexService+IncomingAssistantIdentity.swift
// Purpose: Resolves assistant incoming event identity and item classification.
// Layer: Service
// Exports: CodexService assistant event identity helpers
// Depends on: CodexService+Incoming shared routing helpers

import Foundation

extension CodexService {
    // Extracts assistant delta text across stable + legacy codex/event envelopes.
    func extractAssistantDeltaText(
        from paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?
    ) -> String? {
        let delta = paramsObject["delta"]?.stringValue
            ?? eventObject?["delta"]?.stringValue
            ?? paramsObject["event"]?.objectValue?["delta"]?.stringValue
        guard let delta else {
            return nil
        }
        return delta.isEmpty ? nil : delta
    }

    // Normalizes assistant turn/item identity before routing to timeline state.
    func extractAssistantEventIdentity(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> AssistantEventIdentity {
        let turnId = extractTurnID(from: paramsObject)
            ?? extractLegacyTurnIDForAgentEvent(
                from: paramsObject,
                eventObject: eventObject
            )
        let itemId = extractAssistantMessageItemID(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        )
        return AssistantEventIdentity(
            turnId: turnId,
            itemId: itemId,
            phase: extractAssistantPhase(
                paramsObject: paramsObject,
                eventObject: eventObject,
                itemObject: itemObject
            )
        )
    }

    // Resolves assistant event context and preserves turn->thread mapping when available.
    func resolveAssistantEventContext(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil,
        requiresTurnId: Bool = false
    ) -> AssistantEventContext? {
        let identity = extractAssistantEventIdentity(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        )

        if requiresTurnId, identity.turnId == nil {
            return nil
        }

        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: identity.turnId) else {
            return nil
        }

        if let turnId = identity.turnId {
            threadIdByTurnID[turnId] = threadId
        }

        return AssistantEventContext(threadId: threadId, identity: identity)
    }

    // Codex app-server can emit final_answer text before task_complete without
    // repeating turnId; bind that terminal text to the active turn for this thread.
    func assistantCompletionTurnId(
        context: AssistantEventContext,
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject?
    ) -> String? {
        if let turnId = context.identity.turnId {
            return turnId
        }
        guard isFinalAnswerPhase(paramsObject: paramsObject, eventObject: eventObject, itemObject: itemObject) else {
            return nil
        }
        return activeTurnIdByThread[context.threadId]
    }

    func isFinalAnswerPhase(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject?
    ) -> Bool {
        let phase = extractAssistantPhase(
            paramsObject: paramsObject,
            eventObject: eventObject,
            itemObject: itemObject
        )
        return phase == "final_answer"
    }

    func extractAssistantPhase(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject?
    ) -> String? {
        normalizedAssistantPhase(firstNonEmptyString([
            paramsObject["phase"]?.stringValue,
            eventObject?["phase"]?.stringValue,
            itemObject?["phase"]?.stringValue,
            paramsObject["event"]?.objectValue?["phase"]?.stringValue,
        ]))
    }

    // Checks if an incoming item payload should render as assistant prose.
    func isAssistantMessageItem(itemType: String, role: String?) -> Bool {
        let normalizedRole = role?.lowercased() ?? ""
        return itemType == "agentmessage"
            || itemType == "assistantmessage"
            || itemType == "exitedreviewmode"
            || (itemType == "message" && !normalizedRole.contains("user"))
    }

    // Review mode exits deliver the final review text under `review` instead of message content.
    func extractCompletedReviewText(from itemObject: IncomingParamsObject) -> String? {
        let reviewText = firstNonEmptyString([
            itemObject["review"]?.stringValue,
            firstString(forKey: "review", in: .object(itemObject)),
        ])
        return reviewText?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Legacy codex/event assistant notifications can encode turn id in params.id.
    func extractLegacyTurnIDForAgentEvent(
        from paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?
    ) -> String? {
        if let turnId = normalizedIdentifier(paramsObject["id"]?.stringValue),
           paramsObject["msg"] != nil || paramsObject["event"] != nil {
            return turnId
        }

        if let turnId = normalizedIdentifier(eventObject?["turn"]?.objectValue?["id"]?.stringValue) {
            return turnId
        }

        if let turnId = normalizedIdentifier(
            paramsObject["event"]?.objectValue?["turn"]?.objectValue?["id"]?.stringValue
        ) {
            return turnId
        }

        return nil
    }

    // Assistant payloads can carry ids across item_id/message_id/id variants.
    func extractAssistantMessageItemID(
        paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        let candidates: [String?] = [
            itemObject?["id"]?.stringValue,
            itemObject?["itemId"]?.stringValue,
            itemObject?["item_id"]?.stringValue,
            itemObject?["messageId"]?.stringValue,
            itemObject?["message_id"]?.stringValue,
            paramsObject["itemId"]?.stringValue,
            paramsObject["item_id"]?.stringValue,
            paramsObject["messageId"]?.stringValue,
            paramsObject["message_id"]?.stringValue,
            paramsObject["item"]?.objectValue?["id"]?.stringValue,
            paramsObject["item"]?.objectValue?["itemId"]?.stringValue,
            paramsObject["item"]?.objectValue?["item_id"]?.stringValue,
            paramsObject["item"]?.objectValue?["messageId"]?.stringValue,
            paramsObject["item"]?.objectValue?["message_id"]?.stringValue,
            eventObject?["itemId"]?.stringValue,
            eventObject?["item_id"]?.stringValue,
            eventObject?["messageId"]?.stringValue,
            eventObject?["message_id"]?.stringValue,
            eventObject?["item"]?.objectValue?["id"]?.stringValue,
            eventObject?["item"]?.objectValue?["itemId"]?.stringValue,
            eventObject?["item"]?.objectValue?["item_id"]?.stringValue,
            eventObject?["item"]?.objectValue?["messageId"]?.stringValue,
            eventObject?["item"]?.objectValue?["message_id"]?.stringValue,
            paramsObject["event"]?.objectValue?["item"]?.objectValue?["id"]?.stringValue,
            paramsObject["event"]?.objectValue?["messageId"]?.stringValue,
            paramsObject["event"]?.objectValue?["message_id"]?.stringValue,
            eventObject?["id"]?.stringValue,
        ]

        for candidate in candidates {
            if let normalized = normalizedIdentifier(candidate) {
                return normalized
            }
        }
        return nil
    }
}
