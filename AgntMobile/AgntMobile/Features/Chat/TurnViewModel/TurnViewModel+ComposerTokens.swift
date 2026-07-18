// FILE: TurnViewModel+ComposerTokens.swift
// Purpose: Bounded composer token replacement helpers.
// Layer: View Model

import Foundation

extension TurnViewModel {
    static func turnComposerReviewTarget(
        for target: CodexPendingCodeReviewTarget
    ) -> TurnComposerReviewTarget {
        switch target {
        case .uncommittedChanges:
            return .uncommittedChanges
        case .baseBranch:
            return .baseBranch
        }
    }
    // Prefixes the composer draft with the canned delegation prompt when the chip is armed.
    static func applyingSubagentsSelection(to text: String, isSelected: Bool) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSelected,
              let cannedPrompt = TurnComposerSlashCommand.subagents.cannedPrompt else {
            return trimmed
        }

        guard !trimmed.isEmpty else {
            return cannedPrompt
        }

        return "\(cannedPrompt)\n\n\(trimmed)"
    }
    /// Removes the first occurrence of `token` that sits at a word boundary
    /// (followed by whitespace, punctuation, or end-of-string). Consumes one trailing space when present.
    static func removeBoundedToken(
        _ token: String,
        from text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?:[\\s,.;:!?)\\]}>]|$)",
            options: options
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

    /// Replaces all boundary-safe occurrences of `token` with `replacement`.
    /// Boundary = followed by whitespace, punctuation, or end-of-string.
    static func replaceBoundedToken(
        _ token: String,
        with replacement: String,
        in text: String,
        caseInsensitive: Bool = false
    ) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: token)
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(
            pattern: escaped + "(?=[\\s,.;:!?)\\]}>]|$)",
            options: options
        ) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        let safeReplacement = NSRegularExpression.escapedTemplate(for: replacement)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: safeReplacement)
    }
}
