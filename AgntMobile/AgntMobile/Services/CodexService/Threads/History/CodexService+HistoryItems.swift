// FILE: CodexService+HistoryItems.swift
// Purpose: Normalization and item-message helpers for canonical history decoding.
// Layer: Service

import Foundation

extension CodexService {
    func normalizedItemType(_ rawType: String) -> String {
        rawType
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .lowercased()
    }

    func normalizedAssistantPhase(_ rawPhase: String?) -> String? {
        guard let rawPhase else {
            return nil
        }
        let normalized = rawPhase
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    nonisolated static func normalizedCommandExecutionPreviewKey(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        let statusPrefixes: Set<String> = ["running", "completed", "failed", "stopped"]
        let tokens = trimmed
            .split(separator: " ", omittingEmptySubsequences: true)
            .map(String.init)
        guard !tokens.isEmpty else {
            return nil
        }

        let commandTokens: [String]
        if let first = tokens.first,
           statusPrefixes.contains(first.lowercased()) {
            commandTokens = Array(tokens.dropFirst())
        } else {
            commandTokens = tokens
        }

        guard !commandTokens.isEmpty else {
            return nil
        }

        let unquoted = commandTokens.map { token in
            token
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        }
        .joined(separator: " ")

        let collapsedWhitespace = unquoted.replacingOccurrences(
            of: #"\s+"#,
            with: " ",
            options: .regularExpression
        )
        let normalized = collapsedWhitespace.lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    // Centralizes history-item -> CodexMessage mapping without changing ordering behavior.
    func appendHistoryMessage(
        to result: inout [CodexMessage],
        role: CodexMessageRole,
        kind: CodexMessageKind = .chat,
        assistantPhase: String? = nil,
        text: String,
        threadId: String,
        turnId: String?,
        itemId: String?,
        createdAt: Date,
        timeZoneIdentifier: String? = nil,
        skillMentions: [String] = [],
        pluginMentions: [String] = [],
        attachments: [CodexImageAttachment] = [],
        planState: CodexPlanState? = nil,
        planPresentation: CodexPlanPresentation? = nil,
        subagentAction: CodexSubagentAction? = nil,
        autoApprovalReview: CodexAutoApprovalReview? = nil
    ) {
        guard !text.isEmpty
            || !attachments.isEmpty
            || subagentAction != nil
            || autoApprovalReview != nil else {
            return
        }

        result.append(
            CodexMessage(
                id: role == .assistant
                    ? (Self.stableAssistantMessageID(threadId: threadId, turnId: turnId, itemId: itemId) ?? UUID().uuidString)
                    : UUID().uuidString,
                threadId: threadId,
                role: role,
                kind: kind,
                assistantPhase: role == .assistant ? normalizedAssistantPhase(assistantPhase) : nil,
                text: text,
                skillMentions: skillMentions,
                pluginMentions: pluginMentions,
                createdAt: createdAt,
                timeZoneIdentifier: timeZoneIdentifier,
                turnId: turnId,
                itemId: itemId,
                isStreaming: false,
                deliveryState: .confirmed,
                attachments: attachments,
                planState: planState,
                planPresentation: planPresentation,
                proposedPlan: role == .assistant ? CodexProposedPlanParser.parse(from: text) : nil,
                subagentAction: subagentAction,
                autoApprovalReview: autoApprovalReview
            )
        )
    }

    func decodeReasoningItemText(from itemObject: [String: JSONValue]) -> String {
        let summary = decodeHistoryStringParts(itemObject["summary"]).joined(separator: "\n")
        let content = decodeHistoryStringParts(itemObject["content"]).joined(separator: "\n\n")

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

    func decodePlanItemText(from itemObject: [String: JSONValue]) -> String {
        let decodedText = decodeItemText(from: itemObject)
        if !decodedText.isEmpty {
            return decodedText
        }

        let summary = decodeHistoryStringParts(itemObject["summary"]).joined(separator: "\n")
        if !summary.isEmpty {
            return summary
        }

        return ""
    }

    func decodePlanState(from itemObject: [String: JSONValue]) -> CodexPlanState? {
        let explanation = decodeNormalizedPlanText(itemObject["explanation"])
            ?? decodeNormalizedPlanText(itemObject["summary"])
        let steps = (itemObject["plan"]?.arrayValue ?? []).compactMap { stepValue -> CodexPlanStep? in
            guard let stepObject = stepValue.objectValue,
                  let step = decodeNormalizedPlanText(stepObject["step"]),
                  let rawStatus = decodeNormalizedPlanText(stepObject["status"]),
                  let status = CodexPlanStepStatus(wireValue: rawStatus) else {
                return nil
            }

            return CodexPlanStep(step: step, status: status)
        }

        guard explanation != nil || !steps.isEmpty else {
            return nil
        }

        return CodexPlanState(explanation: explanation, steps: steps)
    }

    // Closed turns should not restore a stale "active" plan accessory from history.
    func finalizedHistoryPlanState(_ planState: CodexPlanState?, turnCompleted: Bool) -> CodexPlanState? {
        guard turnCompleted,
              let planState,
              !planState.steps.isEmpty,
              planState.steps.contains(where: { $0.status != .completed }) else {
            return planState
        }

        return CodexPlanState(
            explanation: planState.explanation,
            steps: planState.steps.map { step in
                CodexPlanStep(id: step.id, step: step.step, status: .completed)
            }
        )
    }

    func isCompletedHistoryTurn(_ turnObject: [String: JSONValue]) -> Bool {
        historyTurnTerminalState(turnObject) == .completed
    }

    func historyTurnTerminalState(_ turnObject: [String: JSONValue]) -> CodexTurnTerminalState? {
        let statusObject = turnObject["status"]?.objectValue
        let rawStatus = firstNonEmptyString([
            turnObject["status"]?.stringValue,
            statusObject?["type"]?.stringValue,
            statusObject?["statusType"]?.stringValue,
            statusObject?["status_type"]?.stringValue,
            turnObject["result"]?.stringValue,
        ]) ?? ""

        return threadTerminalState(from: normalizeThreadStatusType(rawStatus))
    }
}
