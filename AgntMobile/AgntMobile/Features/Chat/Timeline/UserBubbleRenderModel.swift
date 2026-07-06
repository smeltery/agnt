// FILE: UserBubbleRenderModel.swift
// Purpose: Computes the rendered text + mention chips for user message bubbles, with caching.
// Layer: View Support
// Exports: UserBubbleRenderModel, UserBubbleRenderModelCache
// Depends on: Foundation, CodexMessage, TurnMentionChipRef, TurnMessageRegexCache, TurnTextCacheKey, SkillReferenceFormatter

import Foundation

struct UserBubbleRenderModel: Equatable {
    let text: String
    let textFingerprint: String
    let chips: [TurnMentionChipRef]
    let usesBlockMarkdown: Bool
}

enum UserBubbleRenderModelCache {
    private static let cache = BoundedCache<String, UserBubbleRenderModel>(maxEntries: 512)

    static func model(for message: CodexMessage, text: String) -> UserBubbleRenderModel {
        let displayFingerprint = TurnTextCacheKey.stableFingerprint(for: text)
        let fileMentionsKey = message.fileMentions
            .map { TurnTextCacheKey.stableFingerprint(for: $0) }
            .joined(separator: ",")
        let skillMentionsKey = message.skillMentions
            .map { TurnTextCacheKey.stableFingerprint(for: $0) }
            .joined(separator: ",")
        let pluginMentionsKey = message.pluginMentions
            .map { TurnTextCacheKey.stableFingerprint(for: $0) }
            .joined(separator: ",")
        // Local has no `textRenderSignature` field, so substitute the body-text fingerprint
        // for the signature contribution. This keeps cache invalidation tied to actual text drift.
        let key = [
            message.id,
            displayFingerprint,
            fileMentionsKey,
            skillMentionsKey,
            pluginMentionsKey,
        ].joined(separator: "|")

        return cache.getOrSet(key) {
            UserBubbleMentionExtractor.renderModel(
                text: text,
                displayFingerprint: displayFingerprint,
                fileMentions: message.fileMentions,
                skillMentions: message.skillMentions,
                pluginMentions: message.pluginMentions
            )
        }
    }

    static func reset() {
        cache.removeAll()
    }
}

enum UserBubbleMentionExtractor {
    private struct Replacement {
        let range: NSRange
        let text: String
    }

    private static let repeatedHorizontalWhitespace = try? NSRegularExpression(pattern: #"[ \t]{2,}"#)
    private static let slashCommandRegex: NSRegularExpression? = {
        let tokens = TurnComposerSlashCommand.allCommands
            .map(\.commandToken)
            .map(NSRegularExpression.escapedPattern(for:))
            .joined(separator: "|")
        guard !tokens.isEmpty else { return nil }
        return try? NSRegularExpression(
            pattern: "(?<!\\S)(\(tokens))(?=[\\s,.;:!?\\)\\]\\}>]|$)"
        )
    }()

    static func renderModel(
        text rawText: String,
        displayFingerprint: String,
        fileMentions: [String],
        skillMentions: [String] = [],
        pluginMentions: [String] = []
    ) -> UserBubbleRenderModel {
        var chips: [TurnMentionChipRef] = []
        var seenChipIDs: Set<String> = []
        let confirmedFileMentions = normalizedConfirmedFileMentions(fileMentions)

        for mention in fileMentions {
            let trimmed = mention.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            appendChip(.file(trimmed), to: &chips, seenChipIDs: &seenChipIDs)
        }

        for mention in skillMentions {
            let trimmed = mention.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            appendChip(.skill(trimmed), to: &chips, seenChipIDs: &seenChipIDs)
        }

        for mention in pluginMentions {
            let trimmed = mention.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            appendChip(.plugin(trimmed), to: &chips, seenChipIDs: &seenChipIDs)
        }

        let normalizedText = SkillReferenceFormatter.replacingSkillReferences(
            in: rawText,
            style: .mentionToken
        )
        var replacements: [Replacement] = []
        collectSlashCommandReplacements(
            in: normalizedText,
            replacements: &replacements,
            chips: &chips,
            seenChipIDs: &seenChipIDs
        )

        if normalizedText.contains("@") || normalizedText.contains("$"),
           let mentionRegex = TurnMessageRegexCache.userMentionToken {
            let nsText = normalizedText as NSString
            let matches = mentionRegex.matches(
                in: normalizedText,
                range: NSRange(location: 0, length: nsText.length)
            )

            for match in matches {
                guard let parsed = parsedMention(match: match, in: nsText) else {
                    continue
                }

                switch parsed.trigger {
                case "@":
                    let normalizedFileToken = TurnMessageRegexCache.removingTrailingLineColumnSuffix(from: parsed.token)
                    if confirmedFileMentions.contains(normalizedFileToken) {
                        replacements.append(Replacement(range: match.range, text: parsed.trailingPunctuation))
                    } else if isLikelyPluginMention(parsed.token) {
                        appendChip(.plugin(parsed.token), to: &chips, seenChipIDs: &seenChipIDs)
                        replacements.append(Replacement(range: match.range, text: parsed.trailingPunctuation))
                    }
                case "$":
                    guard isLikelySkillMention(parsed.token) else { continue }
                    appendChip(.skill(parsed.token), to: &chips, seenChipIDs: &seenChipIDs)
                    replacements.append(Replacement(range: match.range, text: parsed.trailingPunctuation))
                default:
                    continue
                }
            }
        }

        let displayText = cleanedText(
            replacing: replacements,
            in: normalizedText
        )
        return UserBubbleRenderModel(
            text: displayText,
            textFingerprint: TurnTextCacheKey.stableFingerprint(for: displayText),
            chips: chips,
            usesBlockMarkdown: UserBubbleBlockMarkdownDetector.containsBlockMarkdown(displayText)
        )
    }

    private static func collectSlashCommandReplacements(
        in text: String,
        replacements: inout [Replacement],
        chips: inout [TurnMentionChipRef],
        seenChipIDs: inout Set<String>
    ) {
        guard let slashCommandRegex else { return }

        let nsText = text as NSString
        let matches = slashCommandRegex.matches(
            in: text,
            range: NSRange(location: 0, length: nsText.length)
        )
        guard !matches.isEmpty else { return }

        for match in matches {
            let token = nsText.substring(with: match.range)
            guard let command = TurnComposerSlashCommand.allCommands.first(where: { $0.commandToken == token }) else {
                continue
            }

            appendChip(.slashCommand(command), to: &chips, seenChipIDs: &seenChipIDs)
            replacements.append(Replacement(range: match.range, text: ""))
        }
    }

    private static func normalizedConfirmedFileMentions(_ mentions: [String]) -> Set<String> {
        Set(
            mentions
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .map(TurnMessageRegexCache.removingTrailingLineColumnSuffix)
                .filter { !$0.isEmpty }
        )
    }

    private static func appendChip(
        _ chip: TurnMentionChipRef,
        to chips: inout [TurnMentionChipRef],
        seenChipIDs: inout Set<String>
    ) {
        guard seenChipIDs.insert(chip.id).inserted else { return }
        chips.append(chip)
    }

    private static func parsedMention(
        match: NSTextCheckingResult,
        in nsText: NSString
    ) -> (trigger: String, token: String, trailingPunctuation: String)? {
        let triggerRange = match.range(at: 1)
        let tokenRange = match.range(at: 2)
        guard triggerRange.location != NSNotFound,
              tokenRange.location != NSNotFound else {
            return nil
        }

        let trigger = nsText.substring(with: triggerRange)
        let rawToken = nsText.substring(with: tokenRange)
        let normalized = normalizedMentionToken(rawToken)
        guard !normalized.token.isEmpty else {
            return nil
        }

        return (trigger, normalized.token, normalized.trailingPunctuation)
    }

    private static func normalizedMentionToken(_ token: String) -> (token: String, trailingPunctuation: String) {
        let punctuationSet = CharacterSet(charactersIn: ".,;:!?)]}")
        let scalars = Array(token.unicodeScalars)

        var splitIndex = scalars.count
        while splitIndex > 0, punctuationSet.contains(scalars[splitIndex - 1]) {
            splitIndex -= 1
        }

        let pathScalars = scalars.prefix(splitIndex)
        let trailingScalars = scalars.suffix(scalars.count - splitIndex)
        let path = String(String.UnicodeScalarView(pathScalars))
        let trailing = String(String.UnicodeScalarView(trailingScalars))
        return (path, trailing)
    }

    private static func cleanedText(replacing replacements: [Replacement], in text: String) -> String {
        guard !replacements.isEmpty else {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let mutableText = NSMutableString(string: text)
        for replacement in replacements.sorted(by: { $0.range.location > $1.range.location }) {
            mutableText.replaceCharacters(in: replacement.range, with: replacement.text)
        }

        let collapsed = TurnMessageRegexCache.replaceMatches(
            in: String(mutableText),
            regex: repeatedHorizontalWhitespace,
            template: " "
        )
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Keeps plugin chips to app-style slugs so Swift attributes and scoped build labels stay plain.
    private static func isLikelyPluginMention(_ token: String) -> Bool {
        let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = normalized.first,
              first.isLowercase || first.isNumber else {
            return false
        }

        return normalized.allSatisfy { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }

    private static func isLikelySkillMention(_ token: String) -> Bool {
        let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.contains(where: \.isLetter) else {
            return false
        }

        return normalized.allSatisfy { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }
}
