// FILE: CodexService+IncomingExtraction.swift
// Purpose: Extracts identifiers, item payloads, and text bodies from inbound RPC envelopes.
// Layer: Service support
// Exports: CodexService incoming extraction helpers
// Depends on: Foundation, JSONValue, CodexService incoming support helpers

import Foundation

extension CodexService {
    func extractIncomingItemObject(
        from paramsObject: IncomingParamsObject,
        eventObject: IncomingParamsObject?
    ) -> IncomingParamsObject? {
        if let item = paramsObject["item"]?.objectValue {
            return item
        }
        if let item = eventObject?["item"]?.objectValue {
            return item
        }
        if let item = paramsObject["event"]?.objectValue?["item"]?.objectValue {
            return item
        }

        if isLikelyIncomingItemPayload(paramsObject) {
            return paramsObject
        }
        if let eventObject, isLikelyIncomingItemPayload(eventObject) {
            return eventObject
        }
        if let nestedEventObject = paramsObject["event"]?.objectValue,
           isLikelyIncomingItemPayload(nestedEventObject) {
            return nestedEventObject
        }

        return nil
    }

    // Summarizes non-file-changing tool items into a stable system row instead of leaking them into thinking.
    func decodeToolCallActivityBody(
        _ itemObject: IncomingParamsObject,
        isCompleted: Bool
    ) -> String? {
        let output = extractToolCallOutputText(from: itemObject)
        if let output {
            let activityLines = extractToolCallActivityLines(from: output)
            if !activityLines.isEmpty {
                return activityLines.joined(separator: "\n")
            }
        }

        let descriptor = toolCallDescriptor(from: itemObject)
        let summary = toolActivitySummaryLine(
            descriptor: descriptor,
            rawStatus: firstNonEmptyString([
                itemObject["status"]?.stringValue,
                firstString(forKey: "status", in: .object(itemObject)),
            ]),
            isCompleted: isCompleted
        )
        return summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : summary
    }

    private func isLikelyIncomingItemPayload(_ object: IncomingParamsObject) -> Bool {
        guard let type = object["type"]?.stringValue,
              !normalizedItemType(type).isEmpty else {
            return false
        }
        let itemType = normalizedItemType(type)

        if object["content"] != nil || object["status"] != nil || object["output"] != nil {
            return true
        }
        if object["changes"] != nil || object["files"] != nil || object["diff"] != nil || object["patch"] != nil {
            return true
        }
        if object["result"] != nil || object["payload"] != nil || object["data"] != nil {
            return true
        }
        let hasGeneratedImageIdentityOrPath = object["path"] != nil
            || object["saved_path"] != nil
            || object["savedPath"] != nil
            || object["file_path"] != nil
            || object["id"] != nil
            || object["call_id"] != nil
            || object["callId"] != nil
        if isCompletedGeneratedImageItemType(itemType), hasGeneratedImageIdentityOrPath {
            return true
        }

        return false
    }

    func debugNotificationSummary(method: String, paramsObject: IncomingParamsObject?) -> String {
        let eventObject = paramsObject.flatMap { envelopeEventObject(from: $0) }
        let itemObject = paramsObject.flatMap { extractIncomingItemObject(from: $0, eventObject: eventObject) }
        let itemType = debugNotificationItemType(paramsObject: paramsObject)
        let itemId = extractItemID(from: paramsObject, eventObject: eventObject, itemObject: itemObject) ?? ""
        let nestedItemId = paramsObject?["item"]?.objectValue?["id"]?.stringValue ?? ""
        let eventType = eventObject?["type"]?.stringValue ?? ""
        let pathValue = firstNonEmptyString([
            firstStringValue(in: itemObject, keys: ["saved_path", "savedPath", "path", "file_path"]),
            firstStringValue(in: eventObject, keys: ["saved_path", "savedPath", "path", "file_path"]),
            firstStringValue(in: paramsObject, keys: ["saved_path", "savedPath", "path", "file_path"])
        ])
        let pathName = pathValue.map { URL(fileURLWithPath: $0).lastPathComponent } ?? ""
        let resultLength = [
            itemObject?["result"]?.stringValue?.count,
            eventObject?["result"]?.stringValue?.count,
            paramsObject?["result"]?.stringValue?.count,
        ]
        .compactMap { $0 }
        .first ?? 0
        return "rpc notification \(method) thread=\(paramsObject?["threadId"]?.stringValue ?? "") turn=\(paramsObject?["turnId"]?.stringValue ?? "") item=\(itemId) nestedItem=\(nestedItemId) type=\(itemType) event=\(eventType) path=\(pathName) resultLen=\(resultLength)"
    }

    func debugNotificationItemType(paramsObject: IncomingParamsObject?) -> String {
        let eventObject = paramsObject.flatMap { envelopeEventObject(from: $0) }
        let itemObject = paramsObject.flatMap { extractIncomingItemObject(from: $0, eventObject: eventObject) }
        return normalizedItemType(itemObject?["type"]?.stringValue ?? "")
    }

    func extractItemID(
        from paramsObject: IncomingParamsObject?,
        eventObject: IncomingParamsObject?,
        itemObject: IncomingParamsObject? = nil
    ) -> String? {
        if let itemId = itemObject?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = itemObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["itemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = paramsObject?["item"]?.objectValue?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["itemId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["item_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["call_id"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["callId"]?.stringValue, !itemId.isEmpty { return itemId }
        if let itemId = eventObject?["item"]?.objectValue?["id"]?.stringValue, !itemId.isEmpty { return itemId }
        return nil
    }

    func extractTextDelta(from paramsObject: IncomingParamsObject) -> String {
        let eventObject = envelopeEventObject(from: paramsObject)

        if let delta = paramsObject["delta"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["textDelta"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["text_delta"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["text"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["summary"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["part"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = eventObject?["delta"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = eventObject?["text"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = eventObject?["summary"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = eventObject?["part"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["event"]?.objectValue?["delta"]?.stringValue, !delta.isEmpty {
            return delta
        }
        if let delta = paramsObject["event"]?.objectValue?["text"]?.stringValue, !delta.isEmpty {
            return delta
        }

        return ""
    }

    func decodeReasoningItemBody(_ itemObject: IncomingParamsObject) -> String {
        let summary = decodeStringParts(itemObject["summary"]).joined(separator: "\n")
        let content = decodeStringParts(itemObject["content"]).joined(separator: "\n\n")

        var sections: [String] = []
        if !summary.isEmpty {
            sections.append(summary)
        }
        if !content.isEmpty {
            sections.append(content)
        }

        if sections.isEmpty {
            return ""
        }

        return sections.joined(separator: "\n\n")
    }

    func decodePlanItemBody(_ itemObject: IncomingParamsObject) -> String {
        let decodedText = decodeItemText(from: itemObject)
        if !decodedText.isEmpty {
            return decodedText
        }

        let summary = decodeStringParts(itemObject["summary"]).joined(separator: "\n")
        if !summary.isEmpty {
            return summary
        }

        return ""
    }

    private func decodeStringParts(_ value: JSONValue?) -> [String] {
        guard let value else { return [] }

        switch value {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        case .array(let values):
            return values
                .compactMap { candidate -> String? in
                    if let text = candidate.stringValue {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        return trimmed.isEmpty ? nil : trimmed
                    }
                    if let object = candidate.objectValue,
                       let text = object["text"]?.stringValue {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        return trimmed.isEmpty ? nil : trimmed
                    }
                    return nil
                }
        case .object(let object):
            if let text = object["text"]?.stringValue {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? [] : [trimmed]
            }
            return []
        default:
            return []
        }
    }

    func extractThreadID(from paramsObject: IncomingParamsObject?) -> String? {
        guard let paramsObject else { return nil }

        if let threadId = normalizedIdentifier(paramsObject["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["item"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(paramsObject["item"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        let eventObject = envelopeEventObject(from: paramsObject)
        if let threadId = normalizedIdentifier(eventObject?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["item"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject?["item"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        guard let eventObject = paramsObject["event"]?.objectValue else { return nil }
        if let threadId = normalizedIdentifier(eventObject["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["thread_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["conversationId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["conversation_id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["thread"]?.objectValue?["id"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["turn"]?.objectValue?["threadId"]?.stringValue) { return threadId }
        if let threadId = normalizedIdentifier(eventObject["turn"]?.objectValue?["thread_id"]?.stringValue) { return threadId }

        return nil
    }

    func extractTurnID(from paramsObject: IncomingParamsObject?) -> String? {
        guard let paramsObject else { return nil }

        if let turnId = extractTurnID(from: paramsObject["turn"]) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["turn_id"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["item"]?.objectValue?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(paramsObject["item"]?.objectValue?["turn_id"]?.stringValue) { return turnId }

        let eventObject = envelopeEventObject(from: paramsObject)
        if let turnId = normalizedIdentifier(eventObject?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["turn_id"]?.stringValue) { return turnId }
        if let turnId = extractTurnID(from: eventObject?["turn"]) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["item"]?.objectValue?["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject?["item"]?.objectValue?["turn_id"]?.stringValue) { return turnId }

        guard let eventObject = paramsObject["event"]?.objectValue else { return nil }
        if let turnId = normalizedIdentifier(eventObject["turnId"]?.stringValue) { return turnId }
        if let turnId = normalizedIdentifier(eventObject["turn_id"]?.stringValue) { return turnId }
        if let turnId = extractTurnID(from: eventObject["turn"]) { return turnId }

        return nil
    }

    func envelopeEventObject(from paramsObject: IncomingParamsObject?) -> IncomingParamsObject? {
        paramsObject?["msg"]?.objectValue ?? paramsObject?["event"]?.objectValue
    }

    // Turn lifecycle notifications sometimes carry the turn id as top-level `id`.
    // Accept that shape only for turn/started and turn/completed handling.
    func extractTurnIDForTurnLifecycleEvent(from paramsObject: IncomingParamsObject?) -> String? {
        if let turnID = extractTurnID(from: paramsObject) {
            return turnID
        }

        let eventObject = envelopeEventObject(from: paramsObject)
        let nestedEventObject = paramsObject?["event"]?.objectValue
        return normalizedIdentifier(
            paramsObject?["id"]?.stringValue
                ?? eventObject?["id"]?.stringValue
                ?? nestedEventObject?["id"]?.stringValue
        )
    }

    func shouldRetryTurnError(from paramsObject: IncomingParamsObject?) -> Bool {
        let eventObject = envelopeEventObject(from: paramsObject)

        let candidates: [JSONValue?] = [
            paramsObject?["willRetry"],
            paramsObject?["will_retry"],
            eventObject?["willRetry"],
            eventObject?["will_retry"],
            paramsObject?["event"]?.objectValue?["willRetry"],
            paramsObject?["event"]?.objectValue?["will_retry"],
        ]

        for candidate in candidates {
            if let parsed = parseBooleanFlag(candidate) {
                return parsed
            }
        }
        return false
    }

    private func parseBooleanFlag(_ value: JSONValue?) -> Bool? {
        guard let value else { return nil }

        if let boolValue = value.boolValue {
            return boolValue
        }

        guard let text = value.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() else {
            return nil
        }

        if text == "true" || text == "1" || text == "yes" {
            return true
        }
        if text == "false" || text == "0" || text == "no" {
            return false
        }

        return nil
    }

    func normalizedIdentifier(_ candidate: String?) -> String? {
        guard let candidate else {
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func hasStreamingMessage(in threadId: String) -> Bool {
        (messagesByThread[threadId] ?? []).contains(where: { $0.isStreaming })
    }

    func resolveThreadID(
        from paramsObject: IncomingParamsObject?,
        turnIdHint: String? = nil
    ) -> String? {
        if let threadId = extractThreadID(from: paramsObject), !threadId.isEmpty {
            if let turnId = turnIdHint ?? extractTurnID(from: paramsObject) {
                threadIdByTurnID[turnId] = threadId
            }
            return threadId
        }

        if let turnId = turnIdHint ?? extractTurnID(from: paramsObject),
           let mappedThreadId = threadIdByTurnID[turnId] {
            return mappedThreadId
        }

        // Conservative fallback: infer only when there is a single unambiguous thread context.
        if activeTurnIdByThread.count == 1,
           let soleRunningThreadId = activeTurnIdByThread.keys.first {
            return soleRunningThreadId
        }
        if threads.count == 1, let soleThreadId = threads.first?.id {
            return soleThreadId
        }
        if threads.isEmpty,
           messagesByThread.keys.count <= 1,
           let activeThreadId {
            return activeThreadId
        }

        return nil
    }

    // Token-count events can be session-scoped, so only fall back when one running thread is unambiguous.
    func resolveContextUsageThreadID(
        from paramsObject: IncomingParamsObject?,
        turnIdHint: String? = nil
    ) -> String? {
        if let resolved = resolveThreadID(from: paramsObject, turnIdHint: turnIdHint) {
            return resolved
        }

        let runtimeScopedCandidates = runningThreadIDs.union(protectedRunningFallbackThreadIDs)
        if runtimeScopedCandidates.count == 1 {
            return runtimeScopedCandidates.first
        }

        return nil
    }

    func extractIncomingMessageText(from itemObject: [String: JSONValue]) -> String {
        let contentItems = itemObject["content"]?.arrayValue ?? []
        var parts: [String] = []

        for content in contentItems {
            guard let object = content.objectValue else { continue }
            let contentType = object["type"]?.stringValue?.lowercased()
            let isTextType = contentType == nil
                || contentType == "text"
                || contentType == "input_text"
                || contentType == "output_text"
                || contentType == "message"
            if contentType == "skill" {
                let skillID = object["id"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let skillName = object["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                let resolved = (skillID?.isEmpty == false) ? skillID : skillName
                if let resolved, !resolved.isEmpty {
                    parts.append("$\(resolved)")
                }
                continue
            }

            guard isTextType else { continue }

            if let text = object["text"]?.stringValue, !text.isEmpty {
                parts.append(text)
                continue
            }

            if let delta = object["delta"]?.stringValue, !delta.isEmpty {
                parts.append(delta)
                continue
            }

            if let nestedText = object["data"]?.objectValue?["text"]?.stringValue,
               !nestedText.isEmpty {
                parts.append(nestedText)
            }
        }

        let joined = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            return joined
        }

        if let directText = itemObject["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !directText.isEmpty {
            return directText
        }

        if let messageText = itemObject["message"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !messageText.isEmpty {
            return messageText
        }

        return ""
    }
}
