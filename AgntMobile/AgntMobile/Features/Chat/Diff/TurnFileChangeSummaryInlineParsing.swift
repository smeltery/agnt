// FILE: TurnFileChangeSummaryInlineParsing.swift
// Purpose: Parses inline file-change recap rows into normalized paths, totals, and actions.
// Layer: Parser
// Exports: TurnFileChangeSummaryParser inline parsing helpers
// Depends on: Foundation, TurnMessageRegexCache, TurnFileChangeSummaryParser models

import Foundation

extension TurnFileChangeSummaryParser {
    static func parsePathLine(_ line: String) -> String? {
        guard line.lowercased().hasPrefix("path:") else { return nil }
        let value = line.dropFirst("Path:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let normalized = normalizeInlinePath(value)
        guard looksLikePath(normalized) else { return nil }
        return normalized
    }

    static func parseKindLine(_ line: String) -> String? {
        guard line.lowercased().hasPrefix("kind:") else { return nil }
        let value = line.dropFirst("Kind:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static func parseTotalsLine(_ line: String) -> TurnDiffLineTotals? {
        guard line.lowercased().hasPrefix("totals:") else { return nil }
        let value = line.dropFirst("Totals:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        return parseInlineTotals(from: value)
    }

    static func parseInlineFileEntry(
        from line: String
    ) -> (path: String, inlineTotals: TurnDiffLineTotals?, action: TurnFileChangeAction?)? {
        var candidate = line
        if candidate.hasPrefix("- ") || candidate.hasPrefix("* ") {
            candidate = String(candidate.dropFirst(2))
        } else if candidate.hasPrefix("• ") {
            candidate = String(candidate.dropFirst(2))
        }

        candidate = candidate.replacingOccurrences(of: "`", with: "")
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let totals = parseInlineTotals(from: trimmed)
        let withoutTotals = stripInlineTotals(from: trimmed)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let actionEntry = parseInlineActionEntry(from: withoutTotals) {
            let normalizedPath = normalizeInlinePath(actionEntry.path)
            guard looksLikePath(normalizedPath) else {
                return nil
            }
            return (path: normalizedPath, inlineTotals: totals, action: actionEntry.action)
        }

        // Avoid false positives from generic file references (e.g. "File: ...").
        // Only accept path-only inline rows when explicit +/- totals are present.
        guard totals != nil else {
            return nil
        }

        let firstToken = withoutTotals
            .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? withoutTotals
        let normalizedPath = normalizeInlinePath(firstToken)

        guard looksLikePath(normalizedPath) else {
            return nil
        }

        return (path: normalizedPath, inlineTotals: totals, action: nil)
    }

    private static func parseInlineActionEntry(
        from line: String
    ) -> (action: TurnFileChangeAction, path: String)? {
        guard let regex = TurnMessageRegexCache.inlineAction else { return nil }

        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        guard let match = regex.firstMatch(in: line, range: fullRange),
              match.numberOfRanges == 3 else {
            return nil
        }

        let verb = nsLine.substring(with: match.range(at: 1))
        let path = nsLine.substring(with: match.range(at: 2))
        guard let action = TurnFileChangeAction.fromInlineVerb(verb) else {
            return nil
        }

        return (action: action, path: path)
    }

    private static func parseInlineTotals(from line: String) -> TurnDiffLineTotals? {
        // Accept ASCII and common Unicode plus/minus glyphs used by rich text renderers.
        guard let regex = TurnMessageRegexCache.inlineTotals else { return nil }
        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        guard let match = regex.firstMatch(in: line, range: fullRange),
              match.numberOfRanges == 3 else {
            return nil
        }

        let plusText = nsLine.substring(with: match.range(at: 1))
        let minusText = nsLine.substring(with: match.range(at: 2))
        guard let plus = Int(plusText), let minus = Int(minusText) else {
            return nil
        }

        return TurnDiffLineTotals(additions: plus, deletions: minus)
    }

    private static func stripInlineTotals(from line: String) -> String {
        guard let regex = TurnMessageRegexCache.trailingInlineTotals else {
            return line
        }
        let fullRange = NSRange(location: 0, length: (line as NSString).length)
        return regex.stringByReplacingMatches(in: line, range: fullRange, withTemplate: "")
    }

    private static func normalizeInlinePath(_ rawToken: String) -> String {
        var token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)

        token = token.replacingOccurrences(of: "\"", with: "")
        token = token.replacingOccurrences(of: "'", with: "")

        if let link = parseMarkdownLink(from: token) {
            let destination = normalizeLinkDestination(link.destination)
            if looksLikePath(destination) {
                token = destination
            } else {
                token = link.label
            }
        }

        if token.contains(" ") {
            token = token
                .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
                .first
                .map(String.init) ?? token
        }

        while let last = token.last, ",.;)".contains(last) {
            token.removeLast()
        }
        if token.hasPrefix("(") {
            token.removeFirst()
        }

        if let regex = TurnMessageRegexCache.trailingLineColumn {
            let fullRange = NSRange(location: 0, length: (token as NSString).length)
            token = regex.stringByReplacingMatches(in: token, range: fullRange, withTemplate: "")
        }

        return token
    }

    private static func looksLikePath(_ token: String) -> Bool {
        guard !token.isEmpty else { return false }

        if token.contains("/") || token.hasPrefix("./") || token.hasPrefix("../") {
            return true
        }

        guard let regex = TurnMessageRegexCache.fileLikeToken else {
            return false
        }
        let nsToken = token as NSString
        let range = NSRange(location: 0, length: nsToken.length)
        return regex.firstMatch(in: token, range: range) != nil
    }

    private static func parseMarkdownLink(from token: String) -> (label: String, destination: String)? {
        TurnMessageRegexCache.parseMarkdownLink(from: token)
    }

    private static func normalizeLinkDestination(_ destination: String) -> String {
        var normalized = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        if let queryIndex = normalized.firstIndex(of: "?") {
            normalized = String(normalized[..<queryIndex])
        }
        if let fragmentIndex = normalized.firstIndex(of: "#") {
            normalized = String(normalized[..<fragmentIndex])
        }

        if let url = URL(string: normalized) {
            if url.isFileURL {
                return url.path
            }
            if !url.path.isEmpty {
                return url.path
            }
        }

        return normalized
    }
}
