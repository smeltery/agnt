// FILE: CodexService+IncomingSupport.swift
// Purpose: Shared parsing helpers and lightweight models used by inbound event handling.
// Layer: Service support
// Exports: Incoming decode helpers for CodexService inbound routing
// Depends on: Foundation

import Foundation

func normalizedIncomingMethodName(_ method: String) -> String {
    method.trimmingCharacters(in: .whitespacesAndNewlines)
}

func normalizeThreadStatusType(_ rawStatusType: String) -> String {
    rawStatusType
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "_", with: "")
        .replacingOccurrences(of: "-", with: "")
        .replacingOccurrences(of: " ", with: "")
}

func threadTerminalState(from normalizedStatusType: String) -> CodexTurnTerminalState? {
    if normalizedStatusType == "stopped" {
        return .stopped
    }
    if normalizedStatusType.contains("error") {
        return .failed
    }
    if normalizedStatusType == "idle"
        || normalizedStatusType == "notloaded"
        || normalizedStatusType == "completed"
        || normalizedStatusType == "done"
        || normalizedStatusType == "finished" {
        return .completed
    }
    return nil
}

func firstNonEmptyString(_ values: [String?]) -> String? {
    for value in values {
        guard let value else { continue }
        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return value
        }
    }
    return nil
}

func firstStringValue(in object: IncomingParamsObject?, keys: [String]) -> String? {
    guard let object else { return nil }
    for key in keys {
        if let value = trimmedNonEmptyString(object[key]?.stringValue) {
            return value
        }
    }
    return nil
}

func firstIntValue(in object: IncomingParamsObject?, keys: [String]) -> Int? {
    guard let object else { return nil }
    for key in keys {
        if let value = jsonIntValue(object[key]) {
            return value
        }
    }
    return nil
}

// Keeps generic tool rows compact and human-readable across live and history paths.
func normalizedToolActivityDescriptor(_ rawDescriptor: String?) -> String? {
    guard let rawDescriptor = trimmedNonEmptyString(rawDescriptor) else {
        return nil
    }

    let normalized = rawDescriptor
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        return nil
    }

    var uniqueTokens: [String] = []
    for token in normalized.split(separator: " ", omittingEmptySubsequences: true).map(String.init) {
        if uniqueTokens.last?.caseInsensitiveCompare(token) == .orderedSame {
            continue
        }
        uniqueTokens.append(token)
    }

    let joined = uniqueTokens.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    return joined.isEmpty ? nil : joined
}

func normalizedToolActivityStatus(_ rawStatus: String?, isCompleted: Bool) -> String {
    let normalized = rawStatus?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "_", with: "")
        .replacingOccurrences(of: "-", with: "")

    switch normalized {
    case "failed", "error":
        return "Failed"
    case "stopped", "cancelled", "canceled", "interrupted":
        return "Stopped"
    case "completed", "complete", "done", "finished", "success", "succeeded":
        return "Completed"
    case "running", "inprogress", "working":
        return "Running"
    default:
        return isCompleted ? "Completed" : "Running"
    }
}

func toolActivitySummaryLine(
    descriptor: String?,
    rawStatus: String?,
    isCompleted: Bool,
    fallback: String = "tool"
) -> String {
    let statusLabel = normalizedToolActivityStatus(rawStatus, isCompleted: isCompleted)
    let descriptorLabel = normalizedToolActivityDescriptor(descriptor) ?? fallback
    return "\(statusLabel) \(descriptorLabel)"
}

func isReplayedBridgeEvent(_ paramsObject: IncomingParamsObject?) -> Bool {
    paramsObject?["agntReplayedEvent"]?.boolValue == true
        || paramsObject?["remodexReplayedEvent"]?.boolValue == true
}

func extractContextWindowUsage(from object: IncomingParamsObject?) -> ContextWindowUsage? {
    guard let object else { return nil }

    let root = JSONValue.object(object)
    let tokensUsed = firstInt(forAnyKey: [
        "tokensUsed",
        "tokens_used",
        "totalTokens",
        "total_tokens",
        "usedTokens",
        "used_tokens",
        "inputTokens",
        "input_tokens",
    ], in: root)

    let explicitLimit = firstInt(forAnyKey: [
        "tokenLimit",
        "token_limit",
        "maxTokens",
        "max_tokens",
        "contextWindow",
        "context_window",
        "contextSize",
        "context_size",
        "maxContextTokens",
        "max_context_tokens",
        "inputTokenLimit",
        "input_token_limit",
        "maxInputTokens",
        "max_input_tokens",
    ], in: root)

    let tokensRemaining = firstInt(forAnyKey: [
        "tokensRemaining",
        "tokens_remaining",
        "remainingTokens",
        "remaining_tokens",
        "remainingInputTokens",
        "remaining_input_tokens",
    ], in: root)

    let resolvedTokensUsed = max(0, tokensUsed ?? 0)
    let resolvedTokenLimit = explicitLimit ?? {
        guard let tokensRemaining else { return nil }
        return resolvedTokensUsed + max(0, tokensRemaining)
    }()

    guard let resolvedTokenLimit, resolvedTokenLimit > 0 else {
        return nil
    }

    return ContextWindowUsage(
        tokensUsed: min(resolvedTokensUsed, resolvedTokenLimit),
        tokenLimit: resolvedTokenLimit
    )
}

// Decodes persisted/live `token_count` payloads that wrap totals under `info`.
func extractContextWindowUsageFromTokenCountPayload(_ payload: IncomingParamsObject?) -> ContextWindowUsage? {
    guard let payload else { return nil }

    let infoObject = payload["info"]?.objectValue ?? payload
    let infoRoot = JSONValue.object(infoObject)
    let lastUsageRoot = firstValue(forAnyKey: [
        "last_token_usage",
        "lastTokenUsage",
    ], in: infoRoot)
    let totalUsageRoot = firstValue(forAnyKey: [
        "total_token_usage",
        "totalTokenUsage",
        "last_token_usage",
        "lastTokenUsage",
    ], in: infoRoot) ?? infoRoot
    let preferredUsageRoot = lastUsageRoot ?? totalUsageRoot

    let explicitTotal = firstInt(forAnyKey: [
        "total_tokens",
        "totalTokens",
    ], in: preferredUsageRoot)
    let inputTokens = firstInt(forAnyKey: [
        "input_tokens",
        "inputTokens",
    ], in: preferredUsageRoot) ?? 0
    let outputTokens = firstInt(forAnyKey: [
        "output_tokens",
        "outputTokens",
    ], in: preferredUsageRoot) ?? 0
    let reasoningTokens = firstInt(forAnyKey: [
        "reasoning_output_tokens",
        "reasoningOutputTokens",
    ], in: preferredUsageRoot) ?? 0

    let tokenLimit = firstInt(forAnyKey: [
        "model_context_window",
        "modelContextWindow",
        "context_window",
        "contextWindow",
        "tokenLimit",
        "token_limit",
    ], in: infoRoot)

    guard let tokenLimit, tokenLimit > 0 else {
        return nil
    }

    let resolvedTokensUsed = explicitTotal ?? (inputTokens + outputTokens + reasoningTokens)

    return ContextWindowUsage(
        tokensUsed: min(resolvedTokensUsed, tokenLimit),
        tokenLimit: tokenLimit
    )
}

func hasAnyValue(in object: IncomingParamsObject?, keys: [String]) -> Bool {
    guard let object else { return false }
    return keys.contains(where: { object[$0] != nil })
}

func looksLikePatchText(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.contains("diff --git ") { return true }
    if trimmed.contains("\n@@ ") || trimmed.hasPrefix("@@ ") { return true }
    if trimmed.contains("\n+++ ") && trimmed.contains("\n--- ") { return true }
    if trimmed.contains("\nPath: ") && trimmed.contains("\nKind: ") { return true }
    return false
}

func firstValue(forAnyKey keys: [String], in root: JSONValue, maxDepth: Int = 8) -> JSONValue? {
    for key in keys {
        if let value = firstValue(forKey: key, in: root, maxDepth: maxDepth) {
            return value
        }
    }
    return nil
}

func firstValue(forKey key: String, in root: JSONValue, maxDepth: Int = 8) -> JSONValue? {
    guard maxDepth >= 0 else { return nil }

    switch root {
    case .object(let object):
        if let value = object[key], !isEmptyJSONValue(value) {
            return value
        }
        for value in object.values {
            if let match = firstValue(forKey: key, in: value, maxDepth: maxDepth - 1) {
                return match
            }
        }
    case .array(let array):
        for value in array {
            if let match = firstValue(forKey: key, in: value, maxDepth: maxDepth - 1) {
                return match
            }
        }
    default:
        break
    }
    return nil
}

func firstString(forKey key: String, in root: JSONValue, maxDepth: Int = 8) -> String? {
    guard let value = firstValue(forKey: key, in: root, maxDepth: maxDepth) else {
        return nil
    }
    if let text = value.stringValue {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    return flattenNestedText(from: value)
}

func flattenNestedText(from root: JSONValue, maxDepth: Int = 8) -> String? {
    guard maxDepth >= 0 else { return nil }
    switch root {
    case .string(let value):
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    case .array(let values):
        var parts: [String] = []
        for value in values {
            if let chunk = flattenNestedText(from: value, maxDepth: maxDepth - 1) {
                parts.append(chunk)
            }
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: "\n")
    case .object(let object):
        let preferredKeys = ["text", "message", "summary", "output_text", "outputText", "content", "output"]
        for key in preferredKeys {
            if let value = object[key],
               let text = flattenNestedText(from: value, maxDepth: maxDepth - 1) {
                return text
            }
        }
        for value in object.values {
            if let text = flattenNestedText(from: value, maxDepth: maxDepth - 1) {
                return text
            }
        }
        return nil
    default:
        return nil
    }
}

private func trimmedNonEmptyString(_ candidate: String?) -> String? {
    guard let candidate else { return nil }
    let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func jsonIntValue(_ value: JSONValue?) -> Int? {
    guard let value else { return nil }

    if let directInt = value.intValue {
        return directInt
    }

    if let directDouble = value.doubleValue {
        return Int(directDouble)
    }

    if let directString = value.stringValue?
        .trimmingCharacters(in: .whitespacesAndNewlines),
       let parsed = Int(directString) {
        return parsed
    }

    return nil
}

private func firstInt(forAnyKey keys: [String], in root: JSONValue, maxDepth: Int = 8) -> Int? {
    for key in keys {
        if let value = firstValue(forKey: key, in: root, maxDepth: maxDepth),
           let parsed = jsonIntValue(value) {
            return parsed
        }
    }
    return nil
}

private func isEmptyJSONValue(_ value: JSONValue) -> Bool {
    switch value {
    case .null:
        return true
    case .string(let text):
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    case .array(let values):
        return values.isEmpty
    case .object(let object):
        return object.isEmpty
    default:
        return false
    }
}
