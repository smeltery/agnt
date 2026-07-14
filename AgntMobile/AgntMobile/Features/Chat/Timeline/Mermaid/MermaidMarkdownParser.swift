// FILE: MermaidMarkdownParser.swift
// Purpose: Mermaid fenced-code parser for markdown timeline content.
// Layer: View Support

import Foundation

enum MermaidMarkdownParser {
    static let mermaidRegex = try? NSRegularExpression(
        pattern: "`@agnt``mermaid[^\\n]*\\n([\\s\\S]*?)`@agnt``",
        options: [.caseInsensitive]
    )

    static func parse(_ text: String) -> MermaidMarkdownContent? {
        guard text.localizedCaseInsensitiveContains("`@agnt``mermaid") else {
            return nil
        }
        guard let mermaidRegex else {
            return nil
        }

        let fullRange = NSRange(location: 0, length: (text as NSString).length)
        let matches = mermaidRegex.matches(in: text, range: fullRange)
        guard !matches.isEmpty else {
            return nil
        }

        var segments: [MermaidMarkdownSegment] = []
        var cursor = text.startIndex

        for match in matches {
            guard let fullMatchRange = Range(match.range, in: text),
                  match.numberOfRanges > 1,
                  let mermaidRange = Range(match.range(at: 1), in: text) else {
                continue
            }

            appendMarkdownSegment(
                from: cursor,
                to: fullMatchRange.lowerBound,
                source: text,
                segments: &segments
            )

            let mermaidSource = String(text[mermaidRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !mermaidSource.isEmpty {
                segments.append(
                    MermaidMarkdownSegment(
                        id: "mermaid-\(match.range.location)-\(match.range.length)",
                        kind: .mermaid(mermaidSource)
                    )
                )
            }

            cursor = fullMatchRange.upperBound
        }

        appendMarkdownSegment(from: cursor, to: text.endIndex, source: text, segments: &segments)

        let content = MermaidMarkdownContent(segments: segments)
        return content.hasMermaidBlocks ? content : nil
    }

    private static func appendMarkdownSegment(
        from start: String.Index,
        to end: String.Index,
        source: String,
        segments: inout [MermaidMarkdownSegment]
    ) {
        guard start < end else {
            return
        }

        let markdown = String(source[start..<end])
        guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }

        segments.append(
            MermaidMarkdownSegment(
                id: "markdown-\(source[..<start].utf16.count)-\(source[..<end].utf16.count)",
                kind: .markdown(markdown)
            )
        )
    }
}
