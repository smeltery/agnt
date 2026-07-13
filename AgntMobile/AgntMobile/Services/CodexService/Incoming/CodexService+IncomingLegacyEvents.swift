// FILE: CodexService+IncomingLegacyEvents.swift
// Purpose: Handles legacy Codex event envelopes that predate the structured item protocol.
// Layer: App / Services / CodexService / Incoming

import Foundation

extension CodexService {
    // Supports legacy codex/event envelopes where `msg.type == "turn_diff"` and payload uses unified_diff.
    func handleLegacyCodexEnvelopeEvent(_ paramsObject: IncomingParamsObject?) -> Bool {
        guard let paramsObject,
              let msgObject = paramsObject["msg"]?.objectValue else {
            return false
        }

        let eventType = msgObject["type"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let eventType else { return false }

        if eventType == "turn_diff" {
            var normalizedParams = paramsObject
            if normalizedParams["event"] == nil {
                normalizedParams["event"] = .object(msgObject)
            }

            if normalizedParams["diff"] == nil, let unified = msgObject["unified_diff"]?.stringValue {
                normalizedParams["diff"] = .string(unified)
            }

            if normalizedParams["turnId"] == nil {
                if let turnId = firstStringValue(in: msgObject, keys: ["turnId", "turn_id", "id"]) {
                    normalizedParams["turnId"] = .string(turnId)
                }
            }

            if normalizedParams["threadId"] == nil {
                if let threadId = firstStringValue(
                    in: msgObject,
                    keys: ["threadId", "thread_id", "conversationId", "conversation_id"]
                ) {
                    normalizedParams["threadId"] = .string(threadId)
                }
            }

            handleTurnDiffUpdated(normalizedParams)
            return true
        }

        if eventType == "patch_apply_begin" || eventType == "patch_apply_end" {
            return handleLegacyPatchApplyPayload(
                eventType: eventType,
                payload: msgObject,
                paramsObject: paramsObject
            )
        }

        return handleLegacyCodexEventType(
            eventType: eventType,
            payload: msgObject,
            paramsObject: paramsObject
        )
    }

    func handleLegacyCodexNamedEvent(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard method.hasPrefix("codex/event/"),
              let paramsObject else {
            return false
        }

        let eventType = method
            .replacingOccurrences(of: "codex/event/", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !eventType.isEmpty else {
            return false
        }

        let payload = paramsObject["msg"]?.objectValue
            ?? paramsObject["event"]?.objectValue
            ?? paramsObject

        if eventType == "turn_diff" {
            var normalizedParams = paramsObject
            if normalizedParams["event"] == nil {
                normalizedParams["event"] = .object(payload)
            }
            if normalizedParams["diff"] == nil,
               let unified = firstStringValue(in: payload, keys: ["unified_diff", "diff"]) {
                normalizedParams["diff"] = .string(unified)
            }
            handleTurnDiffUpdated(normalizedParams)
            return true
        }

        if eventType == "patch_apply_begin" || eventType == "patch_apply_end" {
            return handleLegacyPatchApplyPayload(
                eventType: eventType,
                payload: payload,
                paramsObject: paramsObject
            )
        }

        return handleLegacyCodexEventType(
            eventType: eventType,
            payload: payload,
            paramsObject: paramsObject
        )
    }

    func handleLegacyCodexEventType(
        eventType: String,
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        switch eventType {
        case "exec_command_begin", "exec_command_output_delta", "exec_command_end":
            return handleLegacyCommandExecutionEvent(
                eventType: eventType,
                payload: payload,
                paramsObject: paramsObject
            )
        case "token_count":
            return handleLegacyTokenCountEvent(
                payload: payload,
                paramsObject: paramsObject
            )
        case "background_event", "read", "search", "list_files":
            return handleEssentialActivityEvent(
                eventType: eventType,
                payload: payload,
                paramsObject: paramsObject
            )
        case "image_generation_end":
            return handleImageGenerationEndEvent(
                payload: payload,
                paramsObject: paramsObject
            )
        default:
            return false
        }
    }

    func handleLegacyPatchApplyMethod(
        method: String,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard let paramsObject else { return false }
        let eventType: String
        if method.hasSuffix("patch_apply_begin") {
            eventType = "patch_apply_begin"
        } else if method.hasSuffix("patch_apply_end") {
            eventType = "patch_apply_end"
        } else {
            return false
        }

        let payload = paramsObject["event"]?.objectValue
            ?? paramsObject["msg"]?.objectValue
            ?? paramsObject
        return handleLegacyPatchApplyPayload(
            eventType: eventType,
            payload: payload,
            paramsObject: paramsObject
        )
    }

    func extractToolCallActivityLines(from delta: String) -> [String] {
        let lines = delta
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !lines.isEmpty else { return [] }

        let acceptedPrefixes = [
            "running ",
            "read ",
            "search ",
            "searched ",
            "exploring ",
            "list ",
            "listing ",
            "open ",
            "opened ",
            "find ",
            "finding ",
            "edit ",
            "edited ",
            "write ",
            "wrote ",
            "apply ",
            "applied ",
        ]

        var seen: Set<String> = []
        var result: [String] = []
        for line in lines {
            if line.count > 140 { continue }
            if line.contains("`@agnt``") { continue }
            if line.hasPrefix("{") || line.hasPrefix("[") { continue }
            if looksLikePatchText(line) { continue }

            let normalized = line.lowercased()
            guard acceptedPrefixes.contains(where: { normalized.hasPrefix($0) }) else {
                continue
            }

            if seen.insert(normalized).inserted {
                result.append(line)
            }
        }

        return result
    }

    private func handleImageGenerationEndEvent(
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        let imagePath = firstNonEmptyString([
            firstStringValue(in: payload, keys: ["saved_path", "savedPath", "path", "file_path"]),
            firstStringValue(in: paramsObject, keys: ["saved_path", "savedPath", "path", "file_path"])
        ])
        guard let imagePath, Self.isGeneratedImagePath(imagePath) else {
            debugRuntimeLog("generated image event dropped reason=missing-path event=image_generation_end")
            return false
        }

        var normalizedParams = paramsObject ?? [:]
        if normalizedParams["event"] == nil {
            normalizedParams["event"] = .object(payload)
        }

        let turnId = extractTurnID(from: normalizedParams)
        guard let threadId = resolveThreadID(from: normalizedParams, turnIdHint: turnId) else {
            debugRuntimeLog("generated image event dropped reason=missing-thread event=image_generation_end path=\(URL(fileURLWithPath: imagePath).lastPathComponent)")
            return false
        }

        let itemId = firstNonEmptyString([
            firstStringValue(in: payload, keys: ["call_id", "callId", "id"]),
            firstStringValue(in: paramsObject, keys: ["itemId", "item_id", "call_id", "callId"])
        ])
        appendGeneratedImageReference(
            threadId: threadId,
            turnId: turnId,
            itemId: itemId,
            imagePath: imagePath
        )
        debugRuntimeLog("generated image event appended thread=\(threadId) turn=\(turnId ?? "") item=\(itemId ?? "") path=\(URL(fileURLWithPath: imagePath).lastPathComponent)")
        return true
    }

    // Accepts legacy Codex token_count events, even when the runtime omits thread ids.
    private func handleLegacyTokenCountEvent(
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        var normalizedParams = paramsObject ?? [:]
        if normalizedParams["event"] == nil {
            normalizedParams["event"] = .object(payload)
        }

        if normalizedParams["threadId"] == nil,
           let threadId = firstStringValue(
            in: payload,
            keys: ["threadId", "thread_id", "conversationId", "conversation_id"]
           ) {
            normalizedParams["threadId"] = .string(threadId)
        }

        if normalizedParams["turnId"] == nil,
           let turnId = firstStringValue(in: payload, keys: ["turnId", "turn_id", "id"]) {
            normalizedParams["turnId"] = .string(turnId)
        }

        let usageObject = payload["info"]?.objectValue
            ?? payload["usage"]?.objectValue
            ?? payload
        let usage = extractContextWindowUsageFromTokenCountPayload(payload)
            ?? extractContextWindowUsage(from: usageObject)
        guard let usage else {
            return false
        }

        let turnId = extractTurnID(from: normalizedParams)
        guard let threadId = resolveContextUsageThreadID(
            from: normalizedParams,
            turnIdHint: turnId
        ) else {
            return false
        }

        if let turnId {
            threadIdByTurnID[turnId] = threadId
        }
        contextWindowUsageByThread[threadId] = usage
        return true
    }

    private func handleLegacyPatchApplyPayload(
        eventType: String,
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard eventType == "patch_apply_begin" || eventType == "patch_apply_end" else {
            return false
        }

        var normalizedParams = paramsObject ?? [:]
        if normalizedParams["event"] == nil {
            normalizedParams["event"] = .object(payload)
        }

        if normalizedParams["itemId"] == nil,
           let itemId = firstStringValue(in: payload, keys: ["call_id", "callId"]) {
            normalizedParams["itemId"] = .string(itemId)
        }

        if normalizedParams["threadId"] == nil,
           let threadId = firstStringValue(
            in: payload,
            keys: ["threadId", "thread_id", "conversationId", "conversation_id"]
           ) {
            normalizedParams["threadId"] = .string(threadId)
        }

        if normalizedParams["turnId"] == nil,
           let turnId = firstStringValue(in: payload, keys: ["turnId", "turn_id", "id"]) {
            normalizedParams["turnId"] = .string(turnId)
        }

        let isCompleted = (eventType == "patch_apply_end")
        let status: String = {
            if let status = payload["status"]?.stringValue,
               !status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return status
            }
            if isCompleted {
                let success = payload["success"]?.boolValue ?? true
                return success ? "completed" : "failed"
            }
            return "inProgress"
        }()

        var syntheticItem: IncomingParamsObject = [
            "type": .string("fileChange"),
            "status": .string(status),
        ]
        if let changes = payload["changes"] {
            syntheticItem["changes"] = changes
        }

        _ = handleStructuredItemLifecycle(
            itemObject: syntheticItem,
            paramsObject: normalizedParams,
            itemType: "filechange",
            isCompleted: isCompleted
        )
        return true
    }

    private func handleEssentialActivityEvent(
        eventType: String,
        payload: IncomingParamsObject,
        paramsObject: IncomingParamsObject?
    ) -> Bool {
        guard let line = essentialActivityLine(for: eventType, payload: payload) else {
            return false
        }

        let turnId = extractTurnID(from: paramsObject)
        guard let threadId = resolveThreadID(from: paramsObject, turnIdHint: turnId) else {
            return false
        }

        appendEssentialActivityLine(threadId: threadId, turnId: turnId, line: line)
        return true
    }

    private func essentialActivityLine(
        for eventType: String,
        payload: IncomingParamsObject
    ) -> String? {
        switch eventType {
        case "background_event":
            let rawMessage = firstNonEmptyString([
                payload["message"]?.stringValue,
                payload["text"]?.stringValue,
                payload["body"]?.stringValue,
                firstString(forKey: "message", in: .object(payload)),
                firstString(forKey: "text", in: .object(payload)),
                firstString(forKey: "body", in: .object(payload)),
            ])
            guard let message = rawMessage?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !message.isEmpty else {
                return nil
            }
            if message.count > 140 {
                return nil
            }
            return message

        case "read":
            if let path = firstNonEmptyString([
                firstString(forKey: "path", in: .object(payload)),
                firstString(forKey: "file_path", in: .object(payload)),
                firstString(forKey: "file", in: .object(payload)),
            ]) {
                return "Read \(path)"
            }
            return "Read file"

        case "search":
            if let query = firstNonEmptyString([
                firstString(forKey: "query", in: .object(payload)),
                firstString(forKey: "pattern", in: .object(payload)),
                firstString(forKey: "regex", in: .object(payload)),
            ]) {
                return "Search \(query)"
            }
            return "Search files"

        case "list_files":
            if let path = firstNonEmptyString([
                firstString(forKey: "path", in: .object(payload)),
                firstString(forKey: "cwd", in: .object(payload)),
            ]) {
                return "List files \(path)"
            }
            return "List files"

        default:
            return nil
        }
    }

    private func appendEssentialActivityLine(threadId: String, turnId: String?, line: String) {
        let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLine.isEmpty else {
            return
        }

        let dedupeKey = "\(threadId)|\(turnId ?? "no-turn")"
        let now = Date()
        if let previous = recentActivityLineByThread[dedupeKey],
           previous.line.caseInsensitiveCompare(trimmedLine) == .orderedSame,
           now.timeIntervalSince(previous.timestamp) <= 4 {
            return
        }
        recentActivityLineByThread[dedupeKey] = CodexRecentActivityLine(line: trimmedLine, timestamp: now)
        appendToolActivityLine(threadId: threadId, turnId: turnId, line: trimmedLine)
    }
}
