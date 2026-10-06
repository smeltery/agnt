// FILE: StreamingMarkdownBlockSplitter.swift
// Purpose: Pure settled/active block splitting and seam-spacing classification for streaming markdown.
// Layer: Turn UI rendering support
// Exports: StreamingMarkdownBlockSplitter
// Depends on: CoreGraphics, Foundation

import CoreGraphics
import Foundation

// Pure text logic behind StreamingAssistantMarkdownTextView: where the stable
// settled prefix ends and where the still-streaming active block begins.
enum StreamingMarkdownBlockSplitter {
    static func split(_ text: String) -> (settled: String, active: String) {
        guard !text.isEmpty else { return ("", "") }

        let lines = text.components(separatedBy: "\n")
        var fence = StreamingMarkdownFence()
        var pendingBoundary = false
        var sawContent = false
        var lastBlockStartLine = 0

        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if fence.consume(line) {
                if pendingBoundary {
                    lastBlockStartLine = index
                    pendingBoundary = false
                }
                sawContent = true
                continue
            }

            // Keep document-dependent blocks together across blank lines.
            if requiresDocumentContext(line, trimmed: trimmed) {
                if pendingBoundary { lastBlockStartLine = index }
                break
            }

            if trimmed.isEmpty {
                if sawContent {
                    pendingBoundary = true
                }
            } else {
                if pendingBoundary {
                    lastBlockStartLine = index
                    pendingBoundary = false
                }
                sawContent = true
            }
        }

        guard lastBlockStartLine > 0 else { return ("", text) }

        let settled = lines[0..<lastBlockStartLine].joined(separator: "\n")
        let active = lines[lastBlockStartLine...].joined(separator: "\n")
        return (settled, active)
    }

    private static func requiresDocumentContext(_ line: String, trimmed: String) -> Bool {
        guard !trimmed.isEmpty else { return false }
        return classify(trimmed) == .list
            || trimmed.hasPrefix(">")
            || trimmed.hasPrefix("<")
            || trimmed.contains("[")
            || line.hasPrefix("    ")
            || line.hasPrefix("\t")
    }

    static func topSpacingMultiplier(forBlockStarting active: String) -> CGFloat {
        guard let line = firstNonBlankLine(of: active) else { return 0 }
        return classify(line).topMultiplier
    }

    static func bottomSpacingMultiplier(forLastBlockOf settled: String) -> CGFloat {
        let lastBlock = split(settled).active
        guard let line = firstNonBlankLine(of: lastBlock) else { return 0 }
        return classify(line).bottomMultiplier
    }

    private enum BlockKind {
        case paragraph, heading, code, table, thematicBreak, blockquote, list

        var topMultiplier: CGFloat {
            switch self {
            case .paragraph: return 0.8
            case .heading: return 1.6
            case .code: return 0.88
            case .table, .thematicBreak: return 1.6
            case .blockquote, .list: return 0.8
            }
        }

        var bottomMultiplier: CGFloat {
            switch self {
            case .paragraph, .code, .blockquote, .list: return 0
            case .heading: return 0.8
            case .table, .thematicBreak: return 1.6
            }
        }
    }

    private static func firstNonBlankLine(of text: String) -> String? {
        var lineStart = text.startIndex
        while lineStart < text.endIndex {
            let lineEnd = text[lineStart...].firstIndex(of: "\n") ?? text.endIndex
            let trimmed = text[lineStart..<lineEnd].trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return String(trimmed) }
            lineStart = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
        }
        return nil
    }

    private static func classify(_ trimmedLine: String) -> BlockKind {
        if trimmedLine.hasPrefix("#") { return .heading }
        if trimmedLine.hasPrefix("```") || trimmedLine.hasPrefix("~~~") { return .code }
        if trimmedLine.hasPrefix(">") { return .blockquote }
        if trimmedLine.hasPrefix("|") { return .table }
        if isThematicBreak(trimmedLine) { return .thematicBreak }
        if isListMarker(trimmedLine) { return .list }
        return .paragraph
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let stripped = line.filter { !$0.isWhitespace }
        guard stripped.count >= 3 else { return false }
        return stripped.allSatisfy { $0 == "-" }
            || stripped.allSatisfy { $0 == "*" }
            || stripped.allSatisfy { $0 == "_" }
    }

    private static func isListMarker(_ line: String) -> Bool {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") { return true }
        var sawDigit = false
        var index = line.startIndex
        while index < line.endIndex, line[index].isNumber {
            sawDigit = true
            index = line.index(after: index)
        }
        guard sawDigit, index < line.endIndex else { return false }
        let marker = line[index]
        guard marker == "." || marker == ")" else { return false }
        let afterMarker = line.index(after: index)
        return afterMarker < line.endIndex && line[afterMarker] == " "
    }
}
