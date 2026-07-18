// FILE: TurnViewModel+AutocompleteTokens.swift
// Purpose: Parses and rewrites composer autocomplete mention tokens.
// Layer: View Model Extension
// Exports: TurnViewModel autocomplete token helpers, TurnTrailing*AutocompleteToken
// Depends on: Foundation, TurnComposerCommandLogic, TurnFileMentionHeuristics, TurnViewModel+FileMentionAliases

import Foundation

extension TurnViewModel {
    // Extracts only a final `@query` token at the end of composer text.
    static func trailingFileAutocompleteToken(in text: String) -> TurnTrailingFileAutocompleteToken? {
        guard let token = trailingFileToken(in: text) else {
            return nil
        }

        return TurnTrailingFileAutocompleteToken(
            query: token.query,
            tokenRange: token.tokenRange
        )
    }

    // Extracts only a final `$query` or `/query` token at the end of composer text.
    static func trailingSkillAutocompleteToken(in text: String) -> TurnTrailingSkillAutocompleteToken? {
        guard let token = trailingToken(in: text, triggers: ["$", "/"], allowsEmptyQuery: true) else {
            return nil
        }

        // Reject pure-numeric queries like `$100`, `/42` because they are not skill names.
        guard token.query.isEmpty || token.query.contains(where: { $0.isLetter }) else {
            return nil
        }

        return TurnTrailingSkillAutocompleteToken(
            query: token.query,
            trigger: token.trigger,
            tokenRange: token.tokenRange
        )
    }

    // Plugin discovery opens on bare `@`; selecting a suggestion stores the structured mention.
    static func trailingPluginAutocompleteToken(in text: String) -> TurnTrailingPluginAutocompleteToken? {
        guard !text.isEmpty else {
            return nil
        }

        let tokenStart: String.Index
        if let lastWhitespaceIndex = text.lastIndex(where: { $0.isWhitespace }) {
            tokenStart = text.index(after: lastWhitespaceIndex)
        } else {
            tokenStart = text.startIndex
        }

        guard tokenStart < text.endIndex else {
            return nil
        }

        let token = text[tokenStart..<text.endIndex]
        guard token.first == "@" else {
            return nil
        }

        let lastAtIndex = token.lastIndex(of: "@") ?? token.startIndex
        let triggerIndex = lastAtIndex
        let mentionToken = text[triggerIndex..<text.endIndex]
        guard mentionToken.dropFirst().allSatisfy({ !$0.isWhitespace && $0 != "@" && $0 != "(" && $0 != ")" }) else {
            return nil
        }

        let queryStart = text.index(after: triggerIndex)
        let query = String(text[queryStart..<text.endIndex])
        guard !query.contains(where: { $0.isWhitespace }) else {
            return nil
        }

        return TurnTrailingPluginAutocompleteToken(
            query: query,
            tokenRange: triggerIndex..<text.endIndex
        )
    }

    // Extracts only a final `/query` token so slash commands open from the same composer input.
    static func trailingSlashCommandToken(in text: String) -> TurnTrailingSlashCommandToken? {
        TurnComposerCommandLogic.trailingSlashCommandToken(in: text)
    }

    static func replacingTrailingSlashCommandToken(in text: String, with replacement: String) -> String? {
        TurnComposerCommandLogic.replacingTrailingSlashCommandToken(in: text, with: replacement)
    }

    static func replacingTrailingFileAutocompleteToken(in text: String, with selectedPath: String) -> String? {
        let trimmedPath = selectedPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty,
              let token = trailingFileAutocompleteToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "@\(trimmedPath) ")
        return updated
    }

    // Resolves file mentions from either the exact path or normalized alias forms.
    static func replacingFileMentionAliases(
        in text: String,
        with mention: TurnComposerMentionedFile,
        allowFileNameAliases: Bool = true
    ) -> String {
        let replacement = "@\(mention.path)"
        let placeholder = "__codex_file_mention__\(mention.path.hashValue)__"
        let replacedText = fileMentionAliases(
            fileName: mention.fileName,
            path: mention.path,
            allowFileNameAliases: allowFileNameAliases
        )
            .reduce(text) { partialText, alias in
                // Replace into a placeholder first so shorter aliases cannot re-match inside the canonical path.
                replaceBoundedToken(
                    "@\(alias)",
                    with: placeholder,
                    in: partialText,
                    caseInsensitive: true
                )
            }
        return replacedText.replacingOccurrences(of: placeholder, with: replacement)
    }

    // Removes any alias form for a selected file mention so chip deletion stays in sync with text.
    static func removingFileMentionAliases(
        for mention: TurnComposerMentionedFile,
        from text: String,
        allowFileNameAliases: Bool = true
    ) -> String {
        fileMentionAliases(
            fileName: mention.fileName,
            path: mention.path,
            allowFileNameAliases: allowFileNameAliases
        )
            .reduce(text) { partialText, alias in
                removeBoundedToken(
                    "@\(alias)",
                    from: partialText,
                    caseInsensitive: true
                )
            }
    }

    // Detects when the last `@mention` already matches a confirmed chip and the user is now typing prose after it.
    static func hasClosedConfirmedFileMentionPrefix(
        in text: String,
        confirmedMentions: [TurnComposerMentionedFile]
    ) -> Bool {
        guard !confirmedMentions.isEmpty,
              let triggerIndex = text.lastIndex(of: "@") else {
            return false
        }

        if triggerIndex > text.startIndex {
            let previousCharacter = text[text.index(before: triggerIndex)]
            guard previousCharacter.isWhitespace else {
                return false
            }
        }

        let tail = String(text[text.index(after: triggerIndex)...])
        guard !tail.isEmpty else {
            return false
        }

        let ambiguousKeys = ambiguousFileNameAliasKeys(in: confirmedMentions)
        for mention in confirmedMentions {
            let collisionKey = fileNameAliasCollisionKey(for: mention.fileName)
            let allowFileNameAliases = collisionKey.map { !ambiguousKeys.contains($0) } ?? true
            let aliases = fileMentionAliases(
                fileName: mention.fileName,
                path: mention.path,
                allowFileNameAliases: allowFileNameAliases
            )

            for alias in aliases {
                guard let range = tail.range(
                    of: alias,
                    options: [.anchored, .caseInsensitive]
                ) else {
                    continue
                }

                guard range.upperBound < tail.endIndex,
                      tail[range.upperBound].isWhitespace else {
                    continue
                }

                return true
            }
        }

        return false
    }

    static func replacingTrailingSkillAutocompleteToken(in text: String, with selectedSkill: String) -> String? {
        let trimmedSkill = selectedSkill.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSkill.isEmpty,
              let token = trailingSkillAutocompleteToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "\(token.trigger)\(trimmedSkill) ")
        return updated
    }

    static func replacingTrailingPluginAutocompleteToken(in text: String, with selectedPlugin: String) -> String? {
        let trimmedPlugin = selectedPlugin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPlugin.isEmpty,
              let token = trailingPluginAutocompleteToken(in: text) else {
            return nil
        }

        var updated = text
        updated.replaceSubrange(token.tokenRange, with: "@\(trimmedPlugin) ")
        return updated
    }

    static func removingTrailingSlashCommandToken(in text: String) -> String? {
        TurnComposerCommandLogic.removingTrailingSlashCommandToken(in: text)
    }

    // Keeps file autocomplete scoped to the final adjacent `@token`; prose after a space closes it.
    private static func trailingFileToken(in text: String) -> TurnTrailingToken? {
        guard !text.isEmpty else {
            return nil
        }

        let tokenStart: String.Index
        if let lastWhitespaceIndex = text.lastIndex(where: { $0.isWhitespace }) {
            tokenStart = text.index(after: lastWhitespaceIndex)
        } else {
            tokenStart = text.startIndex
        }

        guard tokenStart < text.endIndex,
              text[tokenStart] == "@" else {
            return nil
        }

        if tokenStart > text.startIndex {
            let previousCharacter = text[text.index(before: tokenStart)]
            guard previousCharacter.isWhitespace else {
                return nil
            }
        }

        let queryStart = text.index(after: tokenStart)
        let query = String(text[queryStart..<text.endIndex])
        guard !query.isEmpty,
              !query.contains(where: { $0.isWhitespace || $0 == "@" }) else {
            return nil
        }

        let isBareLowercaseSearch = query.first?.isLowercase == true && !query.contains(":")
        guard isBareLowercaseSearch || isAllowedFileAutocompleteQuery(query) else {
            return nil
        }

        if let lastCharacter = query.last,
           ",.;:!?)]}".contains(lastCharacter),
           !TurnFileMentionHeuristics.isAllowedInlineMentionToken(query) {
            return nil
        }

        return TurnTrailingToken(query: query, trigger: "@", tokenRange: tokenStart..<text.endIndex)
    }

    // Allows flexible file aliases while keeping common Swift attributes out of file search.
    private static func isAllowedFileAutocompleteQuery(_ query: String) -> Bool {
        TurnFileMentionHeuristics.isAllowedAutocompleteQuery(query)
    }

    // Shared parser for final-token autocomplete triggers (`@`, `$`, `/`).
    private static func trailingToken(
        in text: String,
        triggers: Set<Character>,
        allowsEmptyQuery: Bool = false
    ) -> TurnTrailingToken? {
        guard !text.isEmpty else {
            return nil
        }

        let tokenStart: String.Index
        if let lastWhitespaceIndex = text.lastIndex(where: { $0.isWhitespace }) {
            tokenStart = text.index(after: lastWhitespaceIndex)
        } else {
            tokenStart = text.startIndex
        }

        guard tokenStart < text.endIndex else {
            return nil
        }

        let trigger = text[tokenStart]
        guard triggers.contains(trigger) else {
            return nil
        }

        let queryStart = text.index(after: tokenStart)
        let query = String(text[queryStart..<text.endIndex])
        guard !query.contains(where: { $0.isWhitespace }),
              (allowsEmptyQuery || !query.isEmpty) else {
            return nil
        }

        return TurnTrailingToken(query: query, trigger: trigger, tokenRange: tokenStart..<text.endIndex)
    }

}

struct TurnTrailingFileAutocompleteToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

struct TurnTrailingSkillAutocompleteToken: Equatable {
    let query: String
    let trigger: Character
    let tokenRange: Range<String.Index>
}

struct TurnTrailingPluginAutocompleteToken: Equatable {
    let query: String
    let tokenRange: Range<String.Index>
}

private struct TurnTrailingToken: Equatable {
    let query: String
    let trigger: Character
    let tokenRange: Range<String.Index>
}
