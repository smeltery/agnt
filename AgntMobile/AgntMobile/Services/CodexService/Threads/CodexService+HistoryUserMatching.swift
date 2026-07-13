// FILE: CodexService+HistoryUserMatching.swift
// Purpose: Normalizes history text and compares user messages with skill/plugin mentions.
// Layer: Service

import Foundation

fileprivate nonisolated struct UserMessageSemanticKey: Equatable {
    let text: String
    let skillMentions: Set<String>
    let pluginMentions: Set<String>

    var hasMentions: Bool {
        !skillMentions.isEmpty || !pluginMentions.isEmpty
    }
}

extension CodexService {
    nonisolated static func normalizedMessageText(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated static func hasMeaningfulHistoryText(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    nonisolated static func historyTextsMatch(_ lhs: String, _ rhs: String) -> Bool {
        if normalizedMessageText(lhs) == normalizedMessageText(rhs) {
            return true
        }

        let lhsKey = canonicalUserMessageKey(text: lhs)
        let rhsKey = canonicalUserMessageKey(text: rhs)
        return lhsKey.hasMentions && lhsKey == rhsKey
    }

    nonisolated static func userMessagesMatchForHistory(_ lhs: CodexMessage, _ rhs: CodexMessage) -> Bool {
        userMessageMatchesTextForHistory(
            lhs,
            text: rhs.text,
            skillMentions: rhs.skillMentions,
            pluginMentions: rhs.pluginMentions
        )
    }

    nonisolated static func userMessageMatchesTextForHistory(
        _ message: CodexMessage,
        text: String,
        skillMentions: [String] = [],
        pluginMentions: [String] = []
    ) -> Bool {
        if historyTextsMatch(message.text, text) {
            return true
        }

        let lhsKey = canonicalUserMessageKey(
            text: message.text,
            skillMentions: message.skillMentions,
            pluginMentions: message.pluginMentions
        )
        let rhsKey = canonicalUserMessageKey(
            text: text,
            skillMentions: skillMentions,
            pluginMentions: pluginMentions
        )
        return lhsKey.hasMentions && lhsKey == rhsKey
    }

    nonisolated static func userSemanticHistoryTextKey(for message: CodexMessage) -> String {
        let key = canonicalUserMessageKey(
            text: message.text,
            skillMentions: message.skillMentions,
            pluginMentions: message.pluginMentions
        )
        guard key.hasMentions else {
            return historyTextKey(for: message.text)
        }

        return [
            key.text,
            "skills:\(key.skillMentions.sorted().joined(separator: ","))",
            "plugins:\(key.pluginMentions.sorted().joined(separator: ","))",
        ].joined(separator: "|")
    }

    nonisolated static func historyTextKey(for text: String) -> String {
        normalizedMessageText(text)
    }

    nonisolated static func normalizedUserMentionName(_ rawName: String) -> String {
        rawName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    nonisolated static func shouldPreferIncomingUserPresentationText(
        existing: CodexMessage,
        incoming: CodexMessage
    ) -> Bool {
        guard existing.role == .user,
              incoming.role == .user,
              hasMeaningfulHistoryText(incoming.text),
              userMessagesMatchForHistory(existing, incoming) else {
            return false
        }

        let existingHasMentionMetadata = !existing.skillMentions.isEmpty || !existing.pluginMentions.isEmpty
        let incomingHasMentionMetadata = !incoming.skillMentions.isEmpty || !incoming.pluginMentions.isEmpty
        return !existingHasMentionMetadata && incomingHasMentionMetadata
    }

    private nonisolated static func canonicalUserMessageKey(
        text: String,
        skillMentions: [String] = [],
        pluginMentions: [String] = []
    ) -> UserMessageSemanticKey {
        var normalizedText = normalizedMessageText(text)
        var skillSet = Set(skillMentions.map(normalizedUserMentionName).filter { !$0.isEmpty })
        var pluginSet = Set(pluginMentions.map(normalizedUserMentionName).filter { !$0.isEmpty })

        let extracted = extractInlineUserMentionTokens(from: normalizedText)
        normalizedText = extracted.text
        skillSet.formUnion(extracted.skillMentions)
        pluginSet.formUnion(extracted.pluginMentions)

        for skill in skillSet {
            normalizedText = removingBoundedUserMentionPhrase("$\(skill)", from: normalizedText)
            normalizedText = removingBoundedUserMentionPhrase("/\(skill)", from: normalizedText)
            normalizedText = removingBoundedUserMentionPhrase(displayNameForUserMention(skill), from: normalizedText)
        }
        for plugin in pluginSet {
            normalizedText = removingBoundedUserMentionPhrase("@\(plugin)", from: normalizedText)
        }

        return UserMessageSemanticKey(
            text: canonicalUserMessageBodyText(normalizedText),
            skillMentions: skillSet,
            pluginMentions: pluginSet
        )
    }

    private nonisolated static func extractInlineUserMentionTokens(
        from text: String
    ) -> (text: String, skillMentions: Set<String>, pluginMentions: Set<String>) {
        guard let regex = try? NSRegularExpression(
                pattern: #"(?<!\S)([$/@])([A-Za-z0-9][A-Za-z0-9._-]*)(?=[\s,.;:!?)\]}>]|$)"#
              ) else {
            return (text, [], [])
        }

        let nsText = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsText.length))
        var working = text
        var skills: Set<String> = []
        var plugins: Set<String> = []

        for match in matches.reversed() {
            guard match.numberOfRanges >= 3,
                  let triggerRange = Range(match.range(at: 1), in: text),
                  let nameRange = Range(match.range(at: 2), in: text),
                  let fullRange = Range(match.range, in: working) else {
                continue
            }

            let trigger = String(text[triggerRange])
            let name = normalizedUserMentionName(String(text[nameRange]))
            guard !name.isEmpty else { continue }

            if trigger == "$" || trigger == "/" {
                skills.insert(name)
            } else if trigger == "@" {
                plugins.insert(name)
            }
            working.replaceSubrange(fullRange, with: "")
        }

        return (working, skills, plugins)
    }

    private nonisolated static func removingBoundedUserMentionPhrase(_ phrase: String, from text: String) -> String {
        let normalizedPhrase = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPhrase.isEmpty,
              let regex = try? NSRegularExpression(
                pattern: #"(?<!\S)"# + NSRegularExpression.escapedPattern(for: normalizedPhrase) + #"(?=[\s,.;:!?)\]}>]|$)"#,
                options: [.caseInsensitive]
              ) else {
            return text
        }

        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: ""
        )
    }

    private nonisolated static func displayNameForUserMention(_ rawName: String) -> String {
        let parts = rawName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(omittingEmptySubsequences: true) { $0 == "-" || $0 == "_" }
            .map { part -> String in
                let token = String(part)
                return token.prefix(1).uppercased() + token.dropFirst().lowercased()
            }
        return parts.isEmpty ? rawName : parts.joined(separator: " ")
    }

    private nonisolated static func canonicalUserMessageBodyText(_ text: String) -> String {
        text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .lowercased()
    }
}
