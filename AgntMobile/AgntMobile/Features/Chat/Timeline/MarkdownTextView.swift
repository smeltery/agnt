// FILE: MarkdownTextView.swift
// Purpose: Cached markdown parsing and lightweight markdown text formatting for timeline rows.
// Layer: View Components
// Exports: MarkdownTextView, MarkdownTextFormatter, MarkdownParseCacheReset
// Depends on: SwiftUI, Textual, TurnMessageRegexCache, SkillReferenceFormatter, TurnMessageCaches

import Foundation
import SwiftUI
import Textual

/// Resets the in-memory AttributedString cache that backs `@agnt`MarkdownTextView`@agnt`.
/// Kept for explicit memory recovery without forcing cold parses on every thread switch.
@MainActor
enum MarkdownParseCacheReset {
    static func reset() { CachingMarkdownParser.reset() }
}

// Wraps the default Textual markdown parser with a bounded AttributedString
// cache so Foundation's markdown parser is not re-run when LazyVStack
// recycles a cell on upward scroll.
@MainActor
private struct CachingMarkdownParser: MarkupParser {
    static let shared = CachingMarkdownParser()
    private static let cache = BoundedCache<String, AttributedString>(maxEntries: 128)
    private let inner: AttributedStringMarkdownParser = .markdown()

    func attributedString(for input: String) throws -> AttributedString {
        let key = TurnTextCacheKey.stableKey(namespace: "markdown-parser", text: input)
        if let cached = Self.cache.get(key) {
            return cached
        }
        var result = try inner.attributedString(for: input)
        AppFont.monospaceCodeSpans(in: &result)
        Self.cache.set(key, value: result)
        return result
    }

    static func reset() {
        cache.removeAll()
    }
}

@MainActor
struct UncachedMarkdownParser: MarkupParser {
    static let shared = UncachedMarkdownParser()
    private let inner: AttributedStringMarkdownParser = .markdown()

    func attributedString(for input: String) throws -> AttributedString {
        var result = try inner.attributedString(for: input)
        AppFont.monospaceCodeSpans(in: &result)
        return result
    }
}

struct PreparsedMarkdown {
    let value: AttributedString
    let revision: String
}

@MainActor
private struct PreparsedMarkdownParser: MarkupParser {
    let value: AttributedString

    func attributedString(for input: String) throws -> AttributedString {
        var result = value
        AppFont.monospaceCodeSpans(in: &result)
        return result
    }
}

struct MarkdownTextView: View {
    let text: String?
    let preparsed: PreparsedMarkdown?
    let profile: MarkdownRenderProfile
    var enablesSelection: Bool = false
    var constrainsToAvailableWidth: Bool = false
    var usesCaches: Bool = true

    init(
        text: String,
        profile: MarkdownRenderProfile,
        enablesSelection: Bool = false,
        constrainsToAvailableWidth: Bool = false,
        usesCaches: Bool = true
    ) {
        self.text = text
        self.preparsed = nil
        self.profile = profile
        self.enablesSelection = enablesSelection
        self.constrainsToAvailableWidth = constrainsToAvailableWidth
        self.usesCaches = usesCaches
    }

    init(
        preparsed: PreparsedMarkdown,
        profile: MarkdownRenderProfile,
        enablesSelection: Bool = false,
        constrainsToAvailableWidth: Bool = false
    ) {
        self.text = nil
        self.preparsed = preparsed
        self.profile = profile
        self.enablesSelection = enablesSelection
        self.constrainsToAvailableWidth = constrainsToAvailableWidth
        self.usesCaches = false
    }

    var body: some View {
        let prepared = preparedMarkup()
        // Keep prose on the app font, but let Textual own markdown/code layout to avoid block sizing regressions.
        // Force code-block overflow to wrap instead of scroll so horizontal ScrollViews
        // inside the timeline do not compete with the sidebar swipe gesture or let
        // the chat feel like a pannable canvas.
        let baseView = StructuredText(prepared.markup, parser: prepared.parser)
            .font(AppFont.body())
            .textual.inlineStyle(.gitHub.code(.font(AppFont.mono(.body))))
            .textual.structuredTextStyle(.gitHub)
            .textual.overflowMode(.wrap)

        let renderedContent = Group {
            if enablesSelection {
                baseView
                    .textual.textSelection(.enabled)
            } else {
                baseView
            }
        }

        if constrainsToAvailableWidth {
            renderedContent
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .clipped()
        } else {
            renderedContent
        }
    }

    private func preparedMarkup() -> (markup: String, parser: any MarkupParser) {
        if let preparsed {
            return (
                preparsed.revision,
                PreparsedMarkdownParser(value: preparsed.value)
            )
        }

        let source = text ?? ""
        return (
            MarkdownTextFormatter.renderableText(
                from: source,
                profile: profile,
                usesCache: usesCaches
            ),
            usesCaches ? CachingMarkdownParser.shared : UncachedMarkdownParser.shared
        )
    }
}

enum MarkdownTextFormatter {
    // Applies lightweight markdown cleanup and turns file paths into link-styled labels.
    static func renderableText(
        from raw: String,
        profile: MarkdownRenderProfile,
        usesCache: Bool = true
    ) -> String {
        let build = {
            renderableTextUncached(from: raw, profile: profile)
        }

        if usesCache {
            return MarkdownRenderableTextCache.rendered(raw: raw, profile: profile, builder: build)
        }

        return build()
    }

    private static func renderableTextUncached(from raw: String, profile: MarkdownRenderProfile) -> String {
        let normalizedSkills = SkillReferenceFormatter.replacingSkillReferences(
            in: raw,
            style: .displayName
        )
        let headingNormalized = normalizeHeadingsOutsideFences(in: normalizedSkills)
        return linkifyFileReferenceLines(in: headingNormalized, profile: profile)
    }

    private static func normalizeHeadingsOutsideFences(in text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var isInsideFence = false

        return lines.map { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if isMarkdownFenceLine(trimmed) {
                isInsideFence.toggle()
                return line
            }
            guard !isInsideFence else {
                return line
            }
            return replaceMatches(
                in: line,
                regex: TurnMessageRegexCache.heading,
                template: "**$1**"
            )
        }.joined(separator: "\n")
    }

    private static func linkifyFileReferenceLines(in text: String, profile: MarkdownRenderProfile) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var isInsideFence = false

        let transformed = lines.map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if isMarkdownFenceLine(trimmed) {
                isInsideFence.toggle()
                return line
            }

            guard !isInsideFence else {
                return line
            }

            return linkifyInlineFileReferences(in: line, profile: profile)
        }

        return transformed.joined(separator: "\n")
    }

    private static func isMarkdownFenceLine(_ trimmedLine: String) -> Bool {
        trimmedLine.hasPrefix("`@agnt``")
            || trimmedLine.hasPrefix("```")
            || trimmedLine.hasPrefix("~~~")
    }

    private static func linkifyInlineFileReferences(in line: String, profile: MarkdownRenderProfile) -> String {
        switch profile {
        case .assistantProse, .fileChangeSystem:
            break
        case .userProse:
            return line
        }

        var transformedLine = line

        if let fileLinked = linkifyFileReferenceLine(transformedLine), fileLinked != transformedLine {
            transformedLine = fileLinked
        }

        transformedLine = linkifyInlineCodeFileReferences(in: transformedLine)
        return linkifyGenericPathTokens(in: transformedLine)
    }

    private static func linkifyFileReferenceLine(_ line: String) -> String? {
        guard let markerRange = line.range(of: "File:") else {
            return nil
        }

        let prefix = String(line[..<markerRange.lowerBound])
        let rawReference = line[markerRange.upperBound...]
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !rawReference.isEmpty,
              !rawReference.contains("]("),
              let parsed = parseFileReference(rawReference) else {
            return nil
        }

        return "\(prefix)File: [\(parsed.label)](\(escapeMarkdownLinkDestination(parsed.destination)))"
    }

    private static func linkifyGenericPathTokens(in line: String) -> String {
        guard let regex = TurnMessageRegexCache.genericPath else {
            return line
        }

        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        let matches = regex.matches(in: line, range: fullRange)
        guard !matches.isEmpty else {
            return line
        }

        let linkRanges = markdownLinkRanges(in: line)
        let inlineCodeRanges = inlineCodeRanges(in: line)
        let mutableLine = NSMutableString(string: line)
        for match in matches.reversed() {
            let matchRange = match.range
            guard !rangeOverlapsMarkdownLink(matchRange, linkRanges: linkRanges) else {
                continue
            }
            guard !rangeOverlapsMarkdownLink(matchRange, linkRanges: inlineCodeRanges) else {
                continue
            }
            guard isEligiblePathTokenRange(matchRange, in: nsLine) else {
                continue
            }

            let token = nsLine.substring(with: matchRange)
            guard let parsed = parseFileReference(token) else {
                continue
            }

            let replacement = "[\(parsed.label)](\(escapeMarkdownLinkDestination(parsed.destination)))"
            mutableLine.replaceCharacters(in: matchRange, with: replacement)
        }

        return String(mutableLine)
    }

    // Converts inline-code file refs (`/path/File.swift:42`) into compact markdown links.
    private static func linkifyInlineCodeFileReferences(in line: String) -> String {
        guard let regex = TurnMessageRegexCache.inlineCodeContent else {
            return line
        }

        let nsLine = line as NSString
        let fullRange = NSRange(location: 0, length: nsLine.length)
        let matches = regex.matches(in: line, range: fullRange)
        guard !matches.isEmpty else {
            return line
        }

        let linkRanges = markdownLinkRanges(in: line)
        let mutableLine = NSMutableString(string: line)
        for match in matches.reversed() {
            let fullMatchRange = match.range
            guard !rangeOverlapsMarkdownLink(fullMatchRange, linkRanges: linkRanges) else {
                continue
            }
            guard match.numberOfRanges > 1 else {
                continue
            }

            let tokenRange = match.range(at: 1)
            guard tokenRange.location != NSNotFound, tokenRange.length > 0 else {
                continue
            }

            let token = nsLine.substring(with: tokenRange)
            guard let parsed = parseFileReference(token) else {
                continue
            }

            let replacement = "[\(parsed.label)](\(escapeMarkdownLinkDestination(parsed.destination)))"
            mutableLine.replaceCharacters(in: fullMatchRange, with: replacement)
        }

        return String(mutableLine)
    }

    private static func markdownLinkRanges(in line: String) -> [NSRange] {
        TurnMessageRegexCache.markdownLinkRanges(in: line)
    }

    private static func inlineCodeRanges(in line: String) -> [NSRange] {
        TurnMessageRegexCache.inlineCodeRanges(in: line)
    }

    private static func isEligiblePathTokenRange(_ range: NSRange, in line: NSString) -> Bool {
        guard range.location != NSNotFound, range.length > 0 else {
            return false
        }

        let token = line.substring(with: range)
        if token.hasPrefix("//") {
            return false
        }

        let contextStart = max(0, range.location - 3)
        let contextLength = range.location - contextStart
        let leadingContext = contextLength > 0
            ? line.substring(with: NSRange(location: contextStart, length: contextLength))
            : ""
        if leadingContext.hasSuffix("://") {
            return false
        }

        let previousChar: String = range.location > 0
            ? line.substring(with: NSRange(location: range.location - 1, length: 1))
            : ""
        if token.hasPrefix("/"), isLikelyDomainCharacter(previousChar) {
            return false
        }

        return true
    }

    private static func rangeOverlapsMarkdownLink(_ range: NSRange, linkRanges: [NSRange]) -> Bool {
        TurnMessageRegexCache.rangeOverlaps(range, protectedRanges: linkRanges)
    }

    private static func escapeMarkdownLinkDestination(_ destination: String) -> String {
        destination
            .replacingOccurrences(of: " ", with: "%20")
            .replacingOccurrences(of: "(", with: "%28")
            .replacingOccurrences(of: ")", with: "%29")
    }

    private static func parseFileReference(_ rawReference: String) -> (label: String, destination: String)? {
        var candidate = rawReference
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "`"))

        while let last = candidate.last, ",.;)]}".contains(last) {
            candidate.removeLast()
        }

        if candidate.hasPrefix("(") {
            candidate.removeFirst()
        }

        guard candidate.hasPrefix("/") || candidate.contains("/") else {
            return nil
        }

        let fullRange = NSRange(location: 0, length: (candidate as NSString).length)

        var path = candidate
        var lineNumber: String?

        if let lineRegex = TurnMessageRegexCache.filenameWithLine,
           let match = lineRegex.firstMatch(in: candidate, range: fullRange),
           match.numberOfRanges >= 3 {
            let nsCandidate = candidate as NSString
            path = nsCandidate.substring(with: match.range(at: 1))
            lineNumber = nsCandidate.substring(with: match.range(at: 2))
        }

        let basename = (path as NSString).lastPathComponent
        guard !basename.isEmpty else {
            return nil
        }
        guard basename.contains(".") || lineNumber != nil else {
            return nil
        }

        let label: String
        let destination: String
        if let lineNumber {
            label = "\(basename) (line \(lineNumber))"
            destination = "\(path):\(lineNumber)"
        } else {
            label = basename
            destination = path
        }

        return (label, destination)
    }

    private static func replaceMatches(
        in text: String,
        regex: NSRegularExpression?,
        template: String
    ) -> String {
        TurnMessageRegexCache.replaceMatches(in: text, regex: regex, template: template)
    }

    private static func isLikelyDomainCharacter(_ value: String) -> Bool {
        guard value.count == 1, let scalar = value.unicodeScalars.first else {
            return false
        }
        if CharacterSet.alphanumerics.contains(scalar) {
            return true
        }
        return scalar == UnicodeScalar(".")
    }
}
