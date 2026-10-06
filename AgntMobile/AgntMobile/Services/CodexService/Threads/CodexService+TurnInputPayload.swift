// FILE: CodexService+TurnInputPayload.swift
// Purpose: Builds turn/start input arrays and structured mention fallback text.
// Layer: Service
// Exports: CodexService turn input payload helpers
// Depends on: CodexImageAttachment, JSONValue

import Foundation

extension CodexService {
    // Normalizes outgoing turn input so we can support mixed text + image messages.
    func makeTurnInputPayload(
        userInput: String,
        attachments: [CodexImageAttachment],
        imageURLKey: String,
        skillMentions: [CodexTurnSkillMention] = [],
        mentionMentions: [CodexTurnMention] = [],
        includeStructuredSkillItems: Bool = true,
        includeStructuredMentionItems: Bool = true
    ) -> [JSONValue] {
        var inputItems: [JSONValue] = []

        for attachment in attachments {
            guard let payloadDataURL = attachment.payloadDataURL,
                  !payloadDataURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }

            inputItems.append(
                .object([
                    "type": .string("image"),
                    imageURLKey: .string(payloadDataURL),
                ])
            )
        }

        let trimmedText = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedText.isEmpty {
            let fallbackText = legacyTextForStructuredMentions(
                skillMentions: skillMentions,
                mentionMentions: mentionMentions
            )
            inputItems.append(
                .object([
                    "type": .string("text"),
                    "text": .string(appendingMissingLegacyMentionTokens(fallbackText, to: trimmedText)),
                ])
            )
        } else {
            let fallbackText = legacyTextForStructuredMentions(
                skillMentions: skillMentions,
                mentionMentions: mentionMentions
            )
            if !fallbackText.isEmpty {
                inputItems.append(
                    .object([
                        "type": .string("text"),
                        "text": .string(fallbackText),
                    ])
                )
            }
        }

        if includeStructuredSkillItems {
            for mention in skillMentions {
                let normalizedSkillID = mention.id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedSkillID.isEmpty else {
                    continue
                }

                var payload: RPCObject = [
                    "type": .string("skill"),
                    "id": .string(normalizedSkillID),
                ]

                if let name = mention.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !name.isEmpty {
                    payload["name"] = .string(name)
                }

                if let path = mention.path?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty {
                    payload["path"] = .string(path)
                }

                inputItems.append(.object(payload))
            }
        }

        if includeStructuredMentionItems {
            for mention in mentionMentions {
                let normalizedName = mention.name.trimmingCharacters(in: .whitespacesAndNewlines)
                let normalizedPath = mention.path.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedName.isEmpty, !normalizedPath.isEmpty else {
                    continue
                }

                inputItems.append(
                    .object([
                        "type": .string("mention"),
                        "name": .string(normalizedName),
                        "path": .string(normalizedPath),
                    ])
                )
            }
        }

        return inputItems
    }

    // Keeps the local bubble human-only; the turn/start payload still carries legacy text
    // fallbacks so desktop Codex can read structured mentions.
    func displayTextForOutgoingTurn(
        userInput: String,
        skillMentions: [CodexTurnSkillMention],
        mentionMentions: [CodexTurnMention]
    ) -> String {
        var trimmedInput = userInput.trimmingCharacters(in: .whitespacesAndNewlines)
        var humanTextProbe = trimmedInput

        for mention in skillMentions {
            let rawName = mention.name ?? mention.id
            let normalizedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedName.isEmpty else { continue }
            let displayName = Self.displayNameForMentionToken(normalizedName)
            humanTextProbe = Self.removeBoundedMentionToken("$\(normalizedName)", from: humanTextProbe)
            humanTextProbe = Self.removeBoundedMentionToken("/\(normalizedName)", from: humanTextProbe)
            humanTextProbe = Self.removeBoundedMentionToken(displayName, from: humanTextProbe)
            trimmedInput = Self.replacingBoundedMentionToken("$\(normalizedName)", with: displayName, in: trimmedInput)
            trimmedInput = Self.replacingBoundedMentionToken("/\(normalizedName)", with: displayName, in: trimmedInput)
        }

        for mention in mentionMentions {
            let normalizedName = mention.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedName.isEmpty else { continue }
            humanTextProbe = Self.removeBoundedMentionToken("@\(normalizedName)", from: humanTextProbe)
            trimmedInput = Self.removeBoundedMentionToken("@\(normalizedName)", from: trimmedInput)
        }

        guard !humanTextProbe.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ""
        }

        trimmedInput = trimmedInput.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedInput
    }

    nonisolated static func displayNameForMentionToken(_ rawName: String) -> String {
        let parts = rawName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(omittingEmptySubsequences: true) { $0 == "-" || $0 == "_" }
            .map { part -> String in
                let token = String(part)
                return token.prefix(1).uppercased() + token.dropFirst().lowercased()
            }
        return parts.isEmpty ? rawName : parts.joined(separator: " ")
    }

    nonisolated static func replacingBoundedMentionToken(_ token: String, with replacement: String, in text: String) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        guard let regex = try? NSRegularExpression(
            pattern: "(?<!\\S)" + escaped + "(?=[\\s,.;:!?)\\]}>]|$)",
            options: [.caseInsensitive]
        ) else {
            return text
        }

        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement)
        )
    }

    nonisolated static func removeBoundedMentionToken(_ token: String, from text: String) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        guard let regex = try? NSRegularExpression(
            pattern: "(?<!\\S)" + escaped + "(?:[\\s,.;:!?)\\]}>]|$)",
            options: [.caseInsensitive]
        ) else {
            return text
        }

        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else {
            return text
        }

        var result = text
        let matchRange = Range(match.range, in: text)!
        result.replaceSubrange(matchRange, with: "")
        return result
    }

    func hasRenderableStructuredMentions(
        skillMentions: [CodexTurnSkillMention],
        mentionMentions: [CodexTurnMention]
    ) -> Bool {
        !legacyTextForStructuredMentions(
            skillMentions: skillMentions,
            mentionMentions: mentionMentions
        ).isEmpty
    }

    // Builds turn/start params so retries can switch only the input-item encoding.
    func buildTurnStartRequestParams(
        threadId: String,
        userInput: String,
        attachments: [CodexImageAttachment],
        skillMentions: [CodexTurnSkillMention],
        mentionMentions: [CodexTurnMention],
        imageURLKey: String,
        includeStructuredSkillItems: Bool,
        includeStructuredMentionItems: Bool,
        collaborationMode: CodexCollaborationModeKind?,
        includeServiceTier: Bool
    ) throws -> RPCObject {
        var params: RPCObject = [
            "threadId": .string(threadId),
            "input": .array(
                makeTurnInputPayload(
                    userInput: userInput,
                    attachments: attachments,
                    imageURLKey: imageURLKey,
                    skillMentions: skillMentions,
                    mentionMentions: mentionMentions,
                    includeStructuredSkillItems: includeStructuredSkillItems,
                    includeStructuredMentionItems: includeStructuredMentionItems
                )
            ),
        ]
        // Keep the legacy top-level fields populated so plan-mode turns still honor
        // the user's selected model on runtimes that do not read collaboration settings.
        if let modelIdentifier = runtimeModelIdentifierForTurn(threadId: threadId) {
            params["model"] = .string(modelIdentifier)
        }
        if let effort = selectedReasoningEffortForSelectedModel(threadId: threadId) {
            params["effort"] = .string(effort)
        }
        if includeServiceTier,
           let serviceTier = runtimeServiceTierForTurn(threadId: threadId) {
            params["serviceTier"] = .string(serviceTier)
        }
        if let collaborationModePayload = try buildCollaborationModePayload(
            for: collaborationMode,
            threadId: threadId
        ) {
            params["collaborationMode"] = collaborationModePayload
        }
        if supportsRuntimeSettingsSync {
            params["agntRuntimeSettingsVersion"] = .integer(2)
        }
        return params
    }

    private func appendingMissingLegacyMentionTokens(_ legacyText: String, to text: String) -> String {
        let trimmedLegacyText = legacyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLegacyText.isEmpty else {
            return text
        }

        let missingTokens = trimmedLegacyText
            .split(separator: " ")
            .map(String.init)
            .filter { token in
                !textContainsLegacyMentionToken(text, token: token)
            }
        guard !missingTokens.isEmpty else {
            return text
        }

        return "\(text)\n\n\(missingTokens.joined(separator: " "))"
    }

    private func textContainsLegacyMentionToken(_ text: String, token: String) -> Bool {
        if text.localizedCaseInsensitiveContains(token) {
            return true
        }

        if token.hasPrefix("$") {
            let slashToken = "/" + token.dropFirst()
            return text.localizedCaseInsensitiveContains(slashToken)
        }

        return false
    }

    private func legacyTextForStructuredMentions(
        skillMentions: [CodexTurnSkillMention],
        mentionMentions: [CodexTurnMention]
    ) -> String {
        var tokens: [String] = []

        for mention in skillMentions {
            let rawName = mention.name ?? mention.id
            let normalizedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedName.isEmpty {
                tokens.append("$\(normalizedName)")
            }
        }

        for mention in mentionMentions {
            let normalizedName = mention.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedName.isEmpty {
                tokens.append("@\(normalizedName)")
            }
        }

        return tokens.joined(separator: " ")
    }
}
